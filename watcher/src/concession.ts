/**
 * Concession — the one object underneath all three operatorship archetypes.
 *
 * The booth grew three lanes independently (recipe market, slot market,
 * machine labor) and they turned out to be the same shape with different
 * meters: a time-boxed, revocable, metered right to direct one physical
 * capability, with a settlement rail attached. Naming that shape is what
 * lets the fourth, fifth and sixth lanes be configuration instead of code —
 * a shelf in a fridge, an hour of a 3D printer, a locker, a bay.
 *
 * PROJECTION, NOT REPLACEMENT. `Slot` and `Recipe` stay canonical: they are
 * what is validated, stored and paid from. A Concession is derived from them
 * on demand, exactly the way handsel's DSL/DMN/BPMN layers are projections of
 * canonical JSON (handsel CLAUDE.md, "JSON stays canonical"). Deriving keeps
 * one source of truth; replacing would have meant rewriting two shipped,
 * tested money paths for a vocabulary win.
 *
 * The classifier at the bottom is the interesting half. `docs/
 * physical-operatorship.md` defines operatorship by four conditions and lists
 * what each missing one degenerates into. That table was prose; here it is a
 * function, so the booth can answer "is this actually operatorship?" about its
 * own lanes and be wrong out loud rather than by assumption.
 */

export type ConcessionKind = 'slot-lease' | 'recipe' | 'machine-bounty'

/**
 * How well the physical event underneath a settlement can be shown to have
 * happened. Ordered weakest → strongest; the booth today tops out at
 * `confirmed-by-sale`, and says so.
 *
 * - `self-reported`: somebody pressed a button claiming it happened.
 * - `confirmed-by-sale`: the machine subsequently DID its job from that
 *   stock — a restock proven retroactively by a dispense that could not have
 *   happened against an empty magazine. Free: no sensor, just bookkeeping.
 * - `buyer-attested`: the person who paid confirmed receipt.
 * - `instrumented`: the machine's own sensor saw the event (an IR gate at the
 *   outlet is the cheapest one that counts). NOT WIRED YET — declared here so
 *   the ordering exists before the hardware does.
 */
export type EvidenceClass = 'self-reported' | 'confirmed-by-sale' | 'buyer-attested' | 'instrumented'

export const EVIDENCE_ORDER: EvidenceClass[] = [
  'self-reported',
  'confirmed-by-sale',
  'buyer-attested',
  'instrumented',
]

export function evidenceRank(e: EvidenceClass): number {
  return EVIDENCE_ORDER.indexOf(e)
}

/** The stronger of two evidence classes — a claim never weakens on merge. */
export function strongerEvidence(a: EvidenceClass, b: EvidenceClass): EvidenceClass {
  return evidenceRank(a) >= evidenceRank(b) ? a : b
}

export interface Concession {
  /** Stable across the concession's life: `slot:3`, `recipe:ab12`. */
  id: string
  kind: ConcessionKind
  /** The physical thing being directed, as a human would point at it. */
  asset: string
  capability: string
  operator: string
  /** Where the operator's residual is paid; '' = accrue-only. */
  operatorWallet: string
  window: { from: string; to: string | null }
  /** What is counted, and how much of it has been counted so far. */
  meter: { unit: string; count: number }
  /** Exactly which decisions belong to the operator, not the machine owner. */
  policySurface: string[]
  /** The operator's share of each unit, in bps. */
  revenueSplitBps: number
  /** How it ends, in words — a revocable right nobody can describe is not
   *  revocable in practice. */
  revocation: string
  evidence: EvidenceClass
  conditions: OperatorshipConditions
}

/**
 * The four conditions from the thesis. Booleans, because the interesting
 * cases are the ones where a condition is missing — and a score would let a
 * missing condition be averaged away by three present ones.
 */
export interface OperatorshipConditions {
  /** Does the holder set policy (price, selection, design), or just supply capacity? */
  policyDiscretion: boolean
  /** Do they take the residual — upside after costs — rather than a fixed fee? */
  residualClaim: boolean
  /** Is their own capital at risk if it goes badly? */
  downside: boolean
  /** Is the asset someone else's? */
  nonOwnership: boolean
}

export type OperatorshipVerdict =
  | 'operatorship'
  /** Capacity supplied under someone else's policy — classic DePIN. */
  | 'depin-supply'
  /** Paid for effort, not for outcome. A worker, honestly named. */
  | 'labor'
  /** A free option on someone else's machine: nothing at risk, so nothing
   *  filters the entries. */
  | 'free-option'
  /** They own the thing. That is an ordinary small business, not a concession. */
  | 'small-business'

export interface Classification {
  verdict: OperatorshipVerdict
  /** Why — names the missing condition, so a lane that thinks it is an
   *  operator market and is not gets told which piece it lacks. */
  reason: string
}

/**
 * The degeneration table as a function.
 *
 * Order matters and is deliberate: non-ownership is checked FIRST because
 * owning the asset takes the arrangement out of the concession frame entirely
 * (whatever else is true, it is your machine and your business). After that,
 * downside is checked before the other two, because a free option is the
 * failure mode that quietly ruins a market — an operator with nothing at risk
 * costs nothing to be wrong, so bad entries never get filtered out.
 */
