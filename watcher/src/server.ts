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
import { plotText, plotterEnvFromProcess } from './plotter/plot'

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

  const plotterEnv = plotterEnvFromProcess(process.env)
  let plotting = false

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/kiosk')) {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.writeHead(200)
      res.end(kioskPage(state.queue.pending.length, plotterEnv.tcpTarget))
      return
    }

    res.setHeader('content-type', 'application/json')

    if (req.method === 'GET' && req.url === '/dispense-queue') {
      res.writeHead(200)
      res.end(JSON.stringify({ pending: state.queue.pending.length }))
      return
    }

    if (req.method === 'POST' && req.url === '/plot') {
      if (plotting) {
        res.writeHead(409)
        res.end(JSON.stringify({ ok: false, error: 'a plot is already running — one pen, one job at a time' }))
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        let text: string
        try {
          text = String(JSON.parse(body)?.text ?? '')
        } catch {
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, error: 'bad JSON' }))
          return
        }
        if (state.queue.pending.length === 0) {
          res.writeHead(402)
          res.end(JSON.stringify({ ok: false, error: 'no paid credit in the queue — pay first' }))
          return
        }
        plotting = true
        try {
          // Plot FIRST, consume the credit only after the machine (or the
          // dry-run file) actually accepted the whole program — the same
          // fail-safe ordering as the ESP32 dispenser: a crash mid-plot
          // costs the house a retry, never the customer a paid card.
          const outcome = await plotText(text, plotterEnv)
          if (!outcome.ok) {
            res.writeHead(422)
            res.end(JSON.stringify(outcome))
            return
          }
          const { state: nextQueue, item } = dequeue(state.queue)
          state = { ...state, queue: nextQueue }
          saveState(state)
          console.log(`[plot] "${text.slice(0, 30)}" → ${outcome.mode} (${outcome.detail}) — paid by ${item?.txHash}`)
          res.writeHead(200)
          res.end(JSON.stringify({ ...outcome, paidBy: item?.txHash, remaining: nextQueue.pending.length }))
        } catch (err) {
          res.writeHead(502)
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        } finally {
          plotting = false
        }
      })
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
    console.log(`[plotter] ${plotterEnv.tcpTarget ? `machine at ${plotterEnv.tcpTarget}` : `dry-run → ${plotterEnv.dryRunDir}/`}`)
  })
}

/** The booth's local operator page: queue status + a phrase box. Plain HTML,
 *  no build step — it runs on the booth laptop, not the public internet. */
function kioskPage(pending: number, tcpTarget: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>onchain vending — kiosk</title>
<style>
  body { font-family: sans-serif; max-width: 480px; margin: 3rem auto; padding: 0 1rem; }
  .badge { font-size: 2.5rem; font-weight: bold; }
  textarea { width: 100%; font-size: 1.2rem; padding: .5rem; box-sizing: border-box; }
  button { font-size: 1.2rem; padding: .5rem 1.5rem; margin-top: .5rem; }
  #result { margin-top: 1rem; white-space: pre-wrap; font-family: monospace; }
</style></head><body>
<h1>결제 대기: <span class="badge" id="pending">${pending}</span></h1>
<p>${tcpTarget ? `기계 연결: ${tcpTarget}` : '드라이런 모드 (기계 미연결 — G-code 파일로 저장)'}</p>
<textarea id="text" rows="3" maxlength="80" placeholder="쓸 문구를 입력하세요 (최대 80자)"></textarea>
<button onclick="plot()">캘리그라피 시작</button>
<div id="result"></div>
<script>
  async function refresh() {
    const r = await fetch('/dispense-queue').then(r => r.json())
    document.getElementById('pending').textContent = r.pending
  }
  setInterval(refresh, 3000)
  async function plot() {
    const text = document.getElementById('text').value
    const el = document.getElementById('result')
    el.textContent = '...'
    const r = await fetch('/plot', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ text }) })
    el.textContent = JSON.stringify(await r.json(), null, 2)
    refresh()
  }
</script></body></html>`
}
