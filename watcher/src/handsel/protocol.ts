/**
 * Handsel settlement — the PURE half.
 *
 * Every card the booth plots becomes a real job on the Handsel labor market
 * (https://handsel-nu.vercel.app): the booth pays the x402 posting fee, the
 * platform's house agent escrows the bounty on-chain, the booth's own worker
 * agent claims that job by id and submits the machine's real output, and
 * independent grading + on-chain settlement close the loop. This module is
 * everything about that flow which is a plain function over plain data —
 * job-body construction, feed matching, the deliverable text, the timeline
 * vocabulary. The network half lives in client.ts, the orchestration in
 * settle.ts.
 */

export interface CardStats {
  polylines: number
  points: number
  drawLengthMm: number
  travelLengthMm: number
  estMinutes: number
}

export interface Card {
  /** Short unique id — also embedded in the job title as the marker. */
  id: string
  kind: 'text' | 'image'
  /** The exact plotted phrase for text cards; a short label for image cards. */
  label: string
  /** The customer's USDC payment tx that bought this card. */
  paymentTxHash: string
  stats: CardStats
}

/**
 * The marker that ties a booth card to its market job. Embedded in the job
 * title at post time and searched for in the public task feed afterwards —
 * POST /api/jobs/external doesn't return the on-chain job id (the escrow tx
 * is still confirming), so the feed is how the booth finds its own job.
 */
export const cardMarker = (cardId: string) => `[booth:${cardId}]`

export interface ExternalJobBody {
  title: string
  description: string
  acceptance_criteria: string
  min_score: number
}

const TITLE_MAX = 200

export function buildJobBody(card: Card): ExternalJobBody {
  const marker = cardMarker(card.id)
  const what = card.kind === 'text' ? `plot "${card.label}"` : `plot uploaded image (${card.label})`
  // Marker goes FIRST so title truncation can never cut it off — an 80-char
  // CJK phrase plus the boilerplate would otherwise push it past 200.
  const title = `${marker} Pen-plotter postcard: ${what}`.slice(0, TITLE_MAX)
  return {
    title,
    description:
      'A physical pen-plotter card sold at the onchain vending booth (testnet). ' +
      `The customer paid on Base Sepolia (tx ${card.paymentTxHash}) and the booth's ` +
      'plotter drew the card. This job settles that production run on the labor ' +
      "market: the worker is the booth's own plotter agent submitting the machine's real output.",
    acceptance_criteria:
      'The deliverable must contain: ' +
      (card.kind === 'text'
        ? `(1) the exact plotted phrase: ${card.label} `
        : `(1) the image card label: ${card.label} `) +
      `(2) the Base Sepolia transaction hash of the customer's USDC payment: ${card.paymentTxHash} ` +
      '(3) the plotter\'s stroke statistics (polyline count and pen-down draw length in mm) proving a physical card was produced.',
    // 0 on purpose: the booth's worker agent starts at a genuine cold start
    // (score 0, per Handsel's no-fake-data rule) and must be able to claim
    // its own card's job. DEFAULT_MIN_SCORE is also 0, but stating it here
    // keeps the booth correct even if the platform default moves.
    min_score: 0,
  }
}

export interface FeedTask {
  id: string
  title: string
  status: string
}

/** Find this card's job in the public task feed by its title marker.
 *  Returns the numeric on-chain job id, or null when absent/unparsable. */
export function findJobInFeed(tasks: FeedTask[], marker: string): { jobId: number; status: string } | null {
  const hit = tasks.find((t) => typeof t.title === 'string' && t.title.includes(marker))
  if (!hit) return null
  const jobId = Number(hit.id)
  if (!Number.isInteger(jobId) || jobId < 0) return null
  return { jobId, status: hit.status }
}

/** The worker's deliverable: the card's real production record, shaped to
 *  satisfy buildJobBody's acceptance criteria field by field. */
