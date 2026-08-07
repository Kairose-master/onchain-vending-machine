import { describe, expect, it } from 'vitest'
import { polylinesToGcode, DEFAULT_GCODE_CONFIG, type Polyline } from '../src/plotter/gcode'

const square: Polyline[] = [
  { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }] },
]

/** Every coordinate mentioned in the program, parsed back out. */
function allCoords(lines: string[]): Array<{ x: number; y: number }> {
  return lines
    .map((l) => /^G[01] X([\d.]+) Y([\d.]+)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
}

describe('polylinesToGcode — the escape invariant', () => {
  it('never emits a coordinate outside the work area, for any aspect ratio input', () => {
    const inputs: Polyline[][] = [
      square,
      [{ points: [{ x: -500, y: 200 }, { x: 3000, y: 210 }] }], // very wide
      [{ points: [{ x: 7, y: -900 }, { x: 8, y: 4000 }] }], // very tall
    ]
    for (const input of inputs) {
      const { lines } = polylinesToGcode(input)
      for (const { x, y } of allCoords(lines)) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(DEFAULT_GCODE_CONFIG.workAreaMm.width)
        expect(y).toBeLessThanOrEqual(DEFAULT_GCODE_CONFIG.workAreaMm.height)
      }
    }
  })

  it('respects the margins, not just the paper edge', () => {
    const { stats } = polylinesToGcode(square)
    expect(stats.boundsMm.minX).toBeGreaterThanOrEqual(DEFAULT_GCODE_CONFIG.marginMm - 0.01)
    expect(stats.boundsMm.maxX).toBeLessThanOrEqual(DEFAULT_GCODE_CONFIG.workAreaMm.width - DEFAULT_GCODE_CONFIG.marginMm + 0.01)
  })
})

describe('coordinate mapping', () => {
  it('flips y: the input top (y-down min) lands at the machine top (y-up max)', () => {
    // Two horizontal strokes: input "top" stroke at y=0, "bottom" at y=100.
    const twoLines: Polyline[] = [
      { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }, // top of the glyph
      { points: [{ x: 0, y: 100 }, { x: 100, y: 100 }] }, // bottom
    ]
    const { lines } = polylinesToGcode(twoLines)
    const coords = allCoords(lines)
    // First stroke's Y must be GREATER than the second stroke's Y machine-side.
    const firstStrokeY = coords[0].y
    const lastStrokeY = coords[coords.length - 1].y
    expect(firstStrokeY).toBeGreaterThan(lastStrokeY)
  })

  it('scales uniformly — a square stays square', () => {
    const { stats } = polylinesToGcode(square)
    const w = stats.boundsMm.maxX - stats.boundsMm.minX
    const h = stats.boundsMm.maxY - stats.boundsMm.minY
    expect(Math.abs(w - h)).toBeLessThan(0.01)
  })
})

describe('pen discipline', () => {
  it('pen goes down after arriving at a stroke and up before leaving it', () => {
    const { lines } = polylinesToGcode(square)
    const g0 = lines.findIndex((l) => l.startsWith('G0 X'))
    expect(lines[g0 + 1]).toBe(DEFAULT_GCODE_CONFIG.penDown)
    const lastG1 = lines.map((l, i) => (l.startsWith('G1') ? i : -1)).filter((i) => i >= 0).pop()!
    expect(lines[lastG1 + 1]).toBe(DEFAULT_GCODE_CONFIG.penUp)
  })

  it('custom pen commands pass through verbatim — the seller-firmware escape hatch', () => {
    const { lines } = polylinesToGcode(square, { ...DEFAULT_GCODE_CONFIG, penUp: 'M280 P0 S30', penDown: 'M280 P0 S90' })
    expect(lines).toContain('M280 P0 S30')
    expect(lines).toContain('M280 P0 S90')
    expect(lines.join('\n')).not.toContain('M5')
  })

  it('single-point polylines are dropped, never pen-stabbed', () => {
    const { lines, stats } = polylinesToGcode([{ points: [{ x: 5, y: 5 }] }])
    expect(stats.polylines).toBe(0)
    expect(lines.filter((l) => l.startsWith('G1'))).toHaveLength(0)
  })
})

describe('program shape', () => {
  it('starts in mm+absolute with the pen up, and ends pen-up at origin', () => {
    const { lines } = polylinesToGcode(square)
    expect(lines[0]).toContain('G21')
    expect(lines[1]).toContain('G90')
    expect(lines[2]).toBe(DEFAULT_GCODE_CONFIG.penUp)
    expect(lines[lines.length - 1]).toMatch(/^G0 X0 Y0/)
  })

  it('empty input still yields a safe program', () => {
    const { lines, stats } = polylinesToGcode([])
    expect(stats.polylines).toBe(0)
    expect(lines.some((l) => l === DEFAULT_GCODE_CONFIG.penUp)).toBe(true)
    expect(lines.some((l) => l.startsWith('G1'))).toBe(false)
  })

  it('estimates a plausible duration', () => {
    const { stats } = polylinesToGcode(square)
    expect(stats.estMinutes).toBeGreaterThan(0)
    expect(stats.estMinutes).toBeLessThan(5)
  })

  it('refuses margins that consume the paper', () => {
    expect(() => polylinesToGcode(square, { ...DEFAULT_GCODE_CONFIG, marginMm: 80 })).toThrow(/margins consume/)
  })
})
