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
import { plot, plotInputToStrokes, plotterEnvFromProcess, type PlotInput } from './plotter/plot'
import { polylinesToGcode } from './plotter/gcode'
import { gcodeToSvg } from './plotter/svg-preview'

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
      // Window is anchored to LATEST, never to the stored cursor: the first
      // run (cursor 0) or a long-offline gap would otherwise ask the RPC for
      // millions of blocks — the public Base Sepolia endpoint rejects
      // anything over 2000 (verified live). The flip side is stated, not
      // hidden: a payment older than the window that arrived while the
      // watcher was DOWN is missed. For a booth, the watcher runs while the
      // booth does, so the window only needs to cover a restart.
      const window = BigInt(Math.min(config.scanWindowBlocks, 1999))
      const from = latest > window ? latest - window : 0n
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
      res.end(kioskPage(state.queue.pending.length, plotterEnv.serialTarget || plotterEnv.tcpTarget))
      return
    }

    res.setHeader('content-type', 'application/json')

    if (req.method === 'GET' && req.url === '/dispense-queue') {
      res.writeHead(200)
      res.end(JSON.stringify({ pending: state.queue.pending.length }))
      return
    }

    if (req.method === 'POST' && req.url === '/preview') {
      // Free and creditless: rendering "what would the pen draw" must never
      // gate on payment, or the customer can't decide before paying.
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        try {
          const input = JSON.parse(body) as PlotInput
          const strokes = await plotInputToStrokes(input, plotterEnv)
          if ('error' in strokes) {
            res.writeHead(422)
            res.end(JSON.stringify({ ok: false, error: strokes.error }))
            return
          }
          const result = polylinesToGcode(strokes, plotterEnv.gcode)
          res.writeHead(200)
          res.end(JSON.stringify({ ok: true, svg: gcodeToSvg(result.lines, plotterEnv.gcode), stats: result.stats }))
        } catch (err) {
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'bad request' }))
        }
      })
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
        let input: PlotInput
        try {
          const parsed = JSON.parse(body) as PlotInput
          input = { text: parsed.text, imageBase64: parsed.imageBase64, threshold: parsed.threshold }
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
          const outcome = await plot(input, plotterEnv)
          if (!outcome.ok) {
            res.writeHead(422)
            res.end(JSON.stringify(outcome))
            return
          }
          const { state: nextQueue, item } = dequeue(state.queue)
          state = { ...state, queue: nextQueue }
          saveState(state)
          const label = input.imageBase64 ? '<image upload>' : `"${(input.text ?? '').slice(0, 30)}"`
          console.log(`[plot] ${label} → ${outcome.mode} (${outcome.detail}) — paid by ${item?.txHash}`)
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
    const target = plotterEnv.serialTarget
      ? `machine at ${plotterEnv.serialTarget} (serial)`
      : plotterEnv.tcpTarget
        ? `machine at ${plotterEnv.tcpTarget} (wifi)`
        : `dry-run → ${plotterEnv.dryRunDir}/`
    console.log(`[plotter] ${target}`)
  })
}

/** The booth's local kiosk page: queue status, text/image tabs, and a
 *  what-the-pen-will-draw preview. Plain HTML, no build step — it runs on
 *  the booth laptop, not the public internet. */
