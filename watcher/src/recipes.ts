/**
 * The recipe market — increment 1 of the operatorship thesis
 * (handsel `docs/physical-operatorship.md`).
 *
 * A third party registers a card design on this booth; every sale of that
 * design splits revenue between the author and the booth. This module is
 * the PURE core: validation, the split arithmetic, and the ledger
 * transitions — all unit-testable. Persistence is a JSON file next to the
 * queue state; payout (a real Base Sepolia USDC transfer) lives in
 * royalty.ts.
 *
 * Trust model is deliberately booth-local: registration is a kiosk form
 * with no login, because the booth operator is physically present — the
 * same reason a café's community board doesn't need OAuth. What keeps it
 * honest is the same rule as everything else here: sales counters and
 * author earnings are real transactions or they are not shown.
 */

export interface Recipe {
  id: string
  name: string
  author: string
  /** Base Sepolia address for royalty payout; '' = accrue-only. */
  authorWallet: string
  kind: 'text' | 'image'
  text?: string
  imageBase64?: string
  threshold?: number
  createdAt: string
  sales: number
  /** Author's share accrued across all sales, USDC base units. */
  accruedBaseUnits: string
  /** Portion of accrued actually paid out on-chain. */
  paidBaseUnits: string
  lastPayoutTx?: string
}

export interface RecipeStore {
  recipes: Recipe[]
}

export const emptyRecipeStore = (): RecipeStore => ({ recipes: [] })

export interface RegistrationInput {
  name?: unknown
  author?: unknown
  authorWallet?: unknown
  text?: unknown
  imageBase64?: unknown
  threshold?: unknown
}

export type RegistrationResult =
  | { ok: true; recipe: Omit<Recipe, 'id' | 'createdAt'> }
  | { ok: false; error: string }

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v)

/** Validate a kiosk registration. Drawability is NOT checked here — the
 *  caller must run the real preview pipeline before saving, so a design
 *  that produces no strokes is refused at registration, not discovered by
 *  a paying customer. */
export function validateRegistration(input: RegistrationInput): RegistrationResult {
  const name = String(input.name ?? '').trim()
  const author = String(input.author ?? '').trim()
  const authorWallet = String(input.authorWallet ?? '').trim()
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  const imageBase64 = typeof input.imageBase64 === 'string' ? input.imageBase64 : ''

  if (name.length < 1 || name.length > 40) return { ok: false, error: '이름은 1~40자' }
  if (author.length < 1 || author.length > 20) return { ok: false, error: '작가명은 1~20자' }
  if (authorWallet && !isAddress(authorWallet)) {
    return { ok: false, error: '지갑 주소가 올바르지 않습니다 (0x… 40자리, 비워도 됨)' }
  }
  if (!text && !imageBase64) return { ok: false, error: '문구 또는 이미지 중 하나는 필요합니다' }
  if (text && imageBase64) return { ok: false, error: '문구와 이미지는 동시에 등록할 수 없습니다' }
  if (text && text.length > 80) return { ok: false, error: '문구는 최대 80자' }

  const threshold = Number(input.threshold)
  return {
    ok: true,
    recipe: {
      name,
      author,
      authorWallet,
      kind: text ? 'text' : 'image',
      ...(text ? { text } : {}),
      ...(imageBase64 ? { imageBase64 } : {}),
      ...(imageBase64 && Number.isFinite(threshold) ? { threshold } : {}),
      sales: 0,
      accruedBaseUnits: '0',
      paidBaseUnits: '0',
    },
  }
}

/** The author's cut of one sale. Floor, never round up — the booth's side
 *  absorbs the sub-unit remainder, so the sum of shares can never exceed
 *  the price. */
export function authorShare(priceBaseUnits: string, authorBps: number): bigint {
  if (!Number.isInteger(authorBps) || authorBps < 0 || authorBps > 10_000) {
    throw new Error(`authorBps out of range: ${authorBps}`)
  }
  return (BigInt(priceBaseUnits) * BigInt(authorBps)) / 10_000n
}

/** One sale: bump the counter, accrue the author's share. Pure — returns a
 *  new recipe object. */
export function recordSale(recipe: Recipe, priceBaseUnits: string, authorBps: number): Recipe {
  const share = authorShare(priceBaseUnits, authorBps)
  return {
    ...recipe,
    sales: recipe.sales + 1,
    accruedBaseUnits: (BigInt(recipe.accruedBaseUnits) + share).toString(),
  }
}

/** A payout landed on-chain: move the amount from accrued-outstanding to
 *  paid, keep the receipt. Refuses to record more paid than accrued —
 *  a ledger that can overstate payouts is worse than none. */
export function recordPayout(recipe: Recipe, amountBaseUnits: bigint, txHash: string): Recipe {
  const outstanding = BigInt(recipe.accruedBaseUnits) - BigInt(recipe.paidBaseUnits)
  if (amountBaseUnits <= 0n || amountBaseUnits > outstanding) {
    throw new Error(`payout ${amountBaseUnits} exceeds outstanding ${outstanding}`)
  }
  return {
    ...recipe,
    paidBaseUnits: (BigInt(recipe.paidBaseUnits) + amountBaseUnits).toString(),
    lastPayoutTx: txHash,
  }
}

export const outstandingBaseUnits = (recipe: Recipe): bigint =>
  BigInt(recipe.accruedBaseUnits) - BigInt(recipe.paidBaseUnits)

/** What the gallery endpoint returns — everything except the image payload
 *  (a list of designs must not weigh megabytes; previews render on demand). */
export function publicRecipe(recipe: Recipe) {
  const { imageBase64: _omit, ...rest } = recipe
  return { ...rest, hasImage: recipe.kind === 'image' }
}
