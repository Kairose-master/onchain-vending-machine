/**
 * The full text→motion pipeline, as one call. server.ts invokes this when
 * a paid credit is redeemed with a phrase.
 */
import { loadFont, textToPolylines } from './text-to-strokes'
import { polylinesToGcode, DEFAULT_GCODE_CONFIG, type GcodeConfig, type GcodeResult } from './gcode'
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
    fontPath: env.FONT_PATH?.trim() || './fonts/NanumPenScript-Regular.ttf',
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
    },
  }
}

export type PlotOutcome =
  | { ok: true; mode: 'machine' | 'dry-run'; detail: string; stats: GcodeResult['stats'] }
  | { ok: false; reason: string }

export async function plotText(text: string, env: PlotterEnv): Promise<PlotOutcome> {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: 'empty text' }
  if (trimmed.length > 80) return { ok: false, reason: 'text too long (max 80 chars) — a postcard is small' }

  const font = await loadFont(env.fontPath)
  const polylines = textToPolylines(font, trimmed, { fontSize: env.fontSize })
  if (polylines.length === 0) {
    // Real case: text made entirely of characters the font has no glyphs
    // for. Refusing beats plotting a row of .notdef boxes on a paid card.
    return { ok: false, reason: 'no drawable strokes for this text (unsupported characters?)' }
  }

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
