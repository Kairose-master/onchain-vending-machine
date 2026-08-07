/**
 * Ties it together: poll the chain on an interval, feed new payments into
 * the queue, persist to disk, and serve the two endpoints the ESP32 calls.
 *
 * Deliberately plain `http` — no framework — this is a two-route toy and a
 * dependency is not worth it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { config } from './config'
import { makeClient, scanTransfers } from './chain-watch'
import { createQueue, enqueueIfNew, dequeue, type QueueState } from './queue'

type Persisted = { queue: QueueState; lastScannedBlock: string }

function loadState(): Persisted {
  if (!existsSync(config.stateFile)) return { queue: createQueue(), lastScannedBlock: '0' }
  try {
    return JSON.parse(readFileSync(config.stateFile, 'utf8'))
  } catch {
    console.error(`[state] ${config.stateFile} is unreadable — starting from an empty queue`)
    return { queue: createQueue(), lastScannedBlock: '0' }
  }
}

function saveState(state: Persisted) {
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2))
}

export async function main() {
  const client = makeClient()
  let state = loadState()

  async function poll() {
    try {
      const latest = await client.getBlockNumber()
      const cursor = BigInt(state.lastScannedBlock)
      const from = cursor > BigInt(config.scanWindowBlocks) ? cursor - BigInt(config.scanWindowBlocks) : 0n
      const payments = await scanTransfers(client, from, latest)
      let queue = state.queue
      for (const p of payments) queue = enqueueIfNew(queue, p, config.priceBaseUnits)
      state = { queue, lastScannedBlock: latest.toString() }
      saveState(state)
      if (payments.length > 0) {
        console.log(`[poll] block ${from}-${latest}: ${payments.length} transfer(s) seen, ${queue.pending.length} pending dispense`)
      }
    } catch (err) {
      // A dropped RPC call must never crash the watcher — the ESP32 keeps
      // polling a stale-but-safe queue until the next tick succeeds.
      console.error('[poll] failed, will retry next tick:', err instanceof Error ? err.message : err)
    }
  }

  await poll()
  setInterval(poll, config.pollIntervalMs)

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('content-type', 'application/json')

    if (req.method === 'GET' && req.url === '/dispense-queue') {
      res.writeHead(200)
      res.end(JSON.stringify({ pending: state.queue.pending.length }))
      return
    }

    if (req.method === 'POST' && req.url === '/dispense-queue/ack') {
      const { state: nextQueue, item } = dequeue(state.queue)
      if (!item) {
        res.writeHead(409)
        res.end(JSON.stringify({ ok: false, error: 'queue is empty' }))
        return
      }
      state = { ...state, queue: nextQueue }
      saveState(state)
      console.log(`[dispense] acked ${item.txHash} from ${item.from} — ${nextQueue.pending.length} remaining`)
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, dispensedTxHash: item.txHash, remaining: nextQueue.pending.length }))
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: 'not found' }))
  })

  server.listen(config.port, () => {
    console.log(`[watcher] listening on :${config.port}, watching ${config.vendingWallet} for >= ${config.priceBaseUnits} USDC base units`)
  })
}
