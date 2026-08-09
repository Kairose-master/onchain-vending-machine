import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { imageToPolylines, parsePathData } from '../src/plotter/image-to-strokes'

describe('parsePathData', () => {
  it('parses absolute move/line/close', () => {
    const cmds = parsePathData('M 10 20 L 30 20 L 30 40 Z')
    expect(cmds).toEqual([
      { type: 'M', x: 10, y: 20 },
      { type: 'L', x: 30, y: 20 },
      { type: 'L', x: 30, y: 40 },
      { type: 'Z' },
    ])
  })

  it('parses relative commands against the running point', () => {
    const cmds = parsePathData('m 10 10 l 5 0 l 0 5')
    expect(cmds).toEqual([
      { type: 'M', x: 10, y: 10 },
      { type: 'L', x: 15, y: 10 },
      { type: 'L', x: 15, y: 15 },
    ])
  })

  it('repeats the previous command for extra coordinate groups (SVG shorthand)', () => {
    // "M 0 0 10 10 20 20" = move, then implicit LINES to (10,10), (20,20).
    const cmds = parsePathData('M 0 0 10 10 20 20')
    expect(cmds).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 10 },
      { type: 'L', x: 20, y: 20 },
    ])
  })

  it('parses cubic curves, absolute and relative alike', () => {
    const abs = parsePathData('M 0 0 C 1 2 3 4 5 6')
    expect(abs[1]).toEqual({ type: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 })
    const rel = parsePathData('M 10 10 c 1 2 3 4 5 6')
    expect(rel[1]).toEqual({ type: 'C', x1: 11, y1: 12, x2: 13, y2: 14, x: 15, y: 16 })
  })

  it('handles H/V shorthands', () => {
    const cmds = parsePathData('M 5 5 H 20 V 30')
    expect(cmds).toEqual([
      { type: 'M', x: 5, y: 5 },
      { type: 'L', x: 20, y: 5 },
      { type: 'L', x: 20, y: 30 },
    ])
  })
})

describe('imageToPolylines with a synthetic image', () => {
  it('traces a black square into a closed contour of sane bounds', async () => {
    // A white 200x200 canvas with a black 100x100 square in the middle —
    // the simplest thing a trace must not miss.
    const img = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
          }).png().toBuffer(),
          left: 50,
          top: 50,
        },
      ])
      .png()
      .toBuffer()

    const polylines = await imageToPolylines(img)
    expect(polylines.length).toBeGreaterThanOrEqual(1)
    const allPoints = polylines.flatMap((p) => p.points)
    expect(allPoints.length).toBeGreaterThan(3)
    for (const pt of allPoints) {
      expect(Number.isFinite(pt.x)).toBe(true)
      expect(Number.isFinite(pt.y)).toBe(true)
    }
    // The square's contour should span a substantial part of the traced
    // canvas — a degenerate speck would betray a broken threshold.
    const xs = allPoints.map((p) => p.x)
    const span = Math.max(...xs) - Math.min(...xs)
    expect(span).toBeGreaterThan(100)
  })

  it('an all-white image traces to nothing rather than garbage', async () => {
    const img = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer()
    const polylines = await imageToPolylines(img)
    expect(polylines).toEqual([])
  })
})
