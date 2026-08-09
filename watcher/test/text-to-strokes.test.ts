import { describe, expect, it } from 'vitest'
import { bestLayout, flattenCommands, loadFont, pickFont, textToPolylines, wrapIntoLines } from '../src/plotter/text-to-strokes'

const FONT = new URL('../fonts/NanumPenScript-Regular.ttf', import.meta.url).pathname
const FONT_CN = new URL('../fonts/MaShanZheng-Regular.ttf', import.meta.url).pathname

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

describe('pickFont — the Korean/Chinese fallback chain', () => {
  it('picks the Korean face for hangul and the Chinese face for hanzi', async () => {
    const kr = await loadFont(FONT)
    const cn = await loadFont(FONT_CN)
    expect(pickFont([kr, cn], '안녕하세요')).toBe(kr)
    expect(pickFont([kr, cn], '谢谢')).toBe(cn)
  })

  it('earlier font wins ties (Latin text both fonts cover)', async () => {
    const kr = await loadFont(FONT)
    const cn = await loadFont(FONT_CN)
    expect(pickFont([kr, cn], 'hello')).toBe(kr)
  })

  it('the Chinese face actually yields strokes for 谢谢 — the exact phrase that failed on the booth', async () => {
    const cn = await loadFont(FONT_CN)
    const polys = textToPolylines(cn, '谢谢', { fontSize: 72 })
    expect(polys.length).toBeGreaterThan(2)
  })
})

describe('wrapIntoLines', () => {
  it('CJK breaks anywhere, evenly', () => {
    expect(wrapIntoLines('가나다라', 2)).toEqual(['가나', '다라'])
  })
  it('Latin never breaks inside a word', () => {
    const lines = wrapIntoLines('hello onchain world', 2)
    expect(lines.join(' ')).toBe('hello onchain world')
    for (const l of lines) expect(l).toMatch(/^[a-z ]+$/)
  })
})

describe('bestLayout — fill the paper', () => {
  const drawable = { width: 44, height: 44 } // the 60x60 booth minus margins

  const scaleOf = (polys: ReturnType<typeof textToPolylines>) => {
    const pts = polys.flatMap((p) => p.points)
    const w = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x))
    const h = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y))
    return Math.min(drawable.width / w, drawable.height / h)
  }

  it('stacks 谢谢 into two lines on a square card — the glyphs come out larger', async () => {
    const cn = await loadFont(FONT_CN)
    const single = textToPolylines(cn, '谢谢', { fontSize: 72 })
    const auto = bestLayout(cn, '谢谢', { fontSize: 72 }, drawable)
    expect(scaleOf(auto)).toBeGreaterThan(scaleOf(single))
  })

  it('never rewraps text that carries an explicit newline — the customer laid it out', async () => {
    const kr = await loadFont(FONT)
    const manual = textToPolylines(kr, '안녕\n하세요', { fontSize: 72 })
    const kept = bestLayout(kr, '안녕\n하세요', { fontSize: 72 }, drawable)
    expect(kept.length).toBe(manual.length)
  })

  it('a single character stays a single line', async () => {
    const kr = await loadFont(FONT)
    expect(bestLayout(kr, '가', { fontSize: 72 }, drawable).length).toBeGreaterThan(0)
  })
})
