/**
 * Polylines → G-code. Pure — no font, no network, no clock — so the whole
 * money-to-motion translation is testable without a machine.
 *
 * Coordinate contract: input polylines are in FONT units, y-DOWN (canvas
 * convention, which is what opentype.js emits). This module scales them
 * uniformly to fit the work area minus margins, centers them, and flips to
 * y-UP (machine convention, origin at front-left). The invariant the tests
 * pin: no emitted coordinate ever leaves [0, workArea] on either axis — a
 * G-code line that escapes the paper is a pen dragging across the booth
 * table.
 *
 * Pen up/down are CONFIG STRINGS, not constants: the kit's seller said the
 * Z-servo commands are their own firmware modification, so the exact
 * commands bind on arrival day by editing config, not code.
 */

export interface Polyline {
  points: Array<{ x: number; y: number }>
}

export interface GcodeConfig {
  workAreaMm: { width: number; height: number }
  marginMm: number
  penUp: string
  penDown: string
  /** Dwell after a pen transition, letting the servo physically arrive
   *  before the carriage moves — without it the first mm of every stroke
   *  is drawn with the pen mid-air or mid-drop. */
  penDwellSec: number
  feedDrawMmMin: number
  feedTravelMmMin: number
}

export const DEFAULT_GCODE_CONFIG: GcodeConfig = {
  // Postcard, landscape. The kit's exact 行程 replaces this when known.
  workAreaMm: { width: 150, height: 100 },
  marginMm: 8,
  // Placeholders — the seller's custom servo firmware decides the real
  // strings (M3 Sxxx / M5 / M280...). One config edit on arrival day.
  penUp: 'M5',
  penDown: 'M3 S1000',
  penDwellSec: 0.2,
  feedDrawMmMin: 1500,
  feedTravelMmMin: 3000,
}

export interface GcodeResult {
  lines: string[]
  stats: {
    polylines: number
    points: number
    /** Drawing bounds after scaling, in machine mm (y-up). */
    boundsMm: { minX: number; minY: number; maxX: number; maxY: number }
    drawLengthMm: number
    travelLengthMm: number
    estMinutes: number
  }
}

const fmt = (n: number) => n.toFixed(2)

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Generate a complete, self-contained G-code program.
 *
 * Degenerate polylines (fewer than 2 points) are dropped — a zero-length
 * stroke would still cycle the pen, stabbing a dot the font never drew.
 */
export function polylinesToGcode(input: Polyline[], config: GcodeConfig = DEFAULT_GCODE_CONFIG): GcodeResult {
  const polylines = input.filter((p) => p.points.length >= 2)

  const drawable = {
    width: config.workAreaMm.width - 2 * config.marginMm,
    height: config.workAreaMm.height - 2 * config.marginMm,
  }
  if (drawable.width <= 0 || drawable.height <= 0) {
    throw new Error('margins consume the entire work area — check workAreaMm vs marginMm')
  }

  // Input bounds (font units, y-down).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const poly of polylines) {
    for (const pt of poly.points) {
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
        throw new Error('non-finite point in polyline input')
      }
      minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x)
      minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y)
    }
  }

  const preamble = [
    'G21 ; mm',
    'G90 ; absolute',
    config.penUp,
    `G4 P${fmt(config.penDwellSec)}`,
  ]
  const postamble = [config.penUp, `G4 P${fmt(config.penDwellSec)}`, `G0 X0 Y0 F${config.feedTravelMmMin}`]

  if (polylines.length === 0) {
    return {
      lines: [...preamble, ...postamble],
      stats: { polylines: 0, points: 0, boundsMm: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, drawLengthMm: 0, travelLengthMm: 0, estMinutes: 0 },
    }
  }

  const srcW = maxX - minX
  const srcH = maxY - minY
  // Uniform scale: text must not stretch. A single glyph (srcH or srcW ~ 0)
  // still works because the other axis bounds the scale.
  const scale = Math.min(
    drawable.width / (srcW || 1e-9),
    drawable.height / (srcH || 1e-9),
  )
  const outW = srcW * scale
  const outH = srcH * scale
  const offsetX = config.marginMm + (drawable.width - outW) / 2
  const offsetY = config.marginMm + (drawable.height - outH) / 2

  // Font y-down → machine y-up: a point at the input's TOP (minY) must land
  // at the output's TOP (maxY machine-side).
  const map = (pt: { x: number; y: number }) => ({
    x: offsetX + (pt.x - minX) * scale,
    y: offsetY + (maxY - pt.y) * scale,
  })

  const lines = [...preamble]
  let drawLength = 0
  let travelLength = 0
  let head = { x: 0, y: 0 }
  let outMinX = Infinity, outMinY = Infinity, outMaxX = -Infinity, outMaxY = -Infinity

  for (const poly of polylines) {
    const mapped = poly.points.map(map)
    for (const pt of mapped) {
      outMinX = Math.min(outMinX, pt.x); outMaxX = Math.max(outMaxX, pt.x)
      outMinY = Math.min(outMinY, pt.y); outMaxY = Math.max(outMaxY, pt.y)
    }

    travelLength += dist(head, mapped[0])
    lines.push(`G0 X${fmt(mapped[0].x)} Y${fmt(mapped[0].y)} F${config.feedTravelMmMin}`)
    lines.push(config.penDown, `G4 P${fmt(config.penDwellSec)}`)
    for (let i = 1; i < mapped.length; i++) {
      drawLength += dist(mapped[i - 1], mapped[i])
      lines.push(`G1 X${fmt(mapped[i].x)} Y${fmt(mapped[i].y)} F${config.feedDrawMmMin}`)
    }
    lines.push(config.penUp, `G4 P${fmt(config.penDwellSec)}`)
    head = mapped[mapped.length - 1]
  }

  travelLength += dist(head, { x: 0, y: 0 })
  lines.push(...postamble.slice(2)) // pen is already up after the last stroke; just go home

  return {
    lines,
    stats: {
      polylines: polylines.length,
      points: polylines.reduce((n, p) => n + p.points.length, 0),
      boundsMm: { minX: outMinX, minY: outMinY, maxX: outMaxX, maxY: outMaxY },
      drawLengthMm: drawLength,
      travelLengthMm: travelLength,
      estMinutes: drawLength / config.feedDrawMmMin + travelLength / config.feedTravelMmMin,
    },
  }
}
