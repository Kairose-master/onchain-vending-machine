/**
 * Evidence-bounded physical authority.
 *
 * `concession.ts` has an ordinal evidence ladder — self-reported <
 * confirmed-by-sale < buyer-attested < instrumented — and that ladder was
 * always going to break, for the reason every one-dimensional trust score
 * breaks: it lets a strong dimension cover for a missing one. An IR gate at
 * the outlet is "instrumented" and therefore top of the ladder, even if it is
 * wired by the person who profits from what it reports and sees one slot out
 * of four.
 *
 * So the ladder stops deciding anything economic. `EvidenceClass` stays, as
 * the *label of one observation*; this module decides what an operator is
 * allowed to do, from a profile of the observation channel plus the money we
 * actually hold.
 *
 * The rule is the same one `lib/evidence-assurance.ts` enforces in the
 * handsel repo for disputes, and it is worth stating in the form that makes
 * both instances one theorem:
 *
 *   Evidence does not describe what happened. It bounds what may be done
 *   about what happened.
 *
 * ## Why the physical case is strictly weaker than the digital one
 *
 * In the digital lane, **reproducibility rescues a related-party issuer**: an
 * on-chain hash comparison reported by the platform is trustworthy because
 * anybody can recompute it, so who reported it stops mattering.
 *
 * There is no physical analogue. A dispense happens once, in a corridor in
 * Beijing, and is then gone; no third party can re-run it. Physical evidence
 * therefore has **reproducibility 0 by construction** — not by our laziness —
 * and cannot use the digital lane's escape hatch. Its only defences are
 * independence (who observed it, relative to who profits) and coverage (what
 * fraction of events the channel even sees).
 *
 * That asymmetry is the reason physical operatorship gets a lower ceiling than
 * an equally well-run digital job, and it is a fact about physical space
 * rather than a decision we made.
 *
 * ## Why there are no dollar constants in this file
 *
 * The obvious design is a table — E1 → $20 exposure, E4 → $500. Those numbers
 * would be invented, printed on a page, and indistinguishable from measured
 * ones. Instead the ceiling is **money we are actually holding right now**:
 * the operator's posted bond and their earnings not yet released. It is a live
 * quantity, and the limit moves when the holdings move.
 *
 * Evidence enters at exactly one place, and it is not the size of the number:
 * it decides whether the bond is **slashable at all**. You cannot take a bond
 * for a loss you cannot prove the operator caused — that is a remedy on an
 * assertion, which is the thing the whole evidence apparatus exists to refuse.
 * Withholding is different from slashing and needs no proof of fault, only the
 * absence of proof of performance, so it survives at every class.
 */

import type { EvidenceClass } from './concession'

/** 0 = absent, 3 = as good as this dimension gets in the physical world. */
export type Score = 0 | 1 | 2 | 3

export interface EvidenceProfile {
  /**
   * How far the observer is from whoever profits from the observation.
   * 0 = the beneficiary says so. 1 = the machine says so and the machine's
   * owner is the beneficiary. 2 = the machine says so and its owner is not a
   * party to this claim. 3 = the buyer, or a third party with no stake.
   *
   * Note that the booth's own telemetry is a **1** for a slot lease where the
   * machine owner also takes a cut, and a **2** for one where they do not.
   * Same sensor, different independence — which an ordinal ladder cannot say.
   */
  independence: Score
  /**
   * Can a third party derive the same conclusion later from durable inputs?
   * In the physical lane this is 0 unless the event left something recomputable
   * behind (an on-chain payment, a signed weight delta). It is never 3.
   */
  reproducibility: Score
  /** Cost and difficulty of altering the record after the fact. */
  tamperResistance: Score
  /**
   * What fraction of the events this claim covers does the channel observe?
   * 0 = none of them (a sensor on one slot, a claim about four). A 0 here
   * collapses everything, because a channel that cannot see the event cannot
   * witness it however trustworthy it would be if it could.
   */
  observationCoverage: Score
  /**
   * What it costs to manufacture a false *positive* — to make the channel
   * report an event that did not happen. High is good. A button is 0. An IR
   * gate you must physically interrupt is 1 (wave a hand). A weight cell plus
   * a completed payment is higher, because the fake costs money.
   */
  fabricationCost: Score
}

/** Same labels as the digital lane, deliberately: one theorem, two domains. */
export type EvidenceClass5 = 'E0' | 'E1' | 'E2' | 'E3' | 'E4'

const CLASS_ORDER: EvidenceClass5[] = ['E0', 'E1', 'E2', 'E3', 'E4']
export const classRank = (c: EvidenceClass5) => CLASS_ORDER.indexOf(c)
const capAt = (c: EvidenceClass5, ceiling: EvidenceClass5) =>
  classRank(c) > classRank(ceiling) ? ceiling : c

