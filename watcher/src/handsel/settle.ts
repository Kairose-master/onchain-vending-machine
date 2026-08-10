/**
 * Handsel settlement — the ORCHESTRATION half.
 *
 * One pipeline per plotted card, fire-and-forget from the plot handler:
 *
 *   posting → posted → (find job in feed) → claimed → submitted → settled
 *
 * Failure anywhere lands in a 'failed' (or 'claimed-elsewhere') timeline
 * entry and NEVER propagates — a broken settlement layer must not break the
 * booth: the customer already has their card in hand by the time any of
 * this runs.
 */
import {
  buildJobBody,
  buildSubmissionOutput,
  cardMarker,
  findJobInFeed,
  isSettledStatus,
  type Card,
  type CardTimeline,
  type SettleStage,
} from './protocol'
import {
  claimJob,
  fetchTasks,
  handselEnvFromProcess,
  makePaidFetch,
  postExternalJob,
  registerWorker,
  submitWork,
  type HandselEnv,
  type WorkerAuth,
} from './client'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The escrow lands on-chain (~12s Sepolia blocks) before the feed can show
// the job; the settlement after submission can take minutes of grading +
// UserOps. Budgets sized to those realities, generous but bounded.
const FIND_TRIES = 20
const FIND_INTERVAL_MS = 10_000
const WATCH_TRIES = 30
const WATCH_INTERVAL_MS = 20_000

export interface HandselService {
  enabled: boolean
  settleCard(card: Card): void
  cards(): CardTimeline[]
}

const disabledService: HandselService = {
  enabled: false,
  settleCard() {
    /* booth runs standalone — nothing to do */
  },
  cards: () => [],
}

export async function initHandsel(processEnv: NodeJS.ProcessEnv): Promise<HandselService> {
  const env = handselEnvFromProcess(processEnv)
  if (!env.enabled) {
    console.log('[handsel] disabled — set HANDSEL_PAYER_KEY + HANDSEL_EMAIL + HANDSEL_PASSWORD to settle cards on the labor market')
    return disabledService
  }

  // Register/reconnect the worker agent and build the paid fetch up front —
  // if either fails, the booth must still boot, just without settlement.
  let auth: WorkerAuth
  let paidFetch: typeof fetch
  try {
    const reg = await registerWorker(env)
    auth = { agentId: reg.agentId, secret: reg.secret }
    paidFetch = await makePaidFetch(env.payerKey)
    console.log(`[handsel] worker agent ${reg.agentId} ${reg.reconnected ? '(reconnected)' : '(new)'} on ${env.url}`)
  } catch (err) {
    console.error('[handsel] setup failed — booth continues WITHOUT settlement:', err instanceof Error ? err.message : err)
    return disabledService
  }

  const timelines = new Map<string, CardTimeline>()
  // On-chain claims share the worker agent's account nonce — serialize them.
  // Only the claim+submit hop is chained; the long feed/settlement watches
  // run freely in parallel.
  let claimChain: Promise<unknown> = Promise.resolve()

  const push = (card: Card, stage: SettleStage, detail?: string) => {
    const t = timelines.get(card.id)
    if (!t) return
    t.entries.push({ stage, at: new Date().toISOString(), ...(detail ? { detail } : {}) })
    console.log(`[handsel] card ${card.id}: ${stage}${detail ? ` — ${detail}` : ''}`)
  }

  async function pipeline(card: Card) {
    const marker = cardMarker(card.id)
    push(card, 'posting')

    // 1. Pay the $0.10 x402 fee and post the job (house agent escrows $25).
    const posted = await postExternalJob(env, paidFetch, buildJobBody(card))
    push(card, 'posted', posted.pending ? 'escrow confirming on-chain' : `escrow tx ${posted.escrowTx}`)

    // 2. The job id isn't in the response — find our marker in the public feed.
    let found: { jobId: number; status: string } | null = null
    for (let i = 0; i < FIND_TRIES && !found; i++) {
      await sleep(FIND_INTERVAL_MS)
      found = findJobInFeed(await fetchTasks(env, 'all'), marker)
    }
    if (!found) {
      push(card, 'failed', `job never appeared in the task feed after ${(FIND_TRIES * FIND_INTERVAL_MS) / 60000} min — check ${env.url}/guest`)
      return
    }

    // 3. Directed claim of exactly our job — never auto-mine.
    let submitted = false
    if (found.status === 'Open') {
      const startedAt = Date.now()
      const claimed = await (claimChain = claimChain.then(() => claimJob(env, auth, found!.jobId)).catch(() => null)) as
        | Awaited<ReturnType<typeof claimJob>>
        | null
      if (claimed?.ok) {
        push(card, 'claimed', `job #${found.jobId}, task ${claimed.taskId}`)
        // 4. Submit the card's real production record as the deliverable.
        const output = buildSubmissionOutput(card, new Date().toISOString())
        await submitWork(env, auth, claimed.taskId, output, Math.round((Date.now() - startedAt) / 1000))
        push(card, 'submitted')
        submitted = true
      } else {
        push(card, 'claimed-elsewhere', claimed ? claimed.reason : 'claim failed')
      }
    } else {
      // Someone on the open market got there first — honest state, keep watching.
      push(card, 'claimed-elsewhere', `feed already shows status ${found.status}`)
    }

    // 5. Watch the job's on-chain status until it leaves the in-flight set.
    let lastStatus = found.status
    for (let i = 0; i < WATCH_TRIES; i++) {
      await sleep(WATCH_INTERVAL_MS)
      const now = findJobInFeed(await fetchTasks(env, 'all'), marker)
      if (!now) continue // feed hiccup or recency window — keep watching
      if (now.status !== lastStatus) lastStatus = now.status
      if (isSettledStatus(now.status)) {
        push(card, 'settled', `on-chain status: ${now.status}`)
        return
      }
    }
    // Timeout is NOT settlement — restate the true current stage with a
    // pointer, never promote it to 'settled' just because we stopped looking.
    push(
      card,
      submitted ? 'submitted' : 'claimed-elsewhere',
      `still ${lastStatus} when the watch window ended — follow up on ${env.url}/guest`,
    )
  }

  return {
    enabled: true,
    settleCard(card: Card) {
      timelines.set(card.id, { card, entries: [] })
      pipeline(card).catch((err) => {
        push(card, 'failed', err instanceof Error ? err.message : String(err))
      })
    },
    cards: () => [...timelines.values()].reverse(), // newest first for the kiosk
  }
}
