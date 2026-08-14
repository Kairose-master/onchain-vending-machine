/**
 * The restock lane — the machine as REQUESTER.
 *
 * The three shipped archetypes all have the machine on the supply side: it
 * rents out control (slot lease), sells a design's output (recipe), or sells
 * its own capability (machine-labor bounties). This is the fourth
 * relationship and the one that closes the loop: the machine BUYS labor.
 *
 * A slot runs empty. The lessee is not in the room — that is the whole point
 * of leasing a slot in someone else's machine — so the machine posts a bounty
 * for someone who IS in the room to refill it, funded out of the lessee's own
 * accrued revenue. Owner owns and does not operate; lessee operates and is not
 * present; restocker is present and is neither. Nobody runs the business and
 * the business runs.
 *
 * Two rules this module exists to enforce:
 *
 * 1. THE BOUNTY IS FUNDED BY THE OPERATOR WHO BENEFITS. It comes out of the
 *    lessee's outstanding accrual, never the booth's till. An operator with
 *    nothing accrued cannot hire — correct, and said out loud rather than
 *    quietly subsidised, because a subsidised restock is the machine owner
 *    doing the lessee's job for free, which is the arrangement operatorship
 *    exists to end.
 *
 * 2. THE JOB SAYS IT NEEDS HANDS. Handsel's feed is read by remote software
 *    agents; a physical job that does not announce itself as physical wastes
 *    a claim and strands an escrow. The machine-labor lane solved the mirror
 *    of this by parsing before claiming; as the requester, the duty is to
 *    declare.
 */
import type { OperatorEvent } from './operator-credit'

/** Marker for the machine's own maintenance jobs. Deliberately NOT
 *  `[machine:plot]`: the booth's worker lane matches on that string, and a
 *  machine that claims its own restock bounty would be paying itself to
 *  promise work it cannot do. Pinned by a test. */
export const MACHINE_RESTOCK_MARKER = '[machine:restock]'

export type RestockUrgency = 'empty-with-demand' | 'empty' | 'low'

export interface RestockNeed {
  concessionId: string
  slotId: number
  name: string
  operator: string
  stock: number
  /** Payments already turned away for want of stock — the customers this
   *  slot has actually lost, not a forecast. */
  openStockouts: number
  urgency: RestockUrgency
  /** What the lessee's accrual can pay. '0' when nothing can be funded. */
  bountyBaseUnits: string
  fundable: boolean
  reason?: string
}

interface SlotLike {
  id: number
  name: string
  lessee: string
  stock: number
  accruedBaseUnits: string
  paidBaseUnits: string
}

export interface RestockOptions {
  /** At or below this stock level a slot is worth refilling early. */
  lowWaterMark: number
  /** Share of the operator's outstanding accrual offered as the bounty. */
  bountyBps: number
  /** Below this the bounty is not worth a stranger's walk; no job is posted. */
  minBountyBaseUnits: string
}

export const DEFAULT_RESTOCK_OPTIONS: RestockOptions = {
  lowWaterMark: 1,
  bountyBps: 3000,
  // 0.05 USDC at 6 decimals. Testnet money is a gift, but a bounty small
  // enough to insult is worse than no bounty.
  minBountyBaseUnits: '50000',
}

const outstanding = (s: SlotLike) => BigInt(s.accruedBaseUnits) - BigInt(s.paidBaseUnits)

/** Count of stockouts on a concession that no later restock has answered. */
export function openStockoutsFor(events: OperatorEvent[], concessionId: string): number {
  const ordered = [...events]
    .filter((e) => e.concessionId === concessionId && (e.kind === 'stockout' || e.kind === 'restock'))
    .sort((a, b) => a.at.localeCompare(b.at))
  let open = 0
  for (const e of ordered) {
    if (e.kind === 'stockout') open++
    else if (open > 0) open--
  }
  return open
}

/**
 * Which slots need hands, most urgent first.
 *
 * An empty slot that has already turned a paying customer away outranks an
 * empty slot nobody has tried — the first is losing money now, the second is
 * only capable of it.
 */
