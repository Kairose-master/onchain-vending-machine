/**
 * The full text→motion pipeline, as one call. server.ts invokes this when
 * a paid credit is redeemed with a phrase.
 */
import { bestLayout, loadFont, pickFont } from './text-to-strokes'
import { imageToPolylines } from './image-to-strokes'
import { polylinesToGcode, DEFAULT_GCODE_CONFIG, type GcodeConfig, type GcodeResult, type Polyline } from './gcode'
import { streamOverSerial, streamOverTcp, writeGcodeFile } from './grbl-stream'

export interface PlotterEnv {
  fontPath: string
  fontSize: number
  /** "host:port" of the ESP32 GRBL board over WiFi, or empty. */
  tcpTarget: string
  /** Serial device of the board over USB (e.g. /dev/cu.usbserial-10), or
   *  empty. Serial wins when both are set — a plugged cable is the more
   *  deliberate signal. Neither set = dry-run to file. */
  serialTarget: string
  dryRunDir: string
  gcode: GcodeConfig
}

export function plotterEnvFromProcess(env: NodeJS.ProcessEnv): PlotterEnv {
  return {
    // Comma-separated fallback chain; pickFont chooses per phrase.
    fontPath: env.FONT_PATH?.trim() || './fonts/NanumPenScript-Regular.ttf,./fonts/MaShanZheng-Regular.ttf',
    fontSize: Number(env.FONT_SIZE ?? 72),
    tcpTarget: env.PLOTTER_TCP?.trim() || '',
    serialTarget: env.PLOTTER_SERIAL?.trim() || '',
    dryRunDir: env.DRY_RUN_DIR?.trim() || './out',
    gcode: {
      ...DEFAULT_GCODE_CONFIG,
      ...(env.WORK_AREA_MM
        ? (() => {
            const [w, h] = env.WORK_AREA_MM.split('x').map(Number)
            return Number.isFinite(w) && Number.isFinite(h) ? { workAreaMm: { width: w, height: h } } : {}
          })()
        : {}),
      ...(env.PEN_UP_CMD?.trim() ? { penUp: env.PEN_UP_CMD.trim() } : {}),
      ...(env.PEN_DOWN_CMD?.trim() ? { penDown: env.PEN_DOWN_CMD.trim() } : {}),
      ...(Number(env.FEED_DRAW) > 0 ? { feedDrawMmMin: Number(env.FEED_DRAW) } : {}),
      ...(Number(env.FEED_TRAVEL) > 0 ? { feedTravelMmMin: Number(env.FEED_TRAVEL) } : {}),
    },
  }
}

export type PlotOutcome =
  | { ok: true; mode: 'machine' | 'dry-run'; detail: string; stats: GcodeResult['stats'] }
  | { ok: false; reason: string }

/** Text lane: phrase → glyph outlines, via the best-covering font in the
 *  chain (see pickFont — Korean and Chinese handwriting faces coexist). */
export async function textStrokes(text: string, env: PlotterEnv): Promise<Polyline[] | { error: string }> {
  const trimmed = text.trim()
  if (!trimmed) return { error: 'empty text' }
  if (trimmed.length > 80) return { error: 'text too long (max 80 chars) — a postcard is small' }
  const fonts = await Promise.all(
    env.fontPath.split(',').map((p) => p.trim()).filter(Boolean).map((p) => loadFont(p)),
  )
  const font = pickFont(fonts, trimmed)
  // Auto-wrap to fill the paper: the drawable aspect decides how many lines
  // sit largest (see bestLayout). Explicit \n from the customer wins.
  const drawable = {
    width: env.gcode.workAreaMm.width - 2 * env.gcode.marginMm,
    height: env.gcode.workAreaMm.height - 2 * env.gcode.marginMm,
  }
  const polylines = bestLayout(font, trimmed, { fontSize: env.fontSize }, drawable)
  if (polylines.length === 0) {
    // Real case: text made entirely of characters NO font in the chain has
    // glyphs for. Refusing beats plotting a row of .notdef boxes on a paid
    // card.
    return { error: 'no drawable strokes for this text (unsupported characters?)' }
  }
  return polylines
}

/** Image lane: uploaded bitmap → traced outlines. */
export async function imageStrokes(imageBase64: string, threshold: number): Promise<Polyline[] | { error: string }> {
  let buffer: Buffer
  try {
    buffer = Buffer.from(imageBase64.replace(/^data:image\/[a-z+]+;base64,/i, ''), 'base64')
  } catch {
    return { error: 'bad image data' }
  }
  if (buffer.length === 0) return { error: 'empty image' }
  if (buffer.length > 8 * 1024 * 1024) return { error: 'image too large (max 8MB)' }
  let polylines: Polyline[]
  try {
    polylines = await imageToPolylines(buffer, threshold)
  } catch (err) {
    return { error: `could not trace image: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (polylines.length === 0) {
    return { error: 'nothing traceable at this threshold — try adjusting it' }
  }
  return polylines
}

export interface PlotInput {
  text?: string
  imageBase64?: string
  /** potrace threshold 0-255 for the image lane. */
  threshold?: number
}

export async function plotInputToStrokes(input: PlotInput, env: PlotterEnv): Promise<Polyline[] | { error: string }> {
  if (input.imageBase64) return imageStrokes(input.imageBase64, input.threshold ?? 160)
  return textStrokes(input.text ?? '', env)
}

export async function plotText(text: string, env: PlotterEnv): Promise<PlotOutcome> {
  return plot({ text }, env)
}

export async function plot(input: PlotInput, env: PlotterEnv): Promise<PlotOutcome> {
  const strokes = await plotInputToStrokes(input, env)
  if ('error' in strokes) return { ok: false, reason: strokes.error }
  const polylines = strokes

  const result = polylinesToGcode(polylines, env.gcode)

  if (env.serialTarget) {
    await streamOverSerial(result.lines, env.serialTarget)
    return { ok: true, mode: 'machine', detail: env.serialTarget, stats: result.stats }
  }

  if (env.tcpTarget) {
    const [host, portRaw] = env.tcpTarget.split(':')
    const port = Number(portRaw ?? 23)
    if (!host || !Number.isFinite(port)) return { ok: false, reason: `bad PLOTTER_TCP: ${env.tcpTarget}` }
    await streamOverTcp(result.lines, host, port)
    return { ok: true, mode: 'machine', detail: `${host}:${port}`, stats: result.stats }
  }

  const path = `${env.dryRunDir}/plot-${Date.now()}.gcode`
  await writeGcodeFile(result.lines, path)
  return { ok: true, mode: 'dry-run', detail: path, stats: result.stats }
}
