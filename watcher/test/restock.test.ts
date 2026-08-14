import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RESTOCK_OPTIONS,
  MACHINE_RESTOCK_MARKER,
  buildRestockBounty,
  detectRestockNeeds,
  hasOpenRestockBounty,
  openStockoutsFor,
  upgradeRestockEvidence,
} from '../src/restock'
import { isMachineBounty } from '../src/handsel/protocol'
import { summarize, type OperatorEvent } from '../src/operator-credit'

const slot = (over: Partial<Parameters<typeof detectRestockNeeds>[0][number]> = {}) => ({
  id: 3,
  name: '스티커팩',
  lessee: '민수',
  stock: 0,
  accruedBaseUnits: '1000000', // 1 USDC accrued
  paidBaseUnits: '0',
  ...over,
})

const at = (n: number) => `2026-08-${String(n).padStart(2, '0')}T00:00:00.000Z`
const ev = (kind: 'stockout' | 'restock', n: number, evidence: 'self-reported' | 'confirmed-by-sale' = 'self-reported'): OperatorEvent =>
  kind === 'stockout'
    ? { kind, at: at(n), concessionId: 'slot:3', operator: '민수' }
    : { kind, at: at(n), concessionId: 'slot:3', operator: '민수', units: 5, evidence }

describe('detectRestockNeeds', () => {
  it('ignores a well-stocked slot', () => {
    expect(detectRestockNeeds([slot({ stock: 9 })], [])).toEqual([])
  })

  it('an empty slot that already lost a customer outranks one that has not', () => {
    const quiet = slot({ id: 1 })
    const bleeding = slot({ id: 2 })
    const events: OperatorEvent[] = [
      { kind: 'stockout', at: at(5), concessionId: 'slot:2', operator: '민수' },
    ]
    const needs = detectRestockNeeds([quiet, bleeding], events)
    expect(needs[0]!.slotId).toBe(2)
    expect(needs[0]!.urgency).toBe('empty-with-demand')
    expect(needs[1]!.urgency).toBe('empty')
  })

  it('a low-but-not-empty slot is flagged, below the empty ones', () => {
    const needs = detectRestockNeeds([slot({ id: 1, stock: 1 }), slot({ id: 2, stock: 0 })], [])
    expect(needs.map((n) => n.slotId)).toEqual([2, 1])
    expect(needs[1]!.urgency).toBe('low')
  })

  it('the bounty comes out of the operator’s accrual', () => {
    const [need] = detectRestockNeeds([slot({ accruedBaseUnits: '1000000', paidBaseUnits: '0' })], [])
    expect(need!.fundable).toBe(true)
    expect(need!.bountyBaseUnits).toBe('300000') // 30% of 1 USDC
  })

  it('already-paid-out revenue is not offered twice', () => {
    const [need] = detectRestockNeeds([slot({ accruedBaseUnits: '1000000', paidBaseUnits: '1000000' })], [])
    expect(need!.fundable).toBe(false)
    expect(need!.bountyBaseUnits).toBe('0')
  })

  it('an operator with nothing accrued cannot hire — and is told why', () => {
    const [need] = detectRestockNeeds([slot({ accruedBaseUnits: '0' })], [])
    expect(need!.fundable).toBe(false)
    // The booth must not quietly cover it: that is the machine owner doing the
    // lessee's job for free, which is the arrangement operatorship ends.
    expect(need!.reason).toContain('no accrued revenue')
  })

  it('a bounty too small to be worth the trip is refused, not posted', () => {
    const [need] = detectRestockNeeds([slot({ accruedBaseUnits: '1000' })], [])
    expect(need!.fundable).toBe(false)
    expect(need!.reason).toContain(DEFAULT_RESTOCK_OPTIONS.minBountyBaseUnits)
  })
})

describe('openStockoutsFor', () => {
  it('a restock closes an earlier stockout', () => {
    expect(openStockoutsFor([ev('stockout', 1), ev('restock', 2)], 'slot:3')).toBe(0)
  })

  it('two stockouts and one restock leaves one open', () => {
    expect(openStockoutsFor([ev('stockout', 1), ev('stockout', 2), ev('restock', 3)], 'slot:3')).toBe(1)
  })

  it('a restock with nothing open does not bank credit for the future', () => {
    // Otherwise an operator could pre-restock and have later stockouts
    // silently forgiven.
    expect(openStockoutsFor([ev('restock', 1), ev('stockout', 2)], 'slot:3')).toBe(1)
  })

  it('other concessions do not bleed in', () => {
    const other: OperatorEvent = { kind: 'stockout', at: at(1), concessionId: 'slot:9', operator: '민수' }
    expect(openStockoutsFor([other], 'slot:3')).toBe(0)
  })
})

