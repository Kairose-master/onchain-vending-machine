import { describe, expect, it } from 'vitest'
import {
  COLLATERAL_FLOOR_BPS,
  MIN_HISTORY,
  bondBps,
  creditScore,
  payableBaseUnits,
  requiredCollateralBps,
  rollingBondBaseUnits,
  summarize,
  underwrite,
  type OperatorEvent,
} from '../src/operator-credit'

const NOW = '2026-09-01T00:00:00.000Z'
const day = (n: number) => `2026-08-${String(n).padStart(2, '0')}T00:00:00.000Z`

const sale = (n: number, op = '민수', c = 'slot:3'): OperatorEvent => ({ kind: 'sale', at: day(n), concessionId: c, operator: op })
const stockout = (n: number, op = '민수', c = 'slot:3'): OperatorEvent => ({ kind: 'stockout', at: day(n), concessionId: c, operator: op })
const restock = (
  n: number,
  evidence: 'self-reported' | 'confirmed-by-sale' = 'confirmed-by-sale',
  op = '민수',
  c = 'slot:3',
): OperatorEvent => ({ kind: 'restock', at: day(n), concessionId: c, operator: op, units: 5, evidence })

describe('summarize', () => {
  it('counts the things the booth actually records', () => {
    const [rec] = summarize([sale(1), sale(2), stockout(3), restock(4), sale(5)])
    expect(rec!.sales).toBe(3)
    expect(rec!.stockouts).toBe(1)
    expect(rec!.restocks).toBe(1)
    expect(rec!.confirmedRestocks).toBe(1)
    expect(rec!.openStockouts).toBe(0)
  })

  it('a restock answers the OLDEST open stockout, not the newest', () => {
    // Newest-first matching would report a short latency and leave the
    // week-old complaint "open" — flattering exactly the operator who ignored it.
    const [rec] = summarize([stockout(1), stockout(8), restock(9)])
    expect(rec!.medianRestockHours).toBe(8 * 24)
    expect(rec!.openStockouts).toBe(1)
  })

  it('unanswered stockouts stay open', () => {
    const [rec] = summarize([sale(1), stockout(2)])
    expect(rec!.openStockouts).toBe(1)
    expect(rec!.medianRestockHours).toBeNull()
  })

  it('separates operators and tracks each one’s concessions', () => {
    const recs = summarize([sale(1, 'a', 'slot:1'), sale(2, 'b', 'slot:2'), sale(3, 'a', 'slot:4')])
    expect(recs).toHaveLength(2)
    expect(recs.find((r) => r.operator === 'a')!.concessions).toEqual(['slot:1', 'slot:4'])
  })

  it('out-of-order events are folded in timestamp order', () => {
    const [rec] = summarize([restock(9), stockout(1)])
    expect(rec!.medianRestockHours).toBe(8 * 24)
  })
})

describe('creditScore', () => {
  it('a brand-new operator is unrated at zero — no cold-start gift', () => {
    const [rec] = summarize([sale(1), sale(2)])
    const v = creditScore(rec!, NOW)
    expect(v.score).toBe(0)
    expect(v.rating).toBe('unrated')
    expect(v.basis[0]).toContain(`/${MIN_HISTORY}`)
  })

  it('one perfect sale cannot buy a perfect score', () => {
    const [rec] = summarize([sale(1)])
    expect(creditScore(rec!, NOW).score).toBe(0)
  })

  it('never running out is the best possible restock record', () => {
    const [rec] = summarize([1, 2, 3, 4, 5, 6].map((n) => sale(n)))
    const v = creditScore(rec!, NOW)
    expect(v.basis.some((b) => b.includes('never ran out'))).toBe(true)
    expect(v.score).toBeGreaterThan(55)
  })

  it('stockouts that are never answered cost the whole restock component', () => {
    const events = [sale(1), sale(2), sale(3), stockout(4), stockout(5), stockout(6)]
    const [rec] = summarize(events)
    const v = creditScore(rec!, NOW)
    expect(v.basis.some((b) => b.includes('never answered'))).toBe(true)
    expect(v.rating).toBe('thin')
  })

  it('a fast, confirmed restock beats a slow, merely-claimed one', () => {
    const fast = summarize([sale(1), sale(2), sale(3), sale(4), stockout(5), restock(5, 'confirmed-by-sale')])[0]!
    const slow = summarize([sale(1), sale(2), sale(3), sale(4), stockout(5), restock(12, 'self-reported')])[0]!
    expect(creditScore(fast, NOW).score).toBeGreaterThan(creditScore(slow, NOW).score)
  })

  it('every verdict shows its work', () => {
    const [rec] = summarize([1, 2, 3, 4, 5, 6].map((n) => sale(n)))
    const v = creditScore(rec!, NOW)
    expect(v.basis.length).toBeGreaterThanOrEqual(4)
    for (const line of v.basis) expect(line.length).toBeGreaterThan(5)
  })

  it('stays inside 0..100 at both extremes', () => {
    const perfect = summarize(Array.from({ length: 30 }, (_, i) => sale((i % 28) + 1)))[0]!
    const s = creditScore(perfect, '2027-09-01T00:00:00.000Z').score
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThanOrEqual(100)
  })
})

