/**
 * Operator credit — a track record earned by running someone else's machine.
 *
 * The thesis' increment 4 was written as "machine credit": the machine earns
 * a score from its labor history. Building it turned the priority around. A
 * machine's score matters when there are many machines; an OPERATOR's score
 * matters on the very first machine, and it is the object that travels — a
 * lessee who kept slot 3 stocked here should be able to lease slot 1 over
 * there against a smaller deposit. Portable operator history is the thing no
 * bank has and no landlord can price, and it is generated for free by a
 * market that already records who sold what and who ran out.
 *
 * WHAT THIS SCORES, AND WHY THOSE:
 *  - fill rate — sales vs. payments that hit an empty magazine. A stockout is
 *    not bad luck, it is the operator's job undone, and the booth already has
 *    to refund it (slots.ts, RefundDue). The one number that most directly
 *    measures "did this person do the thing they took the slot to do".
 *  - restock response — how fast a stockout was answered, and whether the
 *    restock was confirmed rather than merely claimed.
 *  - tenure and volume — small weights, because they measure survival rather
 *    than quality, and because weighting them heavily would make an early
 *    operator unbeatable by a better later one.
 *
 * NO BACK-FILL. The credit ledger begins when the event log begins; slot
 * counters from before it are real numbers with no timestamps, and inventing
 * timestamps to make an operator look established is exactly the fake-data
 * rule this repo does not break. A brand-new operator is unrated and posts
 * full collateral, which is the honest cold start.
 */
import type { EvidenceClass } from './concession'

export type OperatorEvent =
  | { kind: 'lease-start'; at: string; concessionId: string; operator: string }
  | { kind: 'sale'; at: string; concessionId: string; operator: string }
  /** A payment arrived for an empty slot: the machine had to refuse and refund. */
  | { kind: 'stockout'; at: string; concessionId: string; operator: string }
  | {
      kind: 'restock'
      at: string
      concessionId: string
      operator: string
      units: number
      /** How the restock is known to have happened. `self-reported` on the
       *  ack; upgraded to `confirmed-by-sale` when the machine subsequently
       *  dispenses from that slot — an empty magazine cannot sell. */
      evidence: EvidenceClass
    }

export interface OperatorRecord {
  operator: string
  concessions: string[]
  sales: number
  stockouts: number
  restocks: number
  confirmedRestocks: number
  /** Hours from a stockout to the next restock of that concession. Median,
   *  because one holiday weekend should not define a record. */
  medianRestockHours: number | null
  /** Stockouts still unanswered at the end of the log. */
  openStockouts: number
  firstSeen: string | null
  lastSeen: string | null
}

export interface CreditVerdict {
  score: number
  rating: 'unrated' | 'thin' | 'fair' | 'good' | 'strong'
  /** Human-readable reasons, in the order they were applied. An operator told
   *  "collateral 100%" with no explanation cannot fix anything. */
  basis: string[]
}

/** Below this many metered events, no rating is issued at ANY performance.
 *  One sale and no stockouts is a 100% fill rate and means nothing; a score
 *  that says otherwise would be the fastest way to make this number a lie. */
export const MIN_HISTORY = 5

