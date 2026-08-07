import { describe, expect, it } from 'vitest'
import { flattenCommands, loadFont, textToPolylines } from '../src/plotter/text-to-strokes'

const FONT = new URL('../fonts/NanumPenScript-Regular.ttf', import.meta.url).pathname

describe('flattenCommands', () => {
  it('turns move/line/close into a closed polyline', () => {
    const polys = flattenCommands([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'L', x: 10, y: 10 },
      { type: 'Z' },
    ])
    expect(polys).toHaveLength(1)
    const pts = polys[0].points
    expect(pts[0]).toEqual({ x: 0, y: 0 })
    expect(pts[pts.length - 1]).toEqual({ x: 0, y: 0 }) // Z closes back to start
  })

  it('flattens a quadratic curve through its midpoint', () => {
    const polys = flattenCommands([
      { type: 'M', x: 0, y: 0 },
      { type: 'Q', x1: 5, y1: 10, x: 10, y: 0 },
    ])
    const pts = polys[0].points
    // Bezier midpoint of this arc is (5, 5).
    const mid = pts[Math.floor(pts.length / 2)]
    expect(Math.abs(mid.x - 5)).toBeLessThan(0.6)
    expect(Math.abs(mid.y - 5)).toBeLessThan(0.6)
  })

  it('a second M starts a new polyline', () => {
    const polys = flattenCommands([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 1, y: 1 },
      { type: 'M', x: 5, y: 5 },
      { type: 'L', x: 6, y: 6 },
    ])
    expect(polys).toHaveLength(2)
  })
})

describe('textToPolylines with the real booth font', () => {
  it('renders Korean text into finite strokes', async () => {
    const font = await loadFont(FONT)
    const polys = textToPolylines(font, '안녕하세요', { fontSize: 72 })
    expect(polys.length).toBeGreaterThan(4) // several glyphs, several contours
    for (const poly of polys) {
      expect(poly.points.length).toBeGreaterThanOrEqual(2)
      for (const pt of poly.points) {
        expect(Number.isFinite(pt.x)).toBe(true)
        expect(Number.isFinite(pt.y)).toBe(true)
      }
    }
  })

  it('lays a second line below the first (y-down: below means larger y)', async () => {
    const font = await loadFont(FONT)
    const one = textToPolylines(font, '가', { fontSize: 72 })
    const two = textToPolylines(font, '가\n가', { fontSize: 72 })
    const maxY = (polys: typeof one) => Math.max(...polys.flatMap((p) => p.points.map((pt) => pt.y)))
    expect(maxY(two)).toBeGreaterThan(maxY(one) + 36)
  })

  it('whitespace-only text yields no strokes rather than an empty plot', async () => {
    const font = await loadFont(FONT)
    expect(textToPolylines(font, '   \n  ', { fontSize: 72 })).toEqual([])
  })
})
