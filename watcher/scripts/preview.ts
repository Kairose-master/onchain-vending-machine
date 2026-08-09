/**
 * Render a phrase to G-code + an SVG preview without touching the machine.
 * Uses the SAME path as a real plot (font chain included) — a preview that
 * takes a different code path can pass while the real plot fails.
 *
 * Usage: npx tsx scripts/preview.ts "문구"  (\n for line breaks)
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { plotInputToStrokes, plotterEnvFromProcess } from '../src/plotter/plot'
import { polylinesToGcode } from '../src/plotter/gcode'
import { gcodeToSvg } from '../src/plotter/svg-preview'

const text = (process.argv[2] ?? '한셀 온체인 자판기\\n결제 확인, 씁니다').replace(/\\n/g, '\n')
const env = plotterEnvFromProcess(process.env)

const strokes = await plotInputToStrokes({ text }, env)
if ('error' in strokes) {
  console.error('ERROR:', strokes.error)
  process.exit(1)
}
const result = polylinesToGcode(strokes, env.gcode)

writeFileSync('./out/sample.gcode', result.lines.join('\n'))
writeFileSync('./out/sample-preview.svg', gcodeToSvg(result.lines, env.gcode))

console.log('polylines:', result.stats.polylines, 'points:', result.stats.points)
console.log('bounds mm:', JSON.stringify(result.stats.boundsMm))
console.log('draw mm:', result.stats.drawLengthMm.toFixed(0), 'travel mm:', result.stats.travelLengthMm.toFixed(0))
console.log('estimated minutes:', result.stats.estMinutes.toFixed(1))
console.log('gcode lines:', result.lines.length)
console.log('→ out/sample.gcode, out/sample-preview.svg')
