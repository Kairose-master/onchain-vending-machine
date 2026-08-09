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

const fontCache = new Map<string, Font>()

export async function loadFont(fontPath: string): Promise<Font> {
  const cached = fontCache.get(fontPath)
  if (cached) return cached
  const buf = await readFile(fontPath)
  // opentype wants an ArrayBuffer that is exactly the file — a Node Buffer
  // can be a view into a larger pool, so slice to the view's bounds.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const font = opentype.parse(ab)
  fontCache.set(fontPath, font)
  return font
}

/**
 * Pick the font that can actually draw this text: highest glyph coverage
 * wins, earlier fonts win ties. A Korean handwriting face has no hanzi and
 * a Chinese one no hangul — a booth in either country meets both scripts,
 * so the chain (FONT_PATH is comma-separated) decides per phrase, not per
 * deployment. Whole-phrase selection on purpose: mixing two fonts inside
 * one card would look like a ransom note.
 */
export function pickFont(fonts: Font[], text: string): Font {
  if (fonts.length === 1) return fonts[0]
  const chars = [...text].filter((c) => c.trim() !== '')
  let best = fonts[0]
  let bestCovered = -1
  for (const font of fonts) {
    // Glyph index 0 is .notdef — the "missing character" box.
    const covered = chars.filter((c) => font.charToGlyph(c).index !== 0).length
    if (covered > bestCovered) {
      best = font
      bestCovered = covered
    }
  }
  return best
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

/** Split `text` into `k` visually balanced lines. Latin text breaks at
 *  spaces (never inside a word); CJK has no spaces and may break anywhere. */
export function wrapIntoLines(text: string, k: number): string[] {
  const words = text.includes(' ') ? text.split(/\s+/).filter(Boolean) : [...text]
  const joiner = text.includes(' ') ? ' ' : ''
  if (k >= words.length) return words.map(String)

  const total = words.reduce((n, w) => n + w.length, 0)
  const target = total / k
  const lines: string[] = []
  let current: string[] = []
  let currentLen = 0
  for (const w of words) {
    // Start a new line once the current one has reached its share — unless
    // doing so would leave more lines than we have words left to fill.
    if (currentLen >= target && lines.length < k - 1) {
      lines.push(current.join(joiner))
      current = []
      currentLen = 0
    }
    current.push(w)
    currentLen += w.length
  }
  lines.push(current.join(joiner))
  return lines
}

/** Ink bounds of a polyline set. */
function inkBounds(polys: Polyline[]) {
  const pts = polys.flatMap((p) => p.points)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

/**
 * Compose lines by their MEASURED ink bounds — each line rendered alone,
 * then stacked with a small gap and centered. Baseline arithmetic wastes
 * the em's empty headroom (a 1.4 line height made two stacked CJK glyphs
 * SMALLER than one row, which is how the first version of the layout
 * picker failed its own test); packing by what the pen actually inks is
 * what lets a square card actually fill.
 */
function stackLines(font: Font, lines: string[], fontSize: number): Polyline[] {
  const gap = fontSize * 0.12
  const rendered = lines
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const polys = flattenCommands(font.getPath(line, 0, 0, fontSize).commands as PathCommand[])
      return { polys, bounds: polys.length > 0 ? inkBounds(polys) : null }
    })
    .filter((r): r is { polys: Polyline[]; bounds: NonNullable<ReturnType<typeof inkBounds>> } => r.bounds !== null)
  if (rendered.length === 0) return []

  const blockWidth = Math.max(...rendered.map((r) => r.bounds.maxX - r.bounds.minX))
  const out: Polyline[] = []
  let y = 0
  for (const { polys, bounds } of rendered) {
    const xShift = (blockWidth - (bounds.maxX - bounds.minX)) / 2 - bounds.minX
    const yShift = y - bounds.minY
    for (const poly of polys) {
      out.push({ points: poly.points.map((p) => ({ x: p.x + xShift, y: p.y + yShift })) })
    }
    y += bounds.maxY - bounds.minY + gap
  }
  return out
}

/**
 * Choose the line count that lets the text sit LARGEST on the paper.
 *
 * The scale a block gets is min(W/w, H/h): a one-line phrase on a square
 * card is wide and short, so the width constraint binds and half the
 * height sits empty — 谢谢 filled 44mm of width but only 22mm of height.
 * Rewrapping into k lines (ink-packed, see stackLines) changes the block's
 * aspect; k = 1..4 are tried against the drawable's aspect and the largest
 * wins. Text with an explicit \n is the customer's own layout: honored
 * verbatim, but still ink-packed so it also fills.
 */
export function bestLayout(
  font: Font,
  text: string,
  opts: TextLayoutOptions,
  drawable: { width: number; height: number },
): Polyline[] {
  if (text.includes('\n')) return stackLines(font, text.split('\n'), opts.fontSize)

  let best: Polyline[] = []
  let bestScale = -Infinity
  const maxLines = Math.min(4, [...text.replace(/\s/g, '')].length)
  for (let k = 1; k <= maxLines; k++) {
    const polylines = stackLines(font, wrapIntoLines(text, k), opts.fontSize)
    if (polylines.length === 0) continue
    const b = inkBounds(polylines)
    const scale = Math.min(
      drawable.width / (b.maxX - b.minX || 1e-9),
      drawable.height / (b.maxY - b.minY || 1e-9),
    )
    if (scale > bestScale) {
      bestScale = scale
      best = polylines
    }
  }
  return best
}
