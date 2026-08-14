import { describe, expect, it } from 'vitest'
import {
  classifyOperatorship,
  concessionFromMachineBounty,
  concessionFromRecipe,
  concessionFromSlot,
  describeConcession,
  evidenceRank,
  strongerEvidence,
  type OperatorshipConditions,
} from '../src/concession'

const ALL_FOUR: OperatorshipConditions = {
  policyDiscretion: true,
  residualClaim: true,
  downside: true,
  nonOwnership: true,
}

describe('the four conditions, as a function instead of a table', () => {
  it('all four present is operatorship', () => {
    expect(classifyOperatorship(ALL_FOUR).verdict).toBe('operatorship')
  })

  it('each missing condition degenerates into its named thing', () => {
    expect(classifyOperatorship({ ...ALL_FOUR, policyDiscretion: false }).verdict).toBe('depin-supply')
    expect(classifyOperatorship({ ...ALL_FOUR, residualClaim: false }).verdict).toBe('labor')
    expect(classifyOperatorship({ ...ALL_FOUR, downside: false }).verdict).toBe('free-option')
    expect(classifyOperatorship({ ...ALL_FOUR, nonOwnership: false }).verdict).toBe('small-business')
  })

  it('owning the asset wins over every other missing condition', () => {
    // Whatever else is absent, it is your machine — that is not a concession
    // with a defect, it is a different arrangement.
    const owned = { policyDiscretion: false, residualClaim: false, downside: false, nonOwnership: false }
    expect(classifyOperatorship(owned).verdict).toBe('small-business')
  })

  it('a free option is called out before the softer defects', () => {
    // Nothing at risk is the failure that ruins a market quietly, so it must
    // not be masked by also lacking policy discretion.
    const nothingAtRisk = { ...ALL_FOUR, downside: false, policyDiscretion: false }
    expect(classifyOperatorship(nothingAtRisk).verdict).toBe('free-option')
  })

  it('every verdict explains itself — a refusal with no reason is unusable', () => {
    for (const missing of ['policyDiscretion', 'residualClaim', 'downside', 'nonOwnership'] as const) {
      const { reason } = classifyOperatorship({ ...ALL_FOUR, [missing]: false })
      expect(reason.length).toBeGreaterThan(20)
    }
  })
})

describe('projections from the canonical stores', () => {
  const slot = {
    id: 3,
    name: '스티커팩',
    lessee: '민수',
    lesseeWallet: '0x' + '1'.repeat(40),
    sales: 7,
    createdAt: '2026-08-01T00:00:00.000Z',
  }
  const recipe = {
    id: 'ab12',
    name: '백척간두',
    author: '지연',
    authorWallet: '',
    sales: 2,
    createdAt: '2026-08-02T00:00:00.000Z',
  }

  it('a leased slot is the canonical operator market — all four conditions', () => {
    const c = concessionFromSlot(slot, { machineName: 'booth-1', lesseeBps: 8000 })
    expect(classifyOperatorship(c.conditions).verdict).toBe('operatorship')
    expect(c.meter).toEqual({ unit: 'dispense', count: 7 })
    expect(c.operator).toBe('민수')
  })

  it('a registered recipe is honestly NOT operatorship — nothing is at risk', () => {
    // The thesis says the physical app market fails the downside condition.
    // If this ever returns 'operatorship', either the lane grew a bond or the
    // taxonomy drifted; both should fail a test rather than pass quietly.
    const c = concessionFromRecipe(recipe, { machineName: 'booth-1', authorBps: 7000 })
    expect(c.conditions.downside).toBe(false)
    expect(classifyOperatorship(c.conditions).verdict).toBe('free-option')
  })

  it('the machine-labor lane classifies its own owner as a worker, not an entrepreneur', () => {
    const c = concessionFromMachineBounty({
      machineName: 'booth-1',
      ownerName: 'operator',
      jobsDone: 4,
      since: '2026-08-01T00:00:00.000Z',
    })
    expect(classifyOperatorship(c.conditions).verdict).toBe('small-business')
  })

  it('projections carry a stable id keyed to the canonical record', () => {
    expect(concessionFromSlot(slot, { machineName: 'b', lesseeBps: 8000 }).id).toBe('slot:3')
    expect(concessionFromRecipe(recipe, { machineName: 'b', authorBps: 7000 }).id).toBe('recipe:ab12')
  })

  it('the one-line description names the verdict and the evidence class', () => {
    const line = describeConcession(concessionFromSlot(slot, { machineName: 'booth-1', lesseeBps: 8000 }))
    expect(line).toContain('operatorship')
    expect(line).toContain('self-reported')
    expect(line).toContain('80%')
  })
})

describe('evidence classes', () => {
  it('are ordered weakest to strongest', () => {
    expect(evidenceRank('self-reported')).toBeLessThan(evidenceRank('confirmed-by-sale'))
    expect(evidenceRank('confirmed-by-sale')).toBeLessThan(evidenceRank('buyer-attested'))
    expect(evidenceRank('buyer-attested')).toBeLessThan(evidenceRank('instrumented'))
  })

  it('merging never weakens a claim', () => {
    expect(strongerEvidence('self-reported', 'instrumented')).toBe('instrumented')
    expect(strongerEvidence('instrumented', 'self-reported')).toBe('instrumented')
    expect(strongerEvidence('self-reported', 'self-reported')).toBe('self-reported')
  })

  it('the dispenser is honest that it has no sensor at the outlet', () => {
    const c = concessionFromSlot(
      { id: 1, name: 'x', lessee: 'y', lesseeWallet: '', sales: 0, createdAt: '2026-08-01T00:00:00.000Z' },
      { machineName: 'b', lesseeBps: 8000 },
    )
    expect(c.evidence).toBe('self-reported')
  })
})
