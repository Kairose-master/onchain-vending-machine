/**
 * Text → polylines, via a real font's glyph outlines (opentype.js).
 *
 * The font ships in the repo: fonts/NanumPenScript-Regular.ttf — a Korean
 * handwriting face under the SIL OFL (fonts/OFL.txt), so the booth's
 * "calligraphy" is honestly a pen tracing real calligraphic letterforms,
 * not a robotic sans-serif.
 *
 * Output is in FONT UNITS, y-DOWN — gcode.ts owns the mapping to machine
 * coordinates. Bezier curves are flattened here with fixed subdivision;
 * at postcard scale the segment error is far below what a wobbling pen
 * can reproduce anyway.
 */
import { readFile } from 'node:fs/promises'
// opentype.js 2.0 ships a CJS dist whose exports land on `.default` under
// Node's ESM loader, while vitest's transform surfaces them as named
// exports. Unwrap whichever shape arrived; the type package speaks for both.
import * as opentypeNs from 'opentype.js'
import type { Font } from 'opentype.js'
import type { Polyline } from './gcode'

const opentype = ((opentypeNs as { default?: typeof opentypeNs }).default ?? opentypeNs) as typeof opentypeNs

type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' }

const CURVE_SEGMENTS = 12

/** Flatten an opentype path-command stream into polylines. Exported for the
 *  tests, which feed it synthetic commands rather than a whole font. */
export function flattenCommands(commands: PathCommand[]): Polyline[] {
  const polylines: Polyline[] = []
  let current: Array<{ x: number; y: number }> = []
  let start: { x: number; y: number } | null = null

  const pos = () => current[current.length - 1]

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        if (current.length >= 2) polylines.push({ points: current })
        current = [{ x: cmd.x, y: cmd.y }]
        start = { x: cmd.x, y: cmd.y }
        break
      case 'L':
        current.push({ x: cmd.x, y: cmd.y })
        break
      case 'Q': {
        const p0 = pos()
        for (let i = 1; i <= CURVE_SEGMENTS; i++) {
          const t = i / CURVE_SEGMENTS
          const mt = 1 - t
          current.push({
            x: mt * mt * p0.x + 2 * mt * t * cmd.x1 + t * t * cmd.x,
            y: mt * mt * p0.y + 2 * mt * t * cmd.y1 + t * t * cmd.y,
          })
        }
        break
      }
      case 'C': {
        const p0 = pos()
        for (let i = 1; i <= CURVE_SEGMENTS; i++) {
          const t = i / CURVE_SEGMENTS
          const mt = 1 - t
          current.push({
            x: mt ** 3 * p0.x + 3 * mt * mt * t * cmd.x1 + 3 * mt * t * t * cmd.x2 + t ** 3 * cmd.x,
            y: mt ** 3 * p0.y + 3 * mt * mt * t * cmd.y1 + 3 * mt * t * t * cmd.y2 + t ** 3 * cmd.y,
          })
        }
        break
      }
      case 'Z':
        if (start && current.length > 0) current.push({ ...start })
        break
    }
  }
  if (current.length >= 2) polylines.push({ points: current })
  return polylines
}

let cachedFont: { path: string; font: Font } | null = null

export async function loadFont(fontPath: string): Promise<Font> {
  if (cachedFont?.path === fontPath) return cachedFont.font
  const buf = await readFile(fontPath)
  // opentype wants an ArrayBuffer that is exactly the file — a Node Buffer
  // can be a view into a larger pool, so slice to the view's bounds.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const font = opentype.parse(ab)
  cachedFont = { path: fontPath, font }
  return font
}

export interface TextLayoutOptions {
  fontSize: number
  /** Line height as a multiple of fontSize, for multi-line phrases. */
  lineHeight?: number
}

/**
 * Lay out (possibly multi-line) text and return every glyph contour as a
 * polyline. Empty/whitespace-only text returns [] — the caller decides
 * whether that's an error; this layer just refuses to invent strokes.
 */
export function textToPolylines(font: Font, text: string, opts: TextLayoutOptions): Polyline[] {
  const lines = text.split('\n').map((l) => l.trimEnd())
  if (lines.every((l) => l.trim() === '')) return []
  const lineHeight = (opts.lineHeight ?? 1.4) * opts.fontSize

  const polylines: Polyline[] = []
  lines.forEach((line, i) => {
    if (line.trim() === '') return
    const path = font.getPath(line, 0, i * lineHeight, opts.fontSize)
    polylines.push(...flattenCommands(path.commands as PathCommand[]))
  })
  return polylines
}
