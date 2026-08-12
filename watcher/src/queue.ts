/**
 * The dispense queue — pure state machine, no network, no clock.
 *
 * One qualifying on-chain payment = one dispense credit. Dedup by tx hash so
 * a restart (which re-scans a small block window on purpose, see
 * chain-watch.ts) can never double-credit the same payment twice — a vending
 * machine that dispenses two items for one payment is a real loss, not a
 * cosmetic bug.
 */

export interface QueueState {
  /** FIFO of payments waiting to be dispensed. */
  pending: PendingPayment[]
  /** Every tx hash ever credited, so a re-scan never enqueues it twice. */
  seenTxHashes: string[]
}

export interface PendingPayment {
  txHash: string
  from: string
  amountBaseUnits: string
}

export function createQueue(): QueueState {
  return { pending: [], seenTxHashes: [] }
}

/**
 * Credit a payment if it clears the price and hasn't been seen before.
 * Returns the same reference when nothing changed, so a caller can skip a
 * write to disk on a no-op tick.
 */
export function enqueueIfNew(
  state: QueueState,
  payment: PendingPayment,
  priceBaseUnits: string,
): QueueState {
  if (state.seenTxHashes.includes(payment.txHash)) return state
  if (BigInt(payment.amountBaseUnits) < BigInt(priceBaseUnits)) {
    // Underpaid: recorded as seen so it's never retried, but never dispensed.
    return { pending: state.pending, seenTxHashes: [...state.seenTxHashes, payment.txHash] }
  }
  return {
    pending: [...state.pending, payment],
    seenTxHashes: [...state.seenTxHashes, payment.txHash],
  }
}

/** Record a tx as handled WITHOUT crediting it — the slot lane consumed it
 *  (sale or refund ledger). Shares the same dedup set as card credits so a
 *  re-scan can never route one payment down both lanes. */
export function markSeen(state: QueueState, txHash: string): QueueState {
  if (state.seenTxHashes.includes(txHash)) return state
  return { pending: state.pending, seenTxHashes: [...state.seenTxHashes, txHash] }
}

export const hasSeen = (state: QueueState, txHash: string): boolean =>
  state.seenTxHashes.includes(txHash)

export type DequeueResult = { state: QueueState; item: PendingPayment } | { state: QueueState; item: null }

/** Pop the oldest pending payment — the ESP32 calls this once per successful
 *  servo cycle, never before the servo has actually moved. */
export function dequeue(state: QueueState): DequeueResult {
  const [item, ...rest] = state.pending
  if (!item) return { state, item: null }
  return { state: { pending: rest, seenTxHashes: state.seenTxHashes }, item }
}