export function detectRestockNeeds(
  slots: SlotLike[],
  events: OperatorEvent[],
  opts: RestockOptions = DEFAULT_RESTOCK_OPTIONS,
): RestockNeed[] {
  const needs: RestockNeed[] = []

  for (const slot of slots) {
    if (slot.stock > opts.lowWaterMark) continue
    const concessionId = `slot:${slot.id}`
    const openStockouts = openStockoutsFor(events, concessionId)
    const urgency: RestockUrgency =
      slot.stock <= 0 ? (openStockouts > 0 ? 'empty-with-demand' : 'empty') : 'low'

    const pot = outstanding(slot)
    const offer = (pot * BigInt(opts.bountyBps)) / 10_000n
    const fundable = offer >= BigInt(opts.minBountyBaseUnits)

    needs.push({
      concessionId,
      slotId: slot.id,
      name: slot.name,
      operator: slot.lessee,
      stock: slot.stock,
      openStockouts,
      urgency,
      bountyBaseUnits: fundable ? offer.toString() : '0',
      fundable,
      ...(fundable
        ? {}
        : {
            reason:
              pot <= 0n
                ? `${slot.lessee} has no accrued revenue yet — a restock bounty would be the booth paying the lessee's costs`
                : `${offer} base units is under the ${opts.minBountyBaseUnits} minimum — not worth a stranger's trip`,
          }),
    })
  }

  const rank: Record<RestockUrgency, number> = { 'empty-with-demand': 0, empty: 1, low: 2 }
  return needs.sort((a, b) => rank[a.urgency] - rank[b.urgency] || b.openStockouts - a.openStockouts)
}

export interface RestockJobBody {
  title: string
  description: string
  acceptance_criteria: string
  min_score: number
}

const TITLE_MAX = 200

/**
 * The job as the market sees it.
 *
 * The description leads with the physical requirement and the location,
 * because a claimant who reads only the first two lines must still learn that
 * this cannot be done from a keyboard.
 */
export function buildRestockBounty(need: RestockNeed, ctx: { machineName: string; location: string }): RestockJobBody {
  const title = `${MACHINE_RESTOCK_MARKER} Refill slot ${need.slotId} ("${need.name}") — in person, ${ctx.location}`.slice(
    0,
    TITLE_MAX,
  )
  const demand =
    need.openStockouts > 0
      ? `${need.openStockouts} paying customer(s) have already been turned away and refunded.`
      : 'No customer has been turned away yet; the slot is simply out.'

  return {
    title,
    description:
      `PHYSICAL JOB — this requires being at the machine in person. A remote agent cannot do it; ` +
      `please do not claim it unless you can reach ${ctx.location}.\n\n` +
      `The dispenser "${ctx.machineName}" has an empty channel. Slot ${need.slotId} is leased by ` +
      `${need.operator} and holds "${need.name}"; current stock ${need.stock}. ${demand}\n\n` +
      `What to do: collect the restock items held for slot ${need.slotId} at the booth, load them into ` +
      `that slot's magazine (heaviest at the bottom, labels facing out), and register the new count at ` +
      `the kiosk's 슬롯 tab.\n\n` +
      `Funding: this bounty comes out of the lessee's own accrued revenue, not the machine owner's — ` +
      `the operator is paying to have their own concession kept running.`,
    acceptance_criteria:
      `The slot's registered stock is greater than zero after your visit, and the next paid dispense ` +
      `from slot ${need.slotId} succeeds. Evidence class is disclosed up front: the machine has no ` +
      `camera and no weight sensor, so the restock is recorded as SELF-REPORTED when you register the ` +
      `count, and upgraded to CONFIRMED-BY-SALE only when the machine actually dispenses from that ` +
      `slot — an empty magazine cannot sell. Do not claim a count you did not load; the confirmation ` +
      `is mechanical and it will disagree with you.`,
    min_score: 0,
  }
}

/**
 * Is a bounty for this slot already open on the market?
 *
 * Posting costs a fee and creates a public escrow, so a detector that fires
 * every tick would fill the feed with duplicates of one empty slot and pay
 * for each. Matched on the marker plus the slot number, both of which
 * `buildRestockBounty` puts in the title before any truncation point.
 */
export function hasOpenRestockBounty(openTitles: string[], slotId: number): boolean {
  return openTitles.some((t) => t.includes(MACHINE_RESTOCK_MARKER) && new RegExp(`\\bslot ${slotId}\\b`).test(t))
}

/**
 * The free evidence upgrade.
 *
 * A dispense from slot N is proof that slot N had stock, which is proof the
 * last claimed restock of slot N really happened. No sensor, no photo, no
 * trusted party: the machine doing its ordinary job is the attestation. Call
 * this on every successful slot sale.
 *
 * Upgrades the MOST RECENT self-reported restock on that concession and stops
 * — an old unverified restock is not made true by a sale that a later restock
 * paid for.
 */
export function upgradeRestockEvidence(events: OperatorEvent[], concessionId: string): OperatorEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.kind !== 'restock' || e.concessionId !== concessionId) continue
    if (e.evidence !== 'self-reported') return events // already at least confirmed
    const next = [...events]
    next[i] = { ...e, evidence: 'confirmed-by-sale' }
    return next
  }
  return events
}