describe('buildRestockBounty', () => {
  const need = detectRestockNeeds([slot()], [ev('stockout', 4)])[0]!
  const body = buildRestockBounty(need, { machineName: 'booth-1', location: '서울 성수동' })

  it('announces in the title and the first line that it needs hands', () => {
    expect(body.title).toContain('in person')
    expect(body.description.split('\n')[0]).toContain('PHYSICAL JOB')
    expect(body.description).toContain('서울 성수동')
  })

  it('the machine will not claim its own restock bounty', () => {
    // The worker lane matches [machine:plot]; if the restock marker ever
    // starts matching it, the booth pays itself to promise work it cannot do.
    expect(isMachineBounty(body.title)).toBe(false)
    expect(MACHINE_RESTOCK_MARKER).not.toContain('[machine:plot]')
  })

  it('discloses the evidence class instead of implying proof', () => {
    expect(body.acceptance_criteria).toContain('SELF-REPORTED')
    expect(body.acceptance_criteria).toContain('CONFIRMED-BY-SALE')
    expect(body.acceptance_criteria).toContain('no camera')
  })

  it('states who is paying', () => {
    expect(body.description).toContain("lessee's own accrued revenue")
  })

  it('keeps the marker even when the product name is long', () => {
    const longNeed = { ...need, name: '아주아주긴상품이름'.repeat(30) }
    const t = buildRestockBounty(longNeed, { machineName: 'b', location: 'x' }).title
    expect(t.startsWith(MACHINE_RESTOCK_MARKER)).toBe(true)
    expect(t.length).toBeLessThanOrEqual(200)
  })
})

describe('hasOpenRestockBounty — one empty slot, one bounty', () => {
  const title = buildRestockBounty(detectRestockNeeds([slot()], [])[0]!, {
    machineName: 'booth-1',
    location: '서울',
  }).title

  it('recognises its own posting', () => {
    expect(hasOpenRestockBounty([title], 3)).toBe(true)
  })

  it('does not confuse slot 3 with slot 30', () => {
    expect(hasOpenRestockBounty([title], 30)).toBe(false)
  })

  it('an unrelated open job is not a restock bounty', () => {
    expect(hasOpenRestockBounty(['[machine:plot] Pen-plotter postcard: plot "slot 3"'], 3)).toBe(false)
  })

  it('an empty feed means nothing is posted', () => {
    expect(hasOpenRestockBounty([], 3)).toBe(false)
  })
})

describe('upgradeRestockEvidence — proof for free', () => {
  it('a dispense proves the last claimed restock really happened', () => {
    const before = [ev('stockout', 1), ev('restock', 2, 'self-reported')]
    const after = upgradeRestockEvidence(before, 'slot:3')
    expect((after[1] as { evidence: string }).evidence).toBe('confirmed-by-sale')
  })

  it('does not reach back past an already-confirmed restock', () => {
    const before = [ev('restock', 1, 'self-reported'), ev('restock', 2, 'confirmed-by-sale')]
    const after = upgradeRestockEvidence(before, 'slot:3')
    expect((after[0] as { evidence: string }).evidence).toBe('self-reported')
  })

  it('leaves other slots alone', () => {
    const before = [ev('restock', 2, 'self-reported')]
    expect(upgradeRestockEvidence(before, 'slot:9')).toBe(before)
  })

  it('the upgrade is what moves the credit score', () => {
    const base: OperatorEvent[] = [
      { kind: 'sale', at: at(1), concessionId: 'slot:3', operator: '민수' },
      { kind: 'sale', at: at(2), concessionId: 'slot:3', operator: '민수' },
      { kind: 'sale', at: at(3), concessionId: 'slot:3', operator: '민수' },
      { kind: 'sale', at: at(4), concessionId: 'slot:3', operator: '민수' },
      ev('stockout', 5),
      ev('restock', 5, 'self-reported'),
    ]
    const claimed = summarize(base)[0]!
    const confirmed = summarize(upgradeRestockEvidence(base, 'slot:3'))[0]!
    expect(claimed.confirmedRestocks).toBe(0)
    expect(confirmed.confirmedRestocks).toBe(1)
  })
})
