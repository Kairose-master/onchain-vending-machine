import { describe, expect, it } from 'vitest'
import {
  authorShare,
  outstandingBaseUnits,
  publicRecipe,
  recordPayout,
  recordSale,
  validateRegistration,
  type Recipe,
} from '../src/recipes'

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  id: 'r1',
  name: '응원 카드',
  author: '진우',
  authorWallet: '0x' + '1'.repeat(40),
  kind: 'text',
  text: '오늘도 화이팅',
  createdAt: '2026-08-12T00:00:00.000Z',
  sales: 0,
  accruedBaseUnits: '0',
  paidBaseUnits: '0',
  ...over,
})

describe('validateRegistration', () => {
  const base = { name: '응원 카드', author: '진우', authorWallet: '', text: '오늘도 화이팅' }

  it('accepts a text design and stamps kind', () => {
    const r = validateRegistration(base)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.recipe.kind).toBe('text')
  })

  it('accepts an image design', () => {
    const r = validateRegistration({ ...base, text: undefined, imageBase64: 'data:image/png;base64,AAAA', threshold: 120 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.recipe.kind).toBe('image')
      expect(r.recipe.threshold).toBe(120)
    }
  })

  it('refuses neither and both', () => {
    expect(validateRegistration({ ...base, text: undefined }).ok).toBe(false)
    expect(validateRegistration({ ...base, imageBase64: 'x' }).ok).toBe(false)
  })

  it('refuses a malformed wallet but allows an empty one', () => {
    expect(validateRegistration({ ...base, authorWallet: 'not-an-address' }).ok).toBe(false)
    expect(validateRegistration({ ...base, authorWallet: '0x' + 'a'.repeat(40) }).ok).toBe(true)
  })

  it('enforces the length bounds', () => {
    expect(validateRegistration({ ...base, name: '' }).ok).toBe(false)
    expect(validateRegistration({ ...base, name: '가'.repeat(41) }).ok).toBe(false)
    expect(validateRegistration({ ...base, author: '' }).ok).toBe(false)
    expect(validateRegistration({ ...base, text: '가'.repeat(81) }).ok).toBe(false)
  })
})

describe('authorShare — the split arithmetic', () => {
  it('takes the author bps of the price, floored', () => {
    expect(authorShare('10000', 7000)).toBe(7000n)
    // 0.01 USDC price, 70%: 10000 * 7000 / 10000 exactly.
    expect(authorShare('3', 7000)).toBe(2n) // 2.1 floors to 2 — booth absorbs the remainder
  })
  it('sum of author + booth never exceeds the price', () => {
    for (const price of ['1', '3', '9999', '10000']) {
      const author = authorShare(price, 7000)
      const booth = BigInt(price) - author
      expect(author + booth).toBe(BigInt(price))
      expect(author).toBeLessThanOrEqual(BigInt(price))
    }
  })
  it('rejects out-of-range bps', () => {
    expect(() => authorShare('10000', -1)).toThrow()
    expect(() => authorShare('10000', 10_001)).toThrow()
  })
})

describe('sale and payout ledger', () => {
  it('a sale bumps the counter and accrues the share', () => {
    const after = recordSale(recipe(), '10000', 7000)
    expect(after.sales).toBe(1)
    expect(after.accruedBaseUnits).toBe('7000')
    expect(outstandingBaseUnits(after)).toBe(7000n)
  })

  it('accrual accumulates across sales', () => {
    const after = recordSale(recordSale(recipe(), '10000', 7000), '10000', 7000)
    expect(after.sales).toBe(2)
    expect(after.accruedBaseUnits).toBe('14000')
  })

  it('a payout moves outstanding to paid and keeps the receipt', () => {
    const sold = recordSale(recipe(), '10000', 7000)
    const paid = recordPayout(sold, 7000n, '0xabc')
    expect(paid.paidBaseUnits).toBe('7000')
    expect(paid.lastPayoutTx).toBe('0xabc')
    expect(outstandingBaseUnits(paid)).toBe(0n)
  })

  it('refuses to record more paid than accrued — the ledger must never overstate', () => {
    const sold = recordSale(recipe(), '10000', 7000)
    expect(() => recordPayout(sold, 7001n, '0xabc')).toThrow()
    expect(() => recordPayout(sold, 0n, '0xabc')).toThrow()
  })
})

describe('publicRecipe', () => {
  it('never ships the image payload in a listing', () => {
    const pub = publicRecipe(recipe({ kind: 'image', text: undefined, imageBase64: 'A'.repeat(100000) }))
    expect('imageBase64' in pub).toBe(false)
    expect(pub.hasImage).toBe(true)
  })
})
