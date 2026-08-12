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
import { initHandsel } from './handsel/settle'
import type { Card } from './handsel/protocol'
import { randomUUID } from 'node:crypto'
import {
  emptyRecipeStore,
  outstandingBaseUnits,
  publicRecipe,
  recordPayout,
  recordSale,
  validateRegistration,
  type Recipe,
  type RecipeStore,
} from './recipes'
import { isRoyaltyConfigured, payRoyalty } from './royalty'

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

function loadRecipes(): RecipeStore {
  if (!existsSync(config.recipesFile)) return emptyRecipeStore()
  try {
    return JSON.parse(readFileSync(config.recipesFile, 'utf8'))
  } catch {
    console.error(`[recipes] ${config.recipesFile} is unreadable — starting empty`)
    return emptyRecipeStore()
  }
}

function saveRecipes(store: RecipeStore) {
  writeFileSync(config.recipesFile, JSON.stringify(store, null, 2))
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
  const handsel = await initHandsel(process.env)
  let recipeStore = loadRecipes()
  const royaltyOn = isRoyaltyConfigured()
  console.log(
    `[recipes] ${recipeStore.recipes.length} design(s), author share ${config.recipeAuthorBps / 100}%, ` +
      `royalty payout ${royaltyOn ? 'ON (on-chain USDC per sale)' : 'OFF (accrue only — set ROYALTY_PAYER_KEY)'}`,
  )
  let plotting = false

  const findRecipe = (id: unknown): Recipe | undefined =>
    typeof id === 'string' ? recipeStore.recipes.find((r) => r.id === id) : undefined

  /** A sold recipe card: bump the ledger, then try the on-chain payout.
   *  Fire-and-forget from the plot path — the customer's card and the
   *  author's accrual are already safe before this runs. */
  async function settleRecipeSale(recipeId: string) {
    const recipe = findRecipe(recipeId)
    if (!recipe) return
    let updated = recordSale(recipe, config.priceBaseUnits, config.recipeAuthorBps)
    recipeStore = { recipes: recipeStore.recipes.map((r) => (r.id === recipeId ? updated : r)) }
    saveRecipes(recipeStore)

    if (royaltyOn && updated.authorWallet) {
      const amount = outstandingBaseUnits(updated)
      const paid = await payRoyalty(updated.authorWallet as `0x${string}`, amount)
      if (paid.ok) {
        updated = recordPayout(updated, amount, paid.txHash)
        recipeStore = { recipes: recipeStore.recipes.map((r) => (r.id === recipeId ? updated : r)) }
        saveRecipes(recipeStore)
        console.log(`[recipes] paid ${amount} base units to ${updated.author} — ${paid.txHash}`)
      } else {
        console.warn(`[recipes] payout deferred (accrued): ${paid.reason}`)
      }
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/kiosk')) {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.writeHead(200)
      res.end(kioskPage(state.queue.pending.length, plotterEnv.serialTarget || plotterEnv.tcpTarget, handsel.enabled))
      return
    }

    res.setHeader('content-type', 'application/json')

    if (req.method === 'GET' && req.url === '/dispense-queue') {
      res.writeHead(200)
      res.end(JSON.stringify({ pending: state.queue.pending.length }))
      return
    }

    if (req.method === 'GET' && req.url === '/handsel/cards') {
      res.writeHead(200)
      res.end(JSON.stringify({ enabled: handsel.enabled, cards: handsel.cards() }))
      return
    }

    if (req.method === 'GET' && req.url === '/recipes') {
      res.writeHead(200)
      res.end(
        JSON.stringify({
          authorBps: config.recipeAuthorBps,
          payoutOn: royaltyOn,
          priceBaseUnits: config.priceBaseUnits,
          recipes: recipeStore.recipes.map(publicRecipe),
        }),
      )
      return
    }

    if (req.method === 'POST' && req.url === '/recipes') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body)
          const checked = validateRegistration(parsed)
          if (!checked.ok) {
            res.writeHead(422)
            res.end(JSON.stringify({ ok: false, error: checked.error }))
            return
          }
          // The real pipeline decides drawability at REGISTRATION time — a
          // design that produces no strokes must be refused here, not
          // discovered by a paying customer at the machine.
          const strokes = await plotInputToStrokes(
            checked.recipe.kind === 'text'
              ? { text: checked.recipe.text }
              : { imageBase64: checked.recipe.imageBase64, threshold: checked.recipe.threshold },
            plotterEnv,
          )
          if ('error' in strokes) {
            res.writeHead(422)
            res.end(JSON.stringify({ ok: false, error: `그릴 수 없는 디자인입니다: ${strokes.error}` }))
            return
          }
          const recipe: Recipe = { ...checked.recipe, id: randomUUID().slice(0, 8), createdAt: new Date().toISOString() }
          recipeStore = { recipes: [...recipeStore.recipes, recipe] }
          saveRecipes(recipeStore)
          console.log(`[recipes] registered "${recipe.name}" by ${recipe.author} (${recipe.kind})`)
          res.writeHead(200)
          res.end(JSON.stringify({ ok: true, recipe: publicRecipe(recipe) }))
        } catch (err) {
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'bad request' }))
        }
      })
      return
    }

    if (req.method === 'POST' && req.url === '/preview') {
      // Free and creditless: rendering "what would the pen draw" must never
      // gate on payment, or the customer can't decide before paying.
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body) as PlotInput & { recipeId?: string }
          let input: PlotInput = parsed
          if (parsed.recipeId) {
            const recipe = findRecipe(parsed.recipeId)
            if (!recipe) {
              res.writeHead(404)
              res.end(JSON.stringify({ ok: false, error: 'no such recipe' }))
              return
            }
            input =
              recipe.kind === 'text'
                ? { text: recipe.text }
                : { imageBase64: recipe.imageBase64, threshold: recipe.threshold }
          }
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
        let soldRecipe: Recipe | undefined
        try {
          const parsed = JSON.parse(body) as PlotInput & { recipeId?: string }
          if (parsed.recipeId) {
            soldRecipe = findRecipe(parsed.recipeId)
            if (!soldRecipe) {
              res.writeHead(404)
              res.end(JSON.stringify({ ok: false, error: 'no such recipe' }))
              return
            }
            input =
              soldRecipe.kind === 'text'
                ? { text: soldRecipe.text }
                : { imageBase64: soldRecipe.imageBase64, threshold: soldRecipe.threshold }
          } else {
            input = { text: parsed.text, imageBase64: parsed.imageBase64, threshold: parsed.threshold }
          }
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
          const label = soldRecipe
            ? `recipe "${soldRecipe.name}" by ${soldRecipe.author}`
            : input.imageBase64
              ? '<image upload>'
              : `"${(input.text ?? '').slice(0, 30)}"`
          console.log(`[plot] ${label} → ${outcome.mode} (${outcome.detail}) — paid by ${item?.txHash}`)
          // The operatorship split: a sold design accrues (and, with the
          // hot key, pays on-chain) the author's share. Fire-and-forget —
          // the customer's card is already out of the machine.
          if (soldRecipe) void settleRecipeSale(soldRecipe.id)
          // Settle this card on the Handsel labor market — fire-and-forget:
          // the customer already has their card; settlement failing must
          // never claw that back or block the next customer.
          let handselCardId: string | undefined
          if (handsel.enabled) {
            const card: Card = {
              id: randomUUID().slice(0, 8),
              kind: input.imageBase64 ? 'image' : 'text',
              label: soldRecipe
                ? `${soldRecipe.name} (by ${soldRecipe.author})`.slice(0, 80)
                : input.imageBase64
                  ? '이미지 카드'
                  : (input.text ?? '').trim().slice(0, 80),
              paymentTxHash: item?.txHash ?? 'unknown',
              stats: outcome.stats,
            }
            handsel.settleCard(card)
            handselCardId = card.id
          }
          res.writeHead(200)
          res.end(JSON.stringify({ ...outcome, paidBy: item?.txHash, remaining: nextQueue.pending.length, ...(handselCardId ? { handselCardId } : {}) }))
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
function kioskPage(pending: number, tcpTarget: string, handselEnabled: boolean): string {
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
  .hcard { border: 1px solid #ddd; padding: .6rem .75rem; margin-top: .6rem; }
  .hcard .hlabel { font-weight: bold; margin-bottom: .35rem; }
  .chips { display: flex; flex-wrap: wrap; gap: .35rem; }
  .chip { font-size: .8rem; padding: .15rem .5rem; border-radius: 999px; background: #eee; color: #444; }
  .chip.done { background: #1a1a2e; color: #fff; }
  .chip.bad { background: #c00; color: #fff; }
  .chip.warn { background: #b8860b; color: #fff; }
  .hdetail { font-size: .8rem; color: #888; margin-top: .3rem; }
</style></head><body>
<h1>결제 대기: <span class="badge" id="pending">${pending}</span></h1>
<p>${tcpTarget ? `기계 연결: ${tcpTarget}` : '드라이런 모드 (기계 미연결 — G-code 파일로 저장)'}</p>

<div class="tabs">
  <button id="tab-text" class="active" onclick="setLane('text')">문구</button>
  <button id="tab-image" onclick="setLane('image')">이미지</button>
  <button id="tab-gallery" onclick="setLane('gallery')">갤러리</button>
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

<div id="lane-gallery" class="lane">
  <p style="font-size:.85rem;color:#666;margin:.25rem 0 .5rem">
    다른 사람이 등록한 디자인이에요. 팔릴 때마다 등록자가 <span id="authorPct">70</span>%를 가져갑니다.
  </p>
  <div id="recipeList"><span style="color:#999">불러오는 중…</span></div>
  <details style="margin-top:.75rem">
    <summary style="cursor:pointer;font-size:.95rem">+ 내 디자인 등록하기 (무료)</summary>
    <div style="margin-top:.5rem;display:flex;flex-direction:column;gap:.4rem">
      <input id="rName" maxlength="40" placeholder="디자인 이름 (예: 응원 카드)" style="font-size:1rem;padding:.4rem">
      <input id="rAuthor" maxlength="20" placeholder="작가명" style="font-size:1rem;padding:.4rem">
      <input id="rWallet" placeholder="로열티 받을 지갑 주소 0x… (Base Sepolia, 비워도 됨)" style="font-size:1rem;padding:.4rem">
      <textarea id="rText" rows="2" maxlength="80" placeholder="문구 디자인이면 여기에 (이미지면 아래에서 파일 선택)"></textarea>
      <input type="file" id="rFile" accept="image/*">
      <button onclick="registerRecipe()" style="font-size:1rem;padding:.5rem;cursor:pointer">등록</button>
      <div id="rResult" style="font-size:.85rem"></div>
    </div>
  </details>
</div>

<div class="row">
  <button onclick="preview()">미리보기</button>
  <button id="go" onclick="plot()">그리기 시작</button>
</div>
<div id="previewBox"><span style="color:#999">미리보기가 여기 표시됩니다</span></div>
<div id="stats"></div>
<div id="result"></div>

${handselEnabled ? '<h2 style="margin-top:1.5rem">Handsel 정산 <span style="font-size:.8rem;color:#888;font-weight:normal">카드 1장 = 라이브 잡 1건</span></h2><div id="handsel"><span style="color:#999">아직 정산된 카드가 없습니다</span></div>' : ''}

<script>
  let lane = 'text'
  let selectedRecipe = null
  function setLane(l) {
    lane = l
    for (const t of ['text','image','gallery']) {
      document.getElementById('tab-'+t).classList.toggle('active', t===l)
      document.getElementById('lane-'+t).classList.toggle('active', t===l)
    }
    if (l === 'gallery') refreshRecipes()
  }

  const esc2 = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const fmtUsdc = (bu) => (Number(bu) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })
  async function refreshRecipes() {
    try {
      const r = await fetch('/recipes').then(r => r.json())
      document.getElementById('authorPct').textContent = (r.authorBps / 100).toString()
      const list = document.getElementById('recipeList')
      if (r.recipes.length === 0) {
        list.innerHTML = '<span style="color:#999">아직 등록된 디자인이 없어요 — 1호가 되어보세요</span>'
        return
      }
      list.innerHTML = r.recipes.map(rc =>
        '<div class="hcard" style="cursor:pointer' + (selectedRecipe===rc.id ? ';border-color:#1a1a2e;border-width:2px' : '') + '" onclick="selectRecipe(\\'' + rc.id + '\\')">' +
          '<div class="hlabel">' + esc2(rc.name) + ' <span style="color:#888;font-weight:normal">by ' + esc2(rc.author) + '</span></div>' +
          '<div style="font-size:.8rem;color:#666">' + (rc.kind==='text' ? '문구: ' + esc2(rc.text ?? '') : '이미지 디자인') +
          ' · 판매 ' + rc.sales + '회 · 작가 수익 ' + fmtUsdc(rc.accruedBaseUnits) + ' USDC' +
          (rc.lastPayoutTx ? ' <a href="https://sepolia.basescan.org/tx/' + rc.lastPayoutTx + '" target="_blank" onclick="event.stopPropagation()">지급 tx↗</a>'
            : Number(rc.accruedBaseUnits) > 0 ? ' (적립)' : '') +
          '</div></div>'
      ).join('')
    } catch { /* gallery is optional decoration on failure */ }
  }
  function selectRecipe(id) { selectedRecipe = id; refreshRecipes() }

  function readRegFile() {
    return new Promise((resolve, reject) => {
      const f = document.getElementById('rFile').files[0]
      if (!f) return resolve(null)
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(f)
    })
  }
  async function registerRecipe() {
    const out = document.getElementById('rResult')
    try {
      out.textContent = '검사 중… (실제로 그릴 수 있는지 확인해요)'
      const imageBase64 = await readRegFile()
      const bodyData = {
        name: document.getElementById('rName').value,
        author: document.getElementById('rAuthor').value,
        authorWallet: document.getElementById('rWallet').value,
        text: document.getElementById('rText').value || undefined,
        imageBase64: imageBase64 || undefined,
        threshold: 160,
      }
      const r = await fetch('/recipes', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(bodyData) })
      const data = await r.json()
      if (!data.ok) { out.innerHTML = '<span style="color:#c00">' + esc2(data.error) + '</span>'; return }
      out.innerHTML = '<span style="color:#080">등록 완료! 갤러리에서 확인하세요</span>'
      for (const id of ['rName','rAuthor','rWallet','rText']) document.getElementById(id).value = ''
      document.getElementById('rFile').value = ''
      refreshRecipes()
    } catch (e) { out.textContent = e.message }
  }
  async function refresh() {
    const r = await fetch('/dispense-queue').then(r => r.json())
    document.getElementById('pending').textContent = r.pending
  }
  setInterval(refresh, 3000)

  const HANDSEL = ${handselEnabled ? 'true' : 'false'}
  const STAGE_KO = { posting: '잡 등록 중', posted: '에스크로 완료', claimed: '클레임', submitted: '제출 완료',
                     settled: '정산 완료', 'claimed-elsewhere': '외부 워커 진행', failed: '실패' }
  function chipClass(stage) {
    if (stage === 'failed') return 'chip bad'
    if (stage === 'claimed-elsewhere') return 'chip warn'
    return 'chip done'
  }
  async function refreshHandsel() {
    if (!HANDSEL) return
    try {
      const r = await fetch('/handsel/cards').then(r => r.json())
      if (!r.cards || r.cards.length === 0) return
      const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      document.getElementById('handsel').innerHTML = r.cards.map(({ card, entries }) => {
        const last = entries[entries.length - 1]
        const chips = entries.map(e => '<span class="' + chipClass(e.stage) + '">' + (STAGE_KO[e.stage] || e.stage) + '</span>').join('')
        const detail = last && last.detail ? '<div class="hdetail">' + esc(last.detail) + '</div>' : ''
        return '<div class="hcard"><div class="hlabel">' + esc(card.label) + ' <span style="color:#aaa;font-weight:normal">#' + esc(card.id) + '</span></div>'
          + '<div class="chips">' + chips + '</div>' + detail + '</div>'
      }).join('')
    } catch { /* settlement view is decorative — never let it break the kiosk */ }
  }
  setInterval(refreshHandsel, 5000)
  refreshHandsel()

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
    if (lane === 'gallery') {
      if (!selectedRecipe) throw new Error('갤러리에서 디자인을 먼저 선택하세요')
      return { recipeId: selectedRecipe }
    }
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
      if (lane === 'gallery') setTimeout(refreshRecipes, 2000) // let the sale + payout land

    } catch (e) { el.textContent = e.message }
  }
</script></body></html>`
}