/**
 * The class an observation channel can support.
 *
 * `E4` is unreachable in this module and that is intentional — it is reserved
 * for reproducible evidence, which physical events do not have. A physical
 * channel tops out at `E3`: independently observed, tamper-resistant, covering
 * the events it speaks about, and expensive to fake. Leaving E4 defined but
 * unreachable keeps the two lanes comparable instead of quietly renumbering
 * the physical one to make it look stronger.
 */
export function compilePhysicalClass(p: EvidenceProfile): EvidenceClass5 {
  let cls: EvidenceClass5
  if (p.independence >= 2 && p.observationCoverage >= 2 && (p.tamperResistance >= 2 || p.fabricationCost >= 2)) {
    cls = 'E3'
  } else if (p.observationCoverage >= 2 && (p.independence >= 1 || p.tamperResistance >= 2)) {
    cls = 'E2'
  } else if (p.observationCoverage >= 1 || p.tamperResistance >= 1) {
    cls = 'E1'
  } else {
    cls = 'E0'
  }

  // A channel that observes nothing witnesses nothing.
  if (p.observationCoverage === 0) cls = capAt(cls, 'E0')

  // A free fake caps the channel regardless of everything else: if the
  // beneficiary can produce the signal at zero cost, the signal is their word.
  if (p.fabricationCost === 0) cls = capAt(cls, 'E1')

  // Reproducibility is the only thing that lets a related party attest to its
  // own benefit, and the physical lane does not have it.
  if (p.reproducibility < 3 && p.independence <= 1) cls = capAt(cls, 'E2')

  return cls
}

/** The one class question that matters: may a bond be taken on this evidence? */
export const MIN_CLASS_FOR_SLASHING: EvidenceClass5 = 'E3'
export const MIN_CLASS_FOR_THIRD_PARTY_CAPITAL: EvidenceClass5 = 'E3'
export const MIN_CLASS_FOR_INSTANT_PAYOUT: EvidenceClass5 = 'E3'

export const meetsClass = (actual: EvidenceClass5, required: EvidenceClass5) =>
  classRank(actual) >= classRank(required)

/** Money we are holding, in USD. Both fields are live balances, not policy. */
export interface Holdings {
  /** Bond the operator posted, or that has been withheld from their earnings. */
  bondUsd: number
  /** Earnings credited to them and not yet released. */
  withheldEarningsUsd: number
}

export interface AuthorityCeiling {
  evidenceClass: EvidenceClass5
  /**
   * The most we can actually recover if this operator's policy loses money.
   * Withheld earnings always count — declining to release money needs no proof
   * of fault. The bond counts only when the evidence could support taking it.
   */
  enforceableCeilingUsd: number
  bondIsSlashable: boolean
  /** May inventory be financed by a third party against this operator? */
  thirdPartyCapital: boolean
  /** May they be paid before the sale is independently observed? */
  instantPayout: boolean
  /** Why, in the order the rules applied. An operator told "denied" with no
   *  reason cannot fix the sensor that would fix the answer. */
  basis: string[]
}

export function authorityCeiling(p: EvidenceProfile, h: Holdings): AuthorityCeiling {
  const evidenceClass = compilePhysicalClass(p)
  const basis: string[] = [`evidence channel compiles to ${evidenceClass}`]

  const bondIsSlashable = meetsClass(evidenceClass, MIN_CLASS_FOR_SLASHING)
  basis.push(
    bondIsSlashable
      ? `bond is slashable (${evidenceClass} ≥ ${MIN_CLASS_FOR_SLASHING})`
      : `bond is NOT slashable below ${MIN_CLASS_FOR_SLASHING} — a loss we cannot prove is not a loss we may charge for`,
  )

  const enforceableCeilingUsd =
    round2(h.withheldEarningsUsd + (bondIsSlashable ? h.bondUsd : 0))
  basis.push(
    bondIsSlashable
      ? `enforceable ceiling = withheld ${fmt(h.withheldEarningsUsd)} + bond ${fmt(h.bondUsd)} = ${fmt(enforceableCeilingUsd)}`
      : `enforceable ceiling = withheld earnings only, ${fmt(enforceableCeilingUsd)} (bond ${fmt(h.bondUsd)} is held but not chargeable)`,
  )

  const thirdPartyCapital = meetsClass(evidenceClass, MIN_CLASS_FOR_THIRD_PARTY_CAPITAL)
  if (!thirdPartyCapital) {
    basis.push(
      `third-party inventory capital refused: a lender's loss must be provable to be remediable, and ${evidenceClass} cannot prove it`,
    )
  }

  const instantPayout = meetsClass(evidenceClass, MIN_CLASS_FOR_INSTANT_PAYOUT)
  if (!instantPayout) {
    basis.push(`payout stays deferred: releasing money is irreversible and ${evidenceClass} is not enough to trigger it`)
  }

  return { evidenceClass, enforceableCeilingUsd, bondIsSlashable, thirdPartyCapital, instantPayout, basis }
}