function kioskPage(pending: number, tcpTarget: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>onchain vending — kiosk</title>
<style>
  body { font-family: sans-serif; max-width: 520px; margin: 2rem auto; padding: 0 1rem; }
  .badge { font-size: 2.5rem; font-weight: bold; }
  .tabs { display: flex; gap: .5rem; margin: 1rem 0 .75rem; }
  .tabs button { flex: 1; font-size: 1.1rem; padding: .6rem; border: 2px solid #888; background: #fff; cursor: pointer; }
  .tabs button.active { border-color: #1a1a2e; background: #1a1a2e; color: #fff; }
  textarea, input[type=file] { width: 100%; font-size: 1.1rem; padding: .5rem; box-sizing: border-box; }
  .lane { display: none; }
  .lane.active { display: block; }
  .row { display: flex; gap: .5rem; margin-top: .75rem; }
  .row button { flex: 1; font-size: 1.15rem; padding: .6rem; cursor: pointer; }
  #go { background: #1a1a2e; color: #fff; border: none; }
  #previewBox { margin-top: 1rem; border: 1px solid #ddd; min-height: 120px; display: flex; align-items: center; justify-content: center; }
  #previewBox svg { width: 100%; height: auto; max-height: 420px; }
  #stats { color: #666; font-size: .9rem; margin-top: .35rem; }
  #result { margin-top: 1rem; white-space: pre-wrap; font-family: monospace; font-size: .85rem; }
  label { font-size: .95rem; color: #444; }
</style></head><body>
<h1>결제 대기: <span class="badge" id="pending">${pending}</span></h1>
<p>${tcpTarget ? `기계 연결: ${tcpTarget}` : '드라이런 모드 (기계 미연결 — G-code 파일로 저장)'}</p>

<div class="tabs">
  <button id="tab-text" class="active" onclick="setLane('text')">문구</button>
  <button id="tab-image" onclick="setLane('image')">이미지</button>
</div>

<div id="lane-text" class="lane active">
  <textarea id="text" rows="3" maxlength="80" placeholder="쓸 문구를 입력하세요 (최대 80자, 줄바꿈 가능)"></textarea>
</div>

<div id="lane-image" class="lane">
  <input type="file" id="file" accept="image/*">
  <div style="margin-top:.5rem">
    <label>선 추출 강도 <span id="thVal">160</span> (낮음=진한 선만 / 높음=흐린 부분까지)</label>
    <input type="range" id="threshold" min="40" max="240" value="160" style="width:100%"
           oninput="document.getElementById('thVal').textContent=this.value">
  </div>
</div>

<div class="row">
  <button onclick="preview()">미리보기</button>
  <button id="go" onclick="plot()">그리기 시작</button>
</div>
<div id="previewBox"><span style="color:#999">미리보기가 여기 표시됩니다</span></div>
<div id="stats"></div>
<div id="result"></div>

<script>
  let lane = 'text'
  function setLane(l) {
    lane = l
    for (const t of ['text','image']) {
      document.getElementById('tab-'+t).classList.toggle('active', t===l)
      document.getElementById('lane-'+t).classList.toggle('active', t===l)
    }
  }
  async function refresh() {
    const r = await fetch('/dispense-queue').then(r => r.json())
    document.getElementById('pending').textContent = r.pending
  }
  setInterval(refresh, 3000)

  function readFile() {
    return new Promise((resolve, reject) => {
      const f = document.getElementById('file').files[0]
      if (!f) return resolve(null)
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(f)
    })
  }
  async function buildInput() {
    if (lane === 'text') return { text: document.getElementById('text').value }
    const imageBase64 = await readFile()
    if (!imageBase64) throw new Error('이미지를 먼저 선택하세요')
    return { imageBase64, threshold: Number(document.getElementById('threshold').value) }
  }
  async function preview() {
    const box = document.getElementById('previewBox'), stats = document.getElementById('stats')
    try {
      box.innerHTML = '<span style="color:#999">변환 중...</span>'
      const input = await buildInput()
      const r = await fetch('/preview', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(input) })
      const data = await r.json()
      if (!data.ok) { box.innerHTML = '<span style="color:#c00">'+data.error+'</span>'; stats.textContent=''; return }
      box.innerHTML = data.svg
      stats.textContent = '획 ' + data.stats.polylines + '개 · 예상 ' + data.stats.estMinutes.toFixed(1) + '분'
    } catch (e) { box.innerHTML = '<span style="color:#c00">'+e.message+'</span>' }
  }
  async function plot() {
    const el = document.getElementById('result')
    try {
      el.textContent = '...'
      const input = await buildInput()
      const r = await fetch('/plot', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(input) })
      el.textContent = JSON.stringify(await r.json(), null, 2)
      refresh()
    } catch (e) { el.textContent = e.message }
  }
</script></body></html>`
}
