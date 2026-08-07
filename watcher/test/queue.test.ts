import { describe, expect, it } from 'vitest'
import { createQueue, enqueueIfNew, dequeue } from '../src/queue'

const PRICE = '10000' // 0.01 USDC at 6 decimals

const payment = (over: Partial<{ txHash: string; from: string; amountBaseUnits: string }> = {}) => ({
  txHash: '0xabc',
  from: '0x1111111111111111111111111111111111111111',
  amountBaseUnits: PRICE,
  ...over,
})

describe('enqueueIfNew', () => {
  it('credits a payment that meets the price', () => {
    const q = enqueueIfNew(createQueue(), payment(), PRICE)
    expect(q.pending).toHaveLength(1)
    expect(q.seenTxHashes).toEqual(['0xabc'])
  })

  it('a payment above the price is still one credit, not two — no change-making in v1', () => {
    const q = enqueueIfNew(createQueue(), payment({ amountBaseUnits: '99999999' }), PRICE)
    expect(q.pending).toHaveLength(1)
  })

  it('never double-credits the same tx hash — this is the whole point of the dedup', () => {
    let q = enqueueIfNew(createQueue(), payment(), PRICE)
    q = enqueueIfNew(q, payment(), PRICE) // same txHash again, e.g. a re-scan after restart
    expect(q.pending).toHaveLength(1)
  })

  it('records an underpaid tx as seen but never dispenses it', () => {
    const q = enqueueIfNew(createQueue(), payment({ amountBaseUnits: '1' }), PRICE)
    expect(q.pending).toHaveLength(0)
    expect(q.seenTxHashes).toEqual(['0xabc'])
    // and it stays refused even if "re-scanned" — already seen
    const q2 = enqueueIfNew(q, payment({ amountBaseUnits: '1' }), PRICE)
    expect(q2.pending).toHaveLength(0)
  })

  it('two different qualifying payments queue in arrival order (FIFO)', () => {
    let q = enqueueIfNew(createQueue(), payment({ txHash: '0x1' }), PRICE)
    q = enqueueIfNew(q, payment({ txHash: '0x2' }), PRICE)
    expect(q.pending.map((p) => p.txHash)).toEqual(['0x1', '0x2'])
  })
})

describe('dequeue', () => {
  it('pops the oldest pending payment first', () => {
    let q = enqueueIfNew(createQueue(), payment({ txHash: '0x1' }), PRICE)
    q = enqueueIfNew(q, payment({ txHash: '0x2' }), PRICE)
    const out = dequeue(q)
    expect(out.item?.txHash).toBe('0x1')
    expect(out.state.pending.map((p) => p.txHash)).toEqual(['0x2'])
  })

  it('returns item: null on an empty queue rather than throwing — the ESP32 polls this constantly', () => {
    const out = dequeue(createQueue())
    expect(out.item).toBeNull()
    expect(out.state.pending).toEqual([])
  })

  it('dequeue never touches seenTxHashes — a dispensed payment must never be replayable', () => {
    let q = enqueueIfNew(createQueue(), payment(), PRICE)
    const before = q.seenTxHashes
    const out = dequeue(q)
    expect(out.state.seenTxHashes).toEqual(before)
  })
})