describe('requiredCollateralBps — the credit function', () => {
  it('an unrated operator posts full collateral', () => {
    expect(requiredCollateralBps(0)).toBe(10_000)
  })

  it('a perfect record still posts the floor — never a free slot', () => {
    expect(requiredCollateralBps(100)).toBe(COLLATERAL_FLOOR_BPS)
    expect(COLLATERAL_FLOOR_BPS).toBeGreaterThan(0)
  })

  it('is monotonic: a better record never costs more', () => {
    let prev = requiredCollateralBps(0)
    for (let s = 1; s <= 100; s++) {
      const cur = requiredCollateralBps(s)
      expect(cur).toBeLessThanOrEqual(prev)
      prev = cur
    }
  })

  it('clamps scores from outside the range rather than extrapolating', () => {
    expect(requiredCollateralBps(-20)).toBe(10_000)
    expect(requiredCollateralBps(500)).toBe(COLLATERAL_FLOOR_BPS)
  })
})

describe('rollingBondBaseUnits — the part that is actually enforced', () => {
  const base = { lifetimeAccruedBaseUnits: 1_000_000n, outstandingBaseUnits: 1_000_000n }

  it('an unrated operator has 30% of earnings held back', () => {
    expect(rollingBondBaseUnits({ ...base, score: 0 })).toBe(300_000n)
  })

  it('a strong record shrinks the hold to the floor, never to nothing', () => {
    const held = rollingBondBaseUnits({ ...base, score: 100 })
    expect(held).toBe(50_000n)
    expect(held).toBeGreaterThan(0n)
  })

  it('cannot hold money that has already been paid out', () => {
    // Lifetime 1 USDC earned, 0.95 already paid: only 0.05 is holdable.
    const held = rollingBondBaseUnits({
      lifetimeAccruedBaseUnits: 1_000_000n,
      outstandingBaseUnits: 50_000n,
      score: 0,
    })
    expect(held).toBe(50_000n)
  })

  it('nothing owed, nothing held', () => {
    expect(rollingBondBaseUnits({ ...base, outstandingBaseUnits: 0n, score: 0 })).toBe(0n)
  })

  it('payable + held never exceeds what is owed', () => {
    for (const score of [0, 25, 50, 75, 100]) {
      for (const outstanding of [0n, 1n, 12_345n, 1_000_000n]) {
        const input = { lifetimeAccruedBaseUnits: 1_000_000n, outstandingBaseUnits: outstanding, score }
        expect(payableBaseUnits(input) + rollingBondBaseUnits(input)).toBe(outstanding)
      }
    }
  })

  it('a better record releases money, never withholds more', () => {
    let prev = payableBaseUnits({ ...base, score: 0 })
    for (let s = 1; s <= 100; s++) {
      const cur = payableBaseUnits({ ...base, score: s })
      expect(cur).toBeGreaterThanOrEqual(prev)
      prev = cur
    }
  })

  it('the enforced hold is far lighter than the up-front quote', () => {
    // Quoting 100% of inventory and then holding 100% of revenue would be the
    // same operator paying twice for one cold start.
    expect(bondBps(0)).toBeLessThan(requiredCollateralBps(0))
  })
})

describe('underwrite', () => {
  it('publishes how thin the record is alongside the score', () => {
    const [rec] = summarize([sale(1), sale(2), sale(3), sale(4), stockout(5)])
    const u = underwrite(rec!, NOW)
    expect(u.meteredEvents).toBe(5)
    expect(u.requiredCollateralBps).toBe(requiredCollateralBps(u.score))
    expect(u.concessions).toEqual(['slot:3'])
  })
})
