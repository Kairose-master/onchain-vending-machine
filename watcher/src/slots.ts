/**
 * The slot market — the CANONICAL operator market
 * (handsel `docs/physical-operatorship.md`: policy discretion + residual
 * claim + downside + non-ownership, all four).
 *
 * A lessee takes one physical dispenser channel, stocks it with THEIR
 * goods (that inventory is the downside — condition 3, met for real here,
 * unlike recipe registration), names it, and sets the price. The price is
 * the addressing scheme: every slot's price is unique and distinct from
 * the plotter card price, so the exact amount of an on-chain payment
 * identifies which slot was bought — the classic vending trick, ported to
 * ERC-20 transfers, which carry no memo field.
 *
 * Pure module: validation, amount→slot matching, the stock/revenue
 * ledger. Persistence and the servo live in server.ts / the firmware.
 */

export interface Slot {
  /** Physical dispenser channel, 1..maxSlots — maps to a servo. */
  id: number
  /** What's in it, as the lessee describes it. */
  name: string
  lessee: string
  /** Base Sepolia address for revenue payout; '' = accrue-only. */
  lesseeWallet: string
  /** The slot's price AND its address — unique, exact-match. */
  priceBaseUnits: string
  stock: number
  sales: number
  accruedBaseUnits: string
  paidBaseUnits: string
  lastPayoutTx?: string
  createdAt: string
}

/** A paid-for item the machine could not (or has not yet) dropped. */
export interface SlotDispense {
  slotId: number
  txHash: string
  from: string
}

/** A payment that matched a sold-out slot: money in, nothing to drop.
 *  Lives in the ledger until refunded — silently keeping it is theft. */
export interface RefundDue {
  txHash: string
  from: string
  amountBaseUnits: string
  slotId: number
  refundTx?: string
}

export interface SlotStore {
  slots: Slot[]
  pendingDispenses: SlotDispense[]
  refundsDue: RefundDue[]
}

export const emptySlotStore = (): SlotStore => ({ slots: [], pendingDispenses: [], refundsDue: [] })

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v)

export interface LeaseInput {
  slotId?: unknown
  name?: unknown
  lessee?: unknown
  lesseeWallet?: unknown
  priceBaseUnits?: unknown
  stock?: unknown
}

export type LeaseResult = { ok: true; slot: Omit<Slot, 'createdAt'> } | { ok: false; error: string }

export function validateLease(
  input: LeaseInput,
  ctx: { existing: Slot[]; maxSlots: number; cardPriceBaseUnits: string },
): LeaseResult {
  const slotId = Number(input.slotId)
  const name = String(input.name ?? '').trim()
  const lessee = String(input.lessee ?? '').trim()
  const lesseeWallet = String(input.lesseeWallet ?? '').trim()
  const stock = Number(input.stock)

  if (!Number.isInteger(slotId) || slotId < 1 || slotId > ctx.maxSlots) {
    return { ok: false, error: `슬롯 번호는 1~${ctx.maxSlots}` }
  }
  if (ctx.existing.some((s) => s.id === slotId)) return { ok: false, error: '이미 임대된 슬롯입니다' }
  if (name.length < 1 || name.length > 40) return { ok: false, error: '상품명은 1~40자' }
  if (lessee.length < 1 || lessee.length > 20) return { ok: false, error: '운영자명은 1~20자' }
  if (lesseeWallet && !isAddress(lesseeWallet)) {
    return { ok: false, error: '지갑 주소가 올바르지 않습니다 (0x… 40자리, 비워도 됨)' }
  }
  if (!Number.isInteger(stock) || stock < 1 || stock > 999) return { ok: false, error: '재고는 1~999개' }

  let price: bigint
  try {
    price = BigInt(String(input.priceBaseUnits ?? ''))
  } catch {
    return { ok: false, error: '가격이 올바르지 않습니다' }
  }
  if (price <= 0n) return { ok: false, error: '가격은 0보다 커야 합니다' }
  // The price IS the slot's on-chain address; collisions would make a
  // payment ambiguous, so they are refused at lease time.
  if (price === BigInt(ctx.cardPriceBaseUnits)) {
    return { ok: false, error: '카드(플로터) 가격과 같은 가격은 쓸 수 없습니다 — 결제 금액으로 슬롯을 식별합니다' }
  }
  if (ctx.existing.some((s) => BigInt(s.priceBaseUnits) === price)) {
    return { ok: false, error: '다른 슬롯과 같은 가격은 쓸 수 없습니다 — 결제 금액으로 슬롯을 식별합니다' }
  }

  return {
    ok: true,
    slot: {
      id: slotId,
      name,
      lessee,
      lesseeWallet,
      priceBaseUnits: price.toString(),
      stock,
      sales: 0,
      accruedBaseUnits: '0',
      paidBaseUnits: '0',
    },
  }
}

/** The router: an exact price match picks the slot. Non-exact amounts are
 *  NOT slot purchases (they fall through to the card-credit lane). */
export function matchSlotByAmount(slots: Slot[], amountBaseUnits: string): Slot | null {
  const amount = BigInt(amountBaseUnits)
  return slots.find((s) => BigInt(s.priceBaseUnits) === amount) ?? null
}

/** Lessee's share of one sale — floor; the booth absorbs the remainder so
 *  lessee + booth never exceeds the price. */
export function lesseeShare(priceBaseUnits: string, lesseeBps: number): bigint {
  if (!Number.isInteger(lesseeBps) || lesseeBps < 0 || lesseeBps > 10_000) {
    throw new Error(`lesseeBps out of range: ${lesseeBps}`)
  }
  return (BigInt(priceBaseUnits) * BigInt(lesseeBps)) / 10_000n
}

/** One sold item: stock down, sales up, revenue accrued. Refuses to sell
 *  from an empty slot — the caller must route that payment to refundsDue. */
export function recordSlotSale(slot: Slot, lesseeBps: number): Slot {
  if (slot.stock <= 0) throw new Error(`slot ${slot.id} is sold out — this payment must be refunded, not sold`)
  return {
    ...slot,
    stock: slot.stock - 1,
    sales: slot.sales + 1,
    accruedBaseUnits: (BigInt(slot.accruedBaseUnits) + lesseeShare(slot.priceBaseUnits, lesseeBps)).toString(),
  }
}

export function recordSlotPayout(slot: Slot, amountBaseUnits: bigint, txHash: string): Slot {
  const outstanding = BigInt(slot.accruedBaseUnits) - BigInt(slot.paidBaseUnits)
  if (amountBaseUnits <= 0n || amountBaseUnits > outstanding) {
    throw new Error(`payout ${amountBaseUnits} exceeds outstanding ${outstanding}`)
  }
  return {
    ...slot,
    paidBaseUnits: (BigInt(slot.paidBaseUnits) + amountBaseUnits).toString(),
    lastPayoutTx: txHash,
  }
}

export const slotOutstanding = (slot: Slot): bigint =>
  BigInt(slot.accruedBaseUnits) - BigInt(slot.paidBaseUnits)