const hoursBetween = (a: string, b: string) =>
  (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

/**
 * Fold the log into one record per operator.
 *
 * Restock latency is matched per concession, oldest-stockout-first: a restock
 * answers the earliest still-open stockout on that slot. Matching newest-first
 * would let one restock close a fresh stockout and leave a week-old one
 * "open", flattering the record of exactly the operator who ignored it.
 */
export function summarize(events: OperatorEvent[]): OperatorRecord[] {
  const byOperator = new Map<string, OperatorRecord>()
  const openStockouts = new Map<string, string[]>() // `${operator}|${concessionId}` → timestamps
  const latencies = new Map<string, number[]>()

  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at))

  for (const e of ordered) {
    let rec = byOperator.get(e.operator)
    if (!rec) {
      rec = {
        operator: e.operator,
        concessions: [],
        sales: 0,
        stockouts: 0,
        restocks: 0,
        confirmedRestocks: 0,
        medianRestockHours: null,
        openStockouts: 0,
        firstSeen: null,
        lastSeen: null,
      }
      byOperator.set(e.operator, rec)
    }
    if (!rec.concessions.includes(e.concessionId)) rec.concessions.push(e.concessionId)
    if (!rec.firstSeen || e.at < rec.firstSeen) rec.firstSeen = e.at
    if (!rec.lastSeen || e.at > rec.lastSeen) rec.lastSeen = e.at

    const key = `${e.operator}|${e.concessionId}`
    if (e.kind === 'sale') rec.sales++
    if (e.kind === 'stockout') {
      rec.stockouts++
      openStockouts.set(key, [...(openStockouts.get(key) ?? []), e.at])
    }
    if (e.kind === 'restock') {
      rec.restocks++
      if (e.evidence !== 'self-reported') rec.confirmedRestocks++
      const open = openStockouts.get(key) ?? []
      const oldest = open.shift()
      if (oldest) {
        latencies.set(e.operator, [...(latencies.get(e.operator) ?? []), hoursBetween(oldest, e.at)])
        openStockouts.set(key, open)
      }
    }
  }

  for (const [key, open] of openStockouts) {
    if (open.length === 0) continue
    const operator = key.split('|')[0]!
    const rec = byOperator.get(operator)
    if (rec) rec.openStockouts += open.length
  }
  for (const [operator, xs] of latencies) {
    const rec = byOperator.get(operator)
    if (rec) rec.medianRestockHours = median(xs)
  }

  return [...byOperator.values()]
}

/**
 * The score. 0–100, and it starts at 0 for everyone.
 *
 * Weights: fill 45 / restock 25 / tenure 15 / volume 15. Performance
 * dominates on purpose — tenure and volume are the components an operator
 * cannot improve by being better, only by being older or bigger.
 */
export function creditScore(rec: OperatorRecord, now: string): CreditVerdict {
  const metered = rec.sales + rec.stockouts
  if (metered < MIN_HISTORY) {
    return {
      score: 0,
      rating: 'unrated',
      basis: [`${metered}/${MIN_HISTORY} metered events — too little history to rate; full collateral applies`],
    }
  }

  const basis: string[] = []

  const fillRate = rec.sales / metered
  const fill = fillRate * 45
  basis.push(`fill rate ${(fillRate * 100).toFixed(0)}% (${rec.sales} sold, ${rec.stockouts} turned away) → ${fill.toFixed(1)}/45`)

  // Never having stocked out is the BEST restock record, not a missing one:
  // the point of restocking is that customers never meet an empty slot.
  let restock: number
  if (rec.stockouts === 0) {
    restock = 25
    basis.push('never ran out → 25/25')
  } else if (rec.medianRestockHours === null) {
    restock = 0
    basis.push(`${rec.openStockouts} stockout(s) never answered → 0/25`)
  } else {
    // 24h or better is full marks; decays to zero at a week.
    const h = rec.medianRestockHours
    const speed = h <= 24 ? 1 : h >= 168 ? 0 : 1 - (h - 24) / 144
    // Claimed-but-unconfirmed restocks count for less than confirmed ones.
    const confirmRatio = rec.restocks === 0 ? 0 : rec.confirmedRestocks / rec.restocks
    const quality = 0.6 + 0.4 * confirmRatio
    restock = 25 * speed * quality
    basis.push(
      `median restock ${h.toFixed(1)}h, ${rec.confirmedRestocks}/${rec.restocks} confirmed → ${restock.toFixed(1)}/25`,
    )
    if (rec.openStockouts > 0) basis.push(`${rec.openStockouts} stockout(s) still unanswered`)
  }

  const days = rec.firstSeen ? Math.max(0, hoursBetween(rec.firstSeen, now) / 24) : 0
  const tenure = Math.min(15, (days / 90) * 15)
  basis.push(`${days.toFixed(0)} day(s) operating → ${tenure.toFixed(1)}/15`)

  // Log-scaled: the 10th sale should matter more than the 110th.
  const volume = Math.min(15, (Math.log10(rec.sales + 1) / Math.log10(101)) * 15)
  basis.push(`${rec.sales} lifetime sale(s) → ${volume.toFixed(1)}/15`)

  const score = Math.round(fill + restock + tenure + volume)
  const rating: CreditVerdict['rating'] = score >= 75 ? 'strong' : score >= 55 ? 'good' : score >= 35 ? 'fair' : 'thin'
  return { score, rating, basis }
}