export function buildSubmissionOutput(card: Card, plottedAtIso: string): string {
  const marker = cardMarker(card.id)
  return [
    `Booth card ${marker}`,
    card.kind === 'text' ? `Plotted phrase: ${card.label}` : `Image card label: ${card.label}`,
    `Customer payment (Base Sepolia USDC) tx hash: ${card.paymentTxHash}`,
    `Plot statistics: ${card.stats.polylines} polylines, ${card.stats.points} points, ` +
      `${card.stats.drawLengthMm.toFixed(0)} mm drawn, ${card.stats.travelLengthMm.toFixed(0)} mm travel, ` +
      `~${card.stats.estMinutes.toFixed(1)} min plot time`,
    `Plotted at: ${plottedAtIso}`,
  ].join('\n')
}

// ── the machine labor lane (operatorship archetype #3) ────────────────────
// External demand posts a job carrying the machine marker; this machine
// discovers it in the public feed, claims it by id, performs it physically,
// and submits the production record. The DEMAND side is a stranger — that
// is the whole difference from the card-settlement lane above, where the
// booth is its own requester.

/** Jobs addressed to plot-capable machines carry this in the title. */
export const MACHINE_PLOT_MARKER = '[machine:plot]'

/**
 * Is this feed entry a bounty this machine should claim? Own booth-card
 * jobs are excluded by their `[booth:` marker — a machine must never
 * "discover" the jobs it posted about its own output.
 */
export function isMachineBounty(title: string, marker: string = MACHINE_PLOT_MARKER): boolean {
  return title.includes(marker) && !title.includes('[booth:')
}

/**
 * What to physically plot, parsed from the job's text fields BEFORE
 * claiming — a job this machine cannot parse must be left unclaimed for
 * someone who can, not claimed and failed. Convention (documented in the
 * README): a line `plot: <the text>` in the description or criteria;
 * quotes optional. Falls back to the title minus the marker.
 */
export function extractPlotText(fields: { title: string; description?: string | null; acceptanceCriteria?: string | null }): string | null {
  for (const source of [fields.description, fields.acceptanceCriteria]) {
    const m = source?.match(/plot:\s*"([^"]{1,80})"|plot:\s*([^\n]{1,80})/)
    if (m) {
      const text = (m[1] ?? m[2] ?? '').trim()
      if (text) return text
    }
  }
  const fallback = fields.title.replace(MACHINE_PLOT_MARKER, '').trim()
  return fallback.length > 0 && fallback.length <= 80 ? fallback : null
}

/** The machine's deliverable: what it plotted and the physical evidence it
 *  can honestly offer (production statistics — this machine has no camera,
 *  and the record says so instead of pretending). */
export function buildMachineSubmission(input: {
  jobTitle: string
  plottedText: string
  stats: CardStats
  machineName: string
  plottedAtIso: string
}): string {
  return [
    `Machine execution record — ${input.machineName}`,
    `Bounty: ${input.jobTitle}`,
    `Physically plotted text: ${input.plottedText}`,
    `Plot statistics: ${input.stats.polylines} polylines, ${input.stats.points} points, ` +
      `${input.stats.drawLengthMm.toFixed(0)} mm drawn, ~${input.stats.estMinutes.toFixed(1)} min`,
    `Plotted at: ${input.plottedAtIso}`,
    `Evidence class: production record (no camera on this machine — stats and G-code, not photographs)`,
  ].join('\n')
}

export type MachineWorkStage = 'claimed' | 'plotted' | 'submitted' | 'failed'

export interface MachineWorkRecord {
  jobId: number
  taskId: string | null
  title: string
  plottedText: string
  entries: Array<{ stage: MachineWorkStage; at: string; detail?: string }>
}

/**
 * Timeline vocabulary the kiosk renders. 'claimed-elsewhere' is a real,
 * honest state: the job is on a PUBLIC market, and another worker beating
 * the booth to its own card's job is the market working, not an error.
 */
export type SettleStage =
  | 'posting'
  | 'posted'
  | 'claimed'
  | 'submitted'
  | 'settled'
  | 'claimed-elsewhere'
  | 'failed'

export interface TimelineEntry {
  stage: SettleStage
  at: string
  detail?: string
}

export interface CardTimeline {
  card: Card
  entries: TimelineEntry[]
}

/** On-chain statuses that mean "still in flight" — anything else observed
 *  after submission is treated as the settlement outcome. */
const IN_FLIGHT_STATUSES = new Set(['Open', 'Accepted', 'Submitted'])

export const isSettledStatus = (status: string) => !IN_FLIGHT_STATUSES.has(status)
