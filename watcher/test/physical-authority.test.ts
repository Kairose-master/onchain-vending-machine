import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  authorityCeiling,
  BOOTH_CHANNELS,
  boothChannelClasses,
  compilePhysicalClass,
  MIN_CLASS_FOR_SLASHING,
  permitOperation,
  type EvidenceProfile,
} from '../src/physical-authority'

const profile = (p: Partial<EvidenceProfile>): EvidenceProfile => ({
  independence: 0,
  reproducibility: 0,
  tamperResistance: 0,
  observationCoverage: 0,
  fabricationCost: 0,
  ...p,
})

describe('compilePhysicalClass', () => {
  it('collapses to E0 when the channel observes nothing, however good it otherwise is', () => {
    const blind = profile({ independence: 3, tamperResistance: 3, fabricationCost: 3, observationCoverage: 0 })
    expect(compilePhysicalClass(blind)).toBe('E0')
  })

  it('caps at E1 when a false positive is free, however well observed', () => {
    const button = profile({ independence: 3, tamperResistance: 3, observationCoverage: 3, fabricationCost: 0 })
    expect(compilePhysicalClass(button)).toBe('E1')
  })

  it('caps a related-party channel at E2 because physical events are not reproducible', () => {
    const ownersSensor = profile({
      independence: 1,
      reproducibility: 2,
      tamperResistance: 3,
      observationCoverage: 3,
      fabricationCost: 3,
    })
    expect(compilePhysicalClass(ownersSensor)).toBe('E2')
  })

  it('reaches E3 only when the observer is independent AND covers the events', () => {
    const independent = profile({
      independence: 2,
      tamperResistance: 2,
      observationCoverage: 2,
      fabricationCost: 2,
    })
    expect(compilePhysicalClass(independent)).toBe('E3')

    // Same channel, one slot out of four: coverage 1 is not enough.
    expect(compilePhysicalClass({ ...independent, observationCoverage: 1 })).toBe('E1')
  })

  it('never reaches E4 — that class is reserved for reproducible evidence', () => {
    const best = profile({
      independence: 3,
      reproducibility: 2,
      tamperResistance: 3,
      observationCoverage: 3,
      fabricationCost: 3,
    })
    expect(compilePhysicalClass(best)).toBe('E3')
  })
})

describe('the booth as it is actually built', () => {
  const classes = boothChannelClasses()

  it('tops out at E2 on every channel, including the unbuilt sensor', () => {
    expect(classes).toEqual({
      'self-reported': 'E1',
      'confirmed-by-sale': 'E2',
      'buyer-attested': 'E1',
      instrumented: 'E2',
    })
  })

  it('reorders the ordinal ladder: confirmed-by-sale beats buyer-attested', () => {
    // On the ladder in concession.ts, buyer-attested outranks confirmed-by-sale.
    // Profiled, buyer attestation covers only the buyers who bother, and
    // coverage is the dimension nothing else substitutes for.
    expect(classes['confirmed-by-sale']).toBe('E2')
    expect(classes['buyer-attested']).toBe('E1')
  })

  it('means an owner-installed IR gate alone would not unlock financed inventory', () => {
    const verdict = permitOperation({
      profile: BOOTH_CHANNELS.instrumented,
      holdings: { bondUsd: 50, withheldEarningsUsd: 20 },
      worstCaseExposureUsd: 40,
      financedByThirdParty: true,
    })
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toContain('financed by a third party')
  })
})

describe('authorityCeiling', () => {
  const weak = BOOTH_CHANNELS['confirmed-by-sale'] // E2
  const strong = profile({ independence: 2, tamperResistance: 2, observationCoverage: 2, fabricationCost: 2 }) // E3

  it('excludes the bond from the ceiling when the evidence cannot support taking it', () => {
    const c = authorityCeiling(weak, { bondUsd: 80, withheldEarningsUsd: 15 })
    expect(c.evidenceClass).toBe('E2')
    expect(c.bondIsSlashable).toBe(false)
    expect(c.enforceableCeilingUsd).toBe(15)
    expect(c.basis.join(' ')).toContain('not chargeable')
  })

  it('counts withheld earnings at every class — withholding is not slashing', () => {
    const c = authorityCeiling(profile({}), { bondUsd: 80, withheldEarningsUsd: 15 })
    expect(c.evidenceClass).toBe('E0')
    expect(c.enforceableCeilingUsd).toBe(15)
  })

  it('adds the bond once the class supports slashing', () => {
    const c = authorityCeiling(strong, { bondUsd: 80, withheldEarningsUsd: 15 })
    expect(c.bondIsSlashable).toBe(true)
    expect(c.enforceableCeilingUsd).toBe(95)
    expect(c.thirdPartyCapital).toBe(true)
    expect(c.instantPayout).toBe(true)
  })

  it('always explains itself', () => {
    const c = authorityCeiling(weak, { bondUsd: 80, withheldEarningsUsd: 15 })
    expect(c.basis.length).toBeGreaterThanOrEqual(3)
    expect(c.basis[0]).toContain('E2')
  })
})

describe('permitOperation', () => {
  const strong = profile({ independence: 2, tamperResistance: 2, observationCoverage: 2, fabricationCost: 2 })

  it('denies when the worst case exceeds what we can recover', () => {
    const v = permitOperation({
      profile: BOOTH_CHANNELS['confirmed-by-sale'],
      holdings: { bondUsd: 80, withheldEarningsUsd: 10 },
      worstCaseExposureUsd: 40,
    })
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.shortfallUsd).toBe(30) // 40 − 10 withheld; the $80 bond does not count
      expect(v.reason).toContain('exceeds the enforceable ceiling')
    }
  })

  it('allows the same operation when the same holdings become chargeable', () => {
    const v = permitOperation({
      profile: strong,
      holdings: { bondUsd: 80, withheldEarningsUsd: 10 },
      worstCaseExposureUsd: 40,
    })
    expect(v.allowed).toBe(true)
    if (v.allowed) expect(v.headroomUsd).toBe(50)
  })

  it('allows a small exposure on weak evidence — the limit is the money, not the class', () => {
    const v = permitOperation({
      profile: BOOTH_CHANNELS['self-reported'],
      holdings: { bondUsd: 0, withheldEarningsUsd: 12 },
      worstCaseExposureUsd: 12,
    })
    expect(v.allowed).toBe(true)
  })

  it('refuses third-party capital before it even looks at the numbers', () => {
    const v = permitOperation({
      profile: BOOTH_CHANNELS['confirmed-by-sale'],
      holdings: { bondUsd: 1_000_000, withheldEarningsUsd: 1_000_000 },
      worstCaseExposureUsd: 1,
      financedByThirdParty: true,
    })
    expect(v.allowed).toBe(false)
    if (!v.allowed) expect(v.reason).toContain('E2')
  })
})

describe('the module states its own limits rather than hiding them', () => {
  const src = readFileSync(new URL('../src/physical-authority.ts', import.meta.url), 'utf8')

  it('contains no dollar constants — every limit comes from live holdings', () => {
    // A `$20 exposure at E1` table would be an invented number on a page.
    const body = src.slice(src.indexOf('export type Score'))
    expect(body).not.toMatch(/=\s*\d+(_\d+)*\s*\/\/.*usd/i)
    expect(body).not.toMatch(/(MAX|CAP|LIMIT)_[A-Z_]*USD\s*=/)
  })

  it('says out loud that physical evidence cannot be reproducible', () => {
    expect(src).toMatch(/reproducibility 0 by construction/)
  })

  it('keeps the slashing threshold at E3', () => {
    expect(MIN_CLASS_FOR_SLASHING).toBe('E3')
  })
})
