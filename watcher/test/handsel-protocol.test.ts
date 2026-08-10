import { describe, expect, it } from 'vitest'
import {
  buildJobBody,
  buildSubmissionOutput,
  cardMarker,
  findJobInFeed,
  isSettledStatus,
  type Card,
} from '../src/handsel/protocol'

const card = (over: Partial<Card> = {}): Card => ({
  id: 'ab12cd34',
  kind: 'text',
  label: '안녕하세요',
  paymentTxHash: '0x' + 'f'.repeat(64),
  stats: { polylines: 42, points: 1234, drawLengthMm: 512.4, travelLengthMm: 220.9, estMinutes: 1.7 },
  ...over,
})

describe('buildJobBody', () => {
  it('embeds the marker at the START of the title so truncation can never lose it', () => {
    const body = buildJobBody(card())
    expect(body.title.startsWith(cardMarker('ab12cd34'))).toBe(true)
  })

  it('keeps the title under the platform 200-char limit even for a max-length phrase', () => {
    const body = buildJobBody(card({ label: '가'.repeat(80) }))
    expect(body.title.length).toBeLessThanOrEqual(200)
    expect(body.title).toContain(cardMarker('ab12cd34'))
  })

  it('acceptance criteria name the phrase, the payment tx, and the stats requirement', () => {
    const c = card()
    const body = buildJobBody(c)
    expect(body.acceptance_criteria).toContain(c.label)
    expect(body.acceptance_criteria).toContain(c.paymentTxHash)
    expect(body.acceptance_criteria.length).toBeGreaterThanOrEqual(10) // platform minimum
    expect(body.acceptance_criteria).toMatch(/stroke statistics/)
  })

  it('min_score is 0 — the cold-start booth agent must be able to claim its own job', () => {
    expect(buildJobBody(card()).min_score).toBe(0)
  })

  it('image cards describe the image lane, not a phantom phrase', () => {
    const body = buildJobBody(card({ kind: 'image', label: '이미지 카드' }))
    expect(body.title).toContain('uploaded image')
    expect(body.acceptance_criteria).toContain('이미지 카드')
  })
})

describe('findJobInFeed', () => {
  const marker = cardMarker('ab12cd34')

  it('finds the job by marker and returns its numeric id + status', () => {
    const tasks = [
      { id: '7', title: 'unrelated job', status: 'Open' },
      { id: '9', title: `${marker} Pen-plotter postcard: plot "안녕하세요"`, status: 'Open' },
    ]
    expect(findJobInFeed(tasks, marker)).toEqual({ jobId: 9, status: 'Open' })
  })

  it('returns null when the job is not in the feed', () => {
    expect(findJobInFeed([{ id: '1', title: 'other', status: 'Open' }], marker)).toBeNull()
  })

  it('refuses a non-numeric feed id rather than claiming job NaN', () => {
    expect(findJobInFeed([{ id: 'not-a-number', title: marker, status: 'Open' }], marker)).toBeNull()
  })
})

describe('buildSubmissionOutput', () => {
  it('satisfies the acceptance criteria field by field: phrase, tx hash, stats', () => {
    const c = card()
    const out = buildSubmissionOutput(c, '2026-08-10T12:00:00.000Z')
    const criteria = buildJobBody(c).acceptance_criteria
    expect(out).toContain(c.label)
    expect(out).toContain(c.paymentTxHash)
    expect(out).toContain('42 polylines')
    expect(out).toContain('512 mm drawn')
    expect(out).toContain(cardMarker(c.id))
    // The deliverable and the criteria reference the SAME phrase and tx —
    // if these drift apart, the grader fails honest work.
    expect(criteria).toContain(c.label)
    expect(criteria).toContain(c.paymentTxHash)
  })
})

describe('isSettledStatus', () => {
  it('in-flight statuses are not settled; anything else is', () => {
    for (const s of ['Open', 'Accepted', 'Submitted']) expect(isSettledStatus(s)).toBe(false)
    for (const s of ['Approved', 'Paid', 'Cancelled', 'Disputed', 'Refunded']) expect(isSettledStatus(s)).toBe(true)
  })
})