export type AuthorityVerdict =
  | { allowed: true; ceiling: AuthorityCeiling; headroomUsd: number }
  | { allowed: false; ceiling: AuthorityCeiling; shortfallUsd: number; reason: string }

/**
 * The whole decision, in the shape the coordination layer uses for agents:
 *
 *   worstCaseExposure > enforceableCeiling  →  DENY
 *
 * Not "charge a bigger bond". If the worst case exceeds what we can recover,
 * the answer is that this operator does not get this much authority yet —
 * pricing does not fix an unbounded loss, and a bond that is not slashable
 * does not bound anything at all.
 */
export function permitOperation(input: {
  profile: EvidenceProfile
  holdings: Holdings
  /** Credible worst case if the operator's policy is wrong: unsold inventory
   *  at cost, plus anything already released against unobserved events. */
  worstCaseExposureUsd: number
  /** Is the inventory someone else's money? */
  financedByThirdParty?: boolean
}): AuthorityVerdict {
  const ceiling = authorityCeiling(input.profile, input.holdings)

  if (input.financedByThirdParty && !ceiling.thirdPartyCapital) {
    return {
      allowed: false,
      ceiling,
      shortfallUsd: round2(input.worstCaseExposureUsd),
      reason: `inventory is financed by a third party, which needs ${MIN_CLASS_FOR_THIRD_PARTY_CAPITAL} evidence; this channel is ${ceiling.evidenceClass}`,
    }
  }

  const shortfall = round2(input.worstCaseExposureUsd - ceiling.enforceableCeilingUsd)
  if (shortfall > 0) {
    return {
      allowed: false,
      ceiling,
      shortfallUsd: shortfall,
      reason: `worst case ${fmt(input.worstCaseExposureUsd)} exceeds the enforceable ceiling ${fmt(ceiling.enforceableCeilingUsd)} by ${fmt(shortfall)}`,
    }
  }

  return { allowed: true, ceiling, headroomUsd: round2(-shortfall) }
}

/**
 * The booth's channels, as they actually are today — profiled, not flattered.
 *
 * `confirmed-by-sale` is the interesting one. On the ordinal ladder it sat
 * second of four and read like a compromise. Profiled, it is the booth's
 * *best* channel: a dispense that a paying stranger triggered cannot be
 * manufactured for free, and the payment leg is on-chain, which is the one
 * genuinely recomputable thing in the whole physical lane. It still fails
 * independence, because the machine reporting it is the machine whose owner
 * takes a cut.
 */
export const BOOTH_CHANNELS: Record<EvidenceClass, EvidenceProfile> = {
  'self-reported': {
    independence: 0,
    reproducibility: 0,
    tamperResistance: 0,
    observationCoverage: 1,
    fabricationCost: 0,
  },
  'confirmed-by-sale': {
    independence: 1,
    reproducibility: 1,
    tamperResistance: 2,
    observationCoverage: 2,
    fabricationCost: 2,
  },
  'buyer-attested': {
    independence: 3,
    reproducibility: 0,
    tamperResistance: 1,
    observationCoverage: 1,
    fabricationCost: 2,
  },
  /** NOT WIRED. Profiled as it would be if installed by the machine owner on
   *  every slot: sees everything, hard to tamper with, and still theirs. */
  instrumented: {
    independence: 1,
    reproducibility: 0,
    tamperResistance: 3,
    observationCoverage: 3,
    fabricationCost: 1,
  },
}

/**
 * What the ordinal ladder got wrong, as data rather than as an argument.
 * Kept as an export so the claim is checkable and so a future channel change
 * has to face it.
 */
export function boothChannelClasses(): Record<EvidenceClass, EvidenceClass5> {
  return {
    'self-reported': compilePhysicalClass(BOOTH_CHANNELS['self-reported']),
    'confirmed-by-sale': compilePhysicalClass(BOOTH_CHANNELS['confirmed-by-sale']),
    'buyer-attested': compilePhysicalClass(BOOTH_CHANNELS['buyer-attested']),
    instrumented: compilePhysicalClass(BOOTH_CHANNELS.instrumented),
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100
const fmt = (n: number) => `$${round2(n).toFixed(2)}`
