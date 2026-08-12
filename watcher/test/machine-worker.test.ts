import { describe, expect, it } from 'vitest'
import {
  MACHINE_PLOT_MARKER,
  buildMachineSubmission,
  extractPlotText,
  isMachineBounty,
} from '../src/handsel/protocol'

describe('isMachineBounty — what this machine may claim', () => {
  it('claims marked jobs and ignores unmarked ones', () => {
    expect(isMachineBounty('[machine:plot] 응원 카드 한 장')).toBe(true)
    expect(isMachineBounty('Translate this document')).toBe(false)
  })

  it("never claims the booth's OWN card-settlement jobs", () => {
    // A booth card job could contain both markers if a recipe name were
    // adversarial — own-output jobs are excluded unconditionally.
    expect(isMachineBounty('[booth:ab12cd34] Pen-plotter postcard [machine:plot]')).toBe(false)
  })
})

describe('extractPlotText — parse BEFORE claiming', () => {
  it('reads a quoted plot: line from the description', () => {
    expect(extractPlotText({ title: '[machine:plot] card', description: 'Please plot: "오늘도 화이팅" on a card' })).toBe('오늘도 화이팅')
  })

  it('reads an unquoted plot: line from the criteria', () => {
    expect(
      extractPlotText({ title: '[machine:plot] card', description: null, acceptanceCriteria: 'plot: 百尺竿头更进一步' }),
    ).toBe('百尺竿头更进一步')
  })

  it('falls back to the title minus the marker', () => {
    expect(extractPlotText({ title: `${MACHINE_PLOT_MARKER} 축하 문구` })).toBe('축하 문구')
  })

  it('returns null for a job it cannot parse — leave it for someone who can', () => {
    expect(extractPlotText({ title: MACHINE_PLOT_MARKER })).toBeNull()
    expect(extractPlotText({ title: `${MACHINE_PLOT_MARKER} ${'가'.repeat(81)}` })).toBeNull()
  })
})

describe('buildMachineSubmission — evidence honesty', () => {
  it('carries the text, the stats, and the disclosed evidence class', () => {
    const out = buildMachineSubmission({
      jobTitle: '[machine:plot] 응원 카드',
      plottedText: '오늘도 화이팅',
      stats: { polylines: 17, points: 900, drawLengthMm: 480.2, travelLengthMm: 200.1, estMinutes: 0.9 },
      machineName: 'vending-booth-plotter',
      plottedAtIso: '2026-08-12T13:00:00.000Z',
    })
    expect(out).toContain('오늘도 화이팅')
    expect(out).toContain('17 polylines')
    // No camera on this machine — the record says so instead of pretending.
    expect(out).toContain('no camera')
    expect(out).toContain('vending-booth-plotter')
  })
})
