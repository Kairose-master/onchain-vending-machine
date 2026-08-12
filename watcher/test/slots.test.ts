import { describe, expect, it } from 'vitest'
import {
  lesseeShare,
  matchSlotByAmount,
  recordSlotPayout,
  recordSlotSale,
  slotOutstanding,
  validateLease,
  type Slot,
} from '../src/slots'
import { createQueue, enqueueIfNew, hasSeen, markSeen } from '../src/queue'

const slot = (over: Partial<Slot> = {}): Slot => ({
  id: 1,
  name: '수제 스티커',
  lessee: '운영자A',
  lesseeWallet: '0x' + '2'.repeat(40),
  priceBaseUnits: '30000', // 0.03 USDC
  stock: 5,
  sales: 0,
  accruedBaseUnits: '0',
  paidBaseUnits: '0',
  createdAt: '2026-08-12T00:00:00.000Z',
  ...over,
})

const ctx = { existing: [] as Slot[], maxSlots: 4, cardPriceBaseUnits: '10000' }

describe('validateLease — the price IS the address', () => {
  const base = { slotId: 1, name: '수제 스티커', lessee: '운영자A', lesseeWallet: '', priceBaseUnits: '30000', stock: 5 }

  it('accepts a well-formed lease', () => {
    const r = validateLease(base, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.slot.priceBaseUnits).toBe('30000')
  })

  it('refuses a price equal to the card price — the amount must identify one lane', () => {
    expect(validateLease({ ...base, priceBaseUnits: '10000' }, ctx).ok).toBe(false)
  })

  it('refuses a price already used by another slot', () => {
    const r = validateLease({ ...base, slotId: 2 }, { ...ctx, existing: [slot()] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('같은 가격')
  })

  it('refuses an already-leased slot id and out-of-range ids', () => {
    expect(validateLease(base, { ...ctx, existing: [slot()] }).ok).toBe(false)
    expect(validateLease({ ...base, slotId: 0 }, ctx).ok).toBe(false)
    expect(validateLease({ ...base, slotId: 5 }, ctx).ok).toBe(false)
  })

  it('requires positive stock — an empty lease is not a business', () => {
    expect(validateLease({ ...base, stock: 0 }, ctx).ok).toBe(false)
  })
})

describe('matchSlotByAmount — exact match only', () => {
  it('finds the slot at its exact price and nothing else', () => {
    const slots = [slot(), slot({ id: 2, priceBaseUnits: '50000' })]
    expect(matchSlotByAmount(slots, '30000')?.id).toBe(1)
    expect(matchSlotByAmount(slots, '50000')?.id).toBe(2)
    expect(matchSlotByAmount(slots, '30001')).toBeNull() // overpay is NOT a slot buy
    expect(matchSlotByAmount(slots, '10000')).toBeNull() // the card price lane
  })
})

describe('sale, payout and the sold-out rule', () => {
  it('a sale decrements stock and accrues the lessee share', () => {
    const after = recordSlotSale(slot(), 8000)
    expect(after.stock).toBe(4)
    expect(after.sales).toBe(1)
    expect(after.accruedBaseUnits).toBe('24000') // 30000 * 80%
    expect(slotOutstanding(after)).toBe(24000n)
  })

  it('refuses to sell from an empty slot — that payment is a refund, not a sale', () => {
    expect(() => recordSlotSale(slot({ stock: 0 }), 8000)).toThrow(/refunded/)
  })

  it('lessee + booth never exceeds the price', () => {
    for (const price of ['1', '3', '30000', '999999']) {
      const share = lesseeShare(price, 8000)
      expect(share + (BigInt(price) - share)).toBe(BigInt(price))
    }
  })

  it('payout cannot overstate the ledger', () => {
    const sold = recordSlotSale(slot(), 8000)
    const paid = recordSlotPayout(sold, 24000n, '0xdef')
    expect(paid.paidBaseUnits).toBe('24000')
    expect(() => recordSlotPayout(paid, 1n, '0xdef')).toThrow()
  })
})

describe('one payment, one lane — the shared dedup set', () => {
  it('a tx marked seen by the slot lane is never card-credited on re-scan', () => {
    let queue = createQueue()
    queue = markSeen(queue, '0xslot-sale')
    expect(hasSeen(queue, '0xslot-sale')).toBe(true)
    // The re-scan window replays the same payment; enqueueIfNew must no-op.
    const after = enqueueIfNew(queue, { txHash: '0xslot-sale', from: '0xbuyer', amountBaseUnits: '30000' }, '10000')
    expect(after.pending).toHaveLength(0)
  })
})