export function classifyOperatorship(c: OperatorshipConditions): Classification {
  if (!c.nonOwnership) {
    return { verdict: 'small-business', reason: 'the holder owns the asset — an ordinary business, not a concession' }
  }
  if (!c.downside) {
    return { verdict: 'free-option', reason: 'no capital at risk — nothing filters who takes the slot' }
  }
  if (!c.residualClaim) {
    return { verdict: 'labor', reason: 'paid a fee for effort rather than the residual — this holder is a worker' }
  }
  if (!c.policyDiscretion) {
    return { verdict: 'depin-supply', reason: 'supplies capacity under someone else’s policy — DePIN supply, not operatorship' }
  }
  return { verdict: 'operatorship', reason: 'policy discretion + residual claim + downside + non-ownership' }
}

// ---------------------------------------------------------------------------
// Projections from the canonical stores
// ---------------------------------------------------------------------------

/** Shapes the projections read. Structural, not imported, so this module
 *  stays pure and free of the persistence layer's types. */
interface SlotLike {
  id: number
  name: string
  lessee: string
  lesseeWallet: string
  sales: number
  createdAt: string
}

interface RecipeLike {
  id: string
  name: string
  author: string
  authorWallet: string
  sales: number
  createdAt: string
}

export function concessionFromSlot(slot: SlotLike, ctx: { machineName: string; lesseeBps: number }): Concession {
  return {
    id: `slot:${slot.id}`,
    kind: 'slot-lease',
    asset: `${ctx.machineName} · dispenser channel ${slot.id}`,
    capability: 'dispense one item on payment',
    operator: slot.lessee,
    operatorWallet: slot.lesseeWallet,
    window: { from: slot.createdAt, to: null },
    meter: { unit: 'dispense', count: slot.sales },
    policySurface: ['what to stock', 'price', 'restock cadence', 'product name'],
    revenueSplitBps: ctx.lesseeBps,
    revocation: 'open-ended; the machine owner can end the lease, and stock left in the magazine returns to the lessee',
    // No sensor at the outlet yet: the machine knows it commanded a dispense,
    // not that an item crossed the gate.
    evidence: 'self-reported',
    conditions: {
      policyDiscretion: true,
      residualClaim: true,
      // The inventory sitting in the magazine IS the capital at risk. This is
      // the condition the recipe market cannot meet, and why the slot is the
      // canonical case.
      downside: true,
      nonOwnership: true,
    },
  }
}

export function concessionFromRecipe(recipe: RecipeLike, ctx: { machineName: string; authorBps: number }): Concession {
  return {
    id: `recipe:${recipe.id}`,
    kind: 'recipe',
    asset: `${ctx.machineName} · pen plotter`,
    capability: 'draw one registered design on payment',
    operator: recipe.author,
    operatorWallet: recipe.authorWallet,
    window: { from: recipe.createdAt, to: null },
    meter: { unit: 'plot', count: recipe.sales },
    policySurface: ['the design itself'],
    revenueSplitBps: ctx.authorBps,
    revocation: 'open-ended; the booth can delist a design, and past royalties already accrued stay owed',
    // The plotter's own G-code and stroke stats are the record — the machine
    // performed the work, so the machine knows what it did.
    evidence: 'confirmed-by-sale',
    conditions: {
      policyDiscretion: true,
      residualClaim: true,
      // Registering a design costs nothing and risks nothing. Named honestly:
      // this lane is a free option, which is exactly why it needs the booth's
      // real-pipeline validation at registration instead of a bond.
      downside: false,
      nonOwnership: true,
    },
  }
}

/**
 * The inverse case: the machine sells its own capability into the market.
 *
 * The holder here is the MACHINE OWNER, and the classifier is expected to
 * return `small-business` — that is not a bug being tolerated, it is the
 * thesis's own claim that a physical oracle's machine owner is a worker
 * rather than an entrepreneur. Encoding it means the taxonomy can be checked
 * instead of asserted.
 */
export function concessionFromMachineBounty(ctx: {
  machineName: string
  ownerName: string
  jobsDone: number
  since: string
}): Concession {
  return {
    id: 'machine:plot-bounties',
    kind: 'machine-bounty',
    asset: `${ctx.machineName} · pen plotter`,
    capability: 'perform externally posted plot bounties',
    operator: ctx.ownerName,
    operatorWallet: '',
    window: { from: ctx.since, to: null },
    meter: { unit: 'bounty', count: ctx.jobsDone },
    policySurface: ['which bounties to accept'],
    revenueSplitBps: 10_000,
    revocation: 'switch the lane off (MACHINE_WORKER=0); claimed jobs still have to be delivered or abandoned openly',
    evidence: 'confirmed-by-sale',
    conditions: {
      policyDiscretion: true,
      residualClaim: true,
      // A claimed-and-abandoned bounty slashes the worker bond upstream.
      downside: true,
      // The machine is the owner's own.
      nonOwnership: false,
    },
  }
}

/** One line a human can read on the kiosk or in a log. */
export function describeConcession(c: Concession): string {
  const { verdict } = classifyOperatorship(c.conditions)
  const split = `${(c.revenueSplitBps / 100).toFixed(0)}%`
  return `${c.id} — ${c.operator} directs "${c.capability}" on ${c.asset}; ${split} of each ${c.meter.unit}, ${c.meter.count} so far [${verdict}, evidence: ${c.evidence}]`
}
