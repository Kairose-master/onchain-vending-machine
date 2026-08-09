/**
 * Image → polylines, for the kiosk's upload lane.
 *
 * Pipeline: sharp normalizes the upload (resize, greyscale, threshold to
 * pure black/white) → potrace vectorizes the black regions into SVG paths
 * → a small path-data parser emits the same command shapes the font lane
 * uses → shared flattening → shared G-code. Everything after the parser is
 * the exact machinery the text lane already exercises.
 *
 * Honest limits, stated where the code lives: this traces OUTLINES of dark
 * regions. Logos, doodles, and line art come out great; photographs reduce
 * to whatever survives a hard threshold — sometimes striking, often mud.
 * The kiosk shows a preview before plotting so the customer decides.
 */
import sharp from 'sharp'
import potrace from 'potrace'
import { flattenCommands } from './text-to-strokes'
import type { Polyline } from './gcode'

type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' }

/**
 * Parse SVG path data (the `d` attribute) into absolute commands.
 * Handles the subset potrace emits (M/L/C/Q/Z, absolute and relative,
 * plus H/V for completeness) — not a general SVG engine on purpose.
 * Exported for tests.
 */
export function parsePathData(d: string): PathCommand[] {
  const out: PathCommand[] = []
  const tokens = d.match(/[MmLlCcQqZzHhVv]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  let i = 0
  let cx = 0, cy = 0
  let startX = 0, startY = 0
  let cmd = ''

  const num = () => Number(tokens[i++])

  while (i < tokens.length) {
    const t = tokens[i]
    if (/^[MmLlCcQqZzHhVv]$/.test(t)) {
      cmd = t
      i++
      if (cmd === 'Z' || cmd === 'z') {
        out.push({ type: 'Z' })
        cx = startX; cy = startY
        continue
      }
    }
    // A command letter followed by multiple coordinate groups repeats.
    switch (cmd) {
      case 'M': cx = num(); cy = num(); out.push({ type: 'M', x: cx, y: cy }); startX = cx; startY = cy; cmd = 'L'; break
      case 'm': cx += num(); cy += num(); out.push({ type: 'M', x: cx, y: cy }); startX = cx; startY = cy; cmd = 'l'; break
      case 'L': cx = num(); cy = num(); out.push({ type: 'L', x: cx, y: cy }); break
      case 'l': cx += num(); cy += num(); out.push({ type: 'L', x: cx, y: cy }); break
      case 'H': cx = num(); out.push({ type: 'L', x: cx, y: cy }); break
      case 'h': cx += num(); out.push({ type: 'L', x: cx, y: cy }); break
      case 'V': cy = num(); out.push({ type: 'L', x: cx, y: cy }); break
      case 'v': cy += num(); out.push({ type: 'L', x: cx, y: cy }); break
      case 'C': {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num(); cx = num(); cy = num()
        out.push({ type: 'C', x1, y1, x2, y2, x: cx, y: cy })
        break
      }
      case 'c': {
        const x1 = cx + num(), y1 = cy + num(), x2 = cx + num(), y2 = cy + num()
        cx += num(); cy += num()
        out.push({ type: 'C', x1, y1, x2, y2, x: cx, y: cy })
        break
      }
      case 'Q': {
        const x1 = num(), y1 = num(); cx = num(); cy = num()
        out.push({ type: 'Q', x1, y1, x: cx, y: cy })
        break
      }
      case 'q': {
        const x1 = cx + num(), y1 = cy + num()
        cx += num(); cy += num()
        out.push({ type: 'Q', x1, y1, x: cx, y: cy })
        break
      }
      default:
        i++ // unknown token — skip rather than derail the whole trace
    }
  }
  return out
}

const TRACE_SIZE = 600 // px — plenty of resolution for a 60mm card

/**
 * Trace an uploaded image (any format sharp reads) into polylines.
 * `threshold` 0-255: lower keeps only the darkest marks, higher pulls in
 * midtones. The kiosk exposes it as a slider with live preview.
 */
export async function imageToPolylines(imageBuffer: Buffer, threshold = 160): Promise<Polyline[]> {
  const prepared = await sharp(imageBuffer)
    .resize(TRACE_SIZE, TRACE_SIZE, { fit: 'inside', withoutEnlargement: false })
    .greyscale()
    .normalise()
    .png()
    .toBuffer()

  const svg = await new Promise<string>((resolve, reject) => {
    potrace.trace(
      prepared,
      { threshold, turdSize: 4, optTolerance: 0.4 },
      (err: Error | null, out: string) => (err ? reject(err) : resolve(out)),
    )
  })

  const polylines: Polyline[] = []
  for (const match of svg.matchAll(/\bd="([^"]+)"/g)) {
    polylines.push(...flattenCommands(parsePathData(match[1]) as Parameters<typeof flattenCommands>[0]))
  }
  return polylines
}
