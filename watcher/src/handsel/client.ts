/**
 * Handsel settlement — the NETWORK half. Thin, typed wrappers over the four
 * platform endpoints the booth speaks, plus the x402 paid-fetch factory.
 *
 * Endpoint contracts are pinned against the live handsel deployment:
 *   POST /api/agents/register  — headless register/reconnect, returns worker secret
 *   POST /api/jobs/external    — x402-paywalled ($0.10); 202 means "escrow
 *                                confirming, do NOT retry" (a retry double-charges)
 *   GET  /api/tasks            — public feed; the only way to learn our job's id
 *   POST /api/worker/claim     — directed claim of ONE job by id (no auto-mine:
 *                                the booth must never blind-claim strangers' jobs)
 *   POST /api/runtime/callback — submit the deliverable
 */
import type { ExternalJobBody, FeedTask } from './protocol'

export interface HandselEnv {
  url: string
  payerKey: string
  email: string
  password: string
  agentName: string
  enabled: boolean
}

export function handselEnvFromProcess(env: NodeJS.ProcessEnv): HandselEnv {
  const url = (env.HANDSEL_URL?.trim() || 'https://handsel-nu.vercel.app').replace(/\/+$/, '')
  const payerKey = env.HANDSEL_PAYER_KEY?.trim() || ''
  const email = env.HANDSEL_EMAIL?.trim() || ''
  const password = env.HANDSEL_PASSWORD || ''
  const agentName = env.HANDSEL_AGENT_NAME?.trim() || 'vending-booth-worker'
  return {
    url,
    payerKey,
    email,
    password,
    agentName,
    // All three secrets or nothing — a half-configured integration should
    // read as "off", not fail somewhere in the middle of a customer's card.
    enabled: Boolean(payerKey && email && password),
  }
}

async function jsonOrThrow(res: Response, what: string) {
  const text = await res.text()
  if (!res.ok && res.status !== 202) {
    throw new Error(`${what} → HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${what} → non-JSON response: ${text.slice(0, 200)}`)
  }
}

export interface WorkerAuth {
  agentId: string
  secret: string
}

/** Register (or reconnect to) the booth's worker agent. auto_mine stays OFF:
 *  this agent exists to work the booth's own card jobs by directed claim,
 *  never to wander the open market claiming work it can't do. */
export async function registerWorker(env: HandselEnv): Promise<WorkerAuth & { reconnected: boolean }> {
  const res = await fetch(`${env.url}/api/agents/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: env.email,
      password: env.password,
      name: env.agentName,
      description: 'Pen-plotter vending booth worker — settles each physical card as a graded labor-market job',
      auto_mine: false,
      capabilities: ['text'],
    }),
  })
  const data = await jsonOrThrow(res, 'register worker')
  if (!data.agent_id || !data.secret) throw new Error('register worker → response missing agent_id/secret')
  return { agentId: data.agent_id, secret: data.secret, reconnected: Boolean(data.reconnected) }
}

/** fetch wrapped with x402 payment — dynamic import so the booth without
 *  Handsel env never loads (or needs) the dependency. */
export async function makePaidFetch(payerKey: string): Promise<typeof fetch> {
  const { wrapFetchWithPayment, createSigner } = await import('x402-fetch')
  const signer = await createSigner('base-sepolia', payerKey)
  return wrapFetchWithPayment(fetch, signer) as typeof fetch
}

export type PostJobResult = { pending: true } | { pending: false; escrowTx: string }

export async function postExternalJob(
  env: HandselEnv,
  paidFetch: typeof fetch,
  body: ExternalJobBody,
): Promise<PostJobResult> {
  const res = await paidFetch(`${env.url}/api/jobs/external`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await jsonOrThrow(res, 'post external job')
  // 202 = the escrow UserOp was accepted and is confirming. The platform is
  // explicit: retrying posts a SECOND job and charges a second fee. Treat it
  // as success-without-tx; the feed search will find the job either way.
  if (res.status === 202) return { pending: true }
  return { pending: false, escrowTx: String(data.escrow_tx ?? '') }
}

export async function fetchTasks(env: HandselEnv, status: 'Open' | 'all'): Promise<FeedTask[]> {
  const res = await fetch(`${env.url}/api/tasks?status=${status}&limit=50`)
  // 503 here means "market unreadable", not "no tasks" — the caller's retry
  // loop handles both the same way, so collapse to [] without throwing.
  if (!res.ok) return []
  const data = await res.json().catch(() => null)
  return Array.isArray(data?.tasks) ? data.tasks : []
}

/** The feed's fuller shape, for lanes that need to READ a job before
 *  deciding to claim it (the machine labor lane parses the plot text from
 *  these fields — an unparseable job is left for someone who can). */
export interface FeedTaskDetail extends FeedTask {
  description?: string | null
  acceptanceCriteria?: string | null
  chain?: string
}

export async function fetchTaskDetails(env: HandselEnv, status: 'Open' | 'all'): Promise<FeedTaskDetail[]> {
  return (await fetchTasks(env, status)) as FeedTaskDetail[]
}

export type ClaimResult = { ok: true; taskId: string } | { ok: false; reason: string }

export async function claimJob(env: HandselEnv, auth: WorkerAuth, jobId: number): Promise<ClaimResult> {
  const res = await fetch(`${env.url}/api/worker/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-runtime-secret': auth.secret },
    body: JSON.stringify({ agent_id: auth.agentId, job_id: jobId }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    // 409 carries the human-readable refusal (job taken, score gate, bond
    // shortfall…) — that reason IS the timeline detail, keep it verbatim.
    return { ok: false, reason: String(data?.error ?? `HTTP ${res.status}`) }
  }
  if (!data?.task_id) return { ok: false, reason: 'claim response missing task_id' }
  return { ok: true, taskId: String(data.task_id) }
}

export async function submitWork(
  env: HandselEnv,
  auth: WorkerAuth,
  taskId: string,
  output: string,
  executionTimeSec: number,
): Promise<void> {
  const event = (type: string) => ({
    agent_id: auth.agentId,
    task_id: taskId,
    event_type: type,
    success: true,
    execution_time: executionTimeSec,
    token_cost: 0,
    quality_score: null,
    detail: { runtime: 'vending-booth' },
  })
  const res = await fetch(`${env.url}/api/runtime/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-runtime-secret': auth.secret },
    body: JSON.stringify({
      task_id: taskId,
      agent_id: auth.agentId,
      success: true,
      output,
      plan: '',
      quality_score: null, // self-scoring is worthless; the platform's graders decide
      execution_time: executionTimeSec,
      token_cost: 0,
      events: [event('TASK_STARTED'), event('TASK_COMPLETED')],
    }),
  })
  await jsonOrThrow(res, 'submit work')
}