/** Collateral floor: nobody operates on pure reputation. A perfect record
 *  buys a 75% discount, never a free slot — the downside condition is what
 *  separates operatorship from a free option (concession.ts), and a zero
 *  deposit would delete it for exactly the operators with the most to gain
 *  from one bad month. */
export const COLLATERAL_FLOOR_BPS = 2500

/**
 * The up-front lease deposit, as bps of the inventory's value.
 *
 * QUOTED, NOT COLLECTED. There is no deposit-taking payment flow in the booth
 * today, and a number the kiosk displays as if it were held would be the
 * worst kind of feature — a control that reads as enforced and enforces
 * nothing. What IS enforced is `rollingBondBaseUnits` below. This function
 * exists because the two answer different questions (what should you post to
 * start, vs. what is held back as you earn), and because the deposit flow is
 * the next increment rather than an idea.
 */
export function requiredCollateralBps(score: number): number {
  const clamped = Math.max(0, Math.min(100, score))
  const range = 10_000 - COLLATERAL_FLOOR_BPS
  return Math.round(10_000 - (clamped / 100) * range)
}

/** Held back from a new operator's earnings; shrinks to the floor as the
 *  record fills in. Deliberately far below the up-front quote: a bond funded
 *  out of revenue is collected from someone who has already delivered value,
 *  and holding a third of that is plenty of skin. */
export const MAX_BOND_BPS = 3000
export const MIN_BOND_BPS = 500

export function bondBps(score: number): number {
  const clamped = Math.max(0, Math.min(100, score))
  return Math.round(MAX_BOND_BPS - (clamped / 100) * (MAX_BOND_BPS - MIN_BOND_BPS))
}

/**
 * The bond that is actually enforced today — a rolling performance hold,
 * funded out of the operator's own accrued revenue rather than up front.
 *
 * Why this shape: a cold-start operator has a record of nothing and, usually,
 * capital of nothing. Demanding a deposit before the first sale is the
 * ordinary way to exclude exactly the people this market exists to let in.
 * Withholding a slice of what they earn puts real capital at risk — the
 * downside condition, met for real — without requiring any capital to begin.
 *
 * It is bounded by what is still owed, because money already paid out is the
 * operator's and cannot be retroactively held; that is why the hold grows
 * naturally over the first sales and then stops.
 *
 * This is disclosed, not confiscated: the held amount is released as the
 * score rises, and the ledger shows it as owed the whole time.
 */
export function rollingBondBaseUnits(input: {
  lifetimeAccruedBaseUnits: bigint
  outstandingBaseUnits: bigint
  score: number
}): bigint {
  if (input.outstandingBaseUnits <= 0n) return 0n
  const target = (input.lifetimeAccruedBaseUnits * BigInt(bondBps(input.score))) / 10_000n
  return target < input.outstandingBaseUnits ? target : input.outstandingBaseUnits
}

/** What may actually be paid out right now: everything owed except the bond. */
export function payableBaseUnits(input: {
  lifetimeAccruedBaseUnits: bigint
  outstandingBaseUnits: bigint
  score: number
}): bigint {
  const held = rollingBondBaseUnits(input)
  const payable = input.outstandingBaseUnits - held
  return payable > 0n ? payable : 0n
}

/** The full answer a kiosk (or another machine) can show or publish. */
export function underwrite(rec: OperatorRecord, now: string) {
  const verdict = creditScore(rec, now)
  return {
    operator: rec.operator,
    ...verdict,
    requiredCollateralBps: requiredCollateralBps(verdict.score),
    /** Deliberately included: a score is only worth something if the reader
     *  can see how thin it is. */
    meteredEvents: rec.sales + rec.stockouts,
    concessions: rec.concessions,
  }
}
