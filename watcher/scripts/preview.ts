import { loadFont, textToPolylines } from '../src/plotter/text-to-strokes'
import { polylinesToGcode, DEFAULT_GCODE_CONFIG } from '../src/plotter/gcode'
import { writeFileSync } from 'node:fs'

const font = await loadFont('./fonts/NanumPenScript-Regular.ttf')
const text = process.argv[2]?.replace(/\\n/g, '\n') ?? '한셀 온체인 자판기\n결제 확인, 씁니다'
const polys = textToPolylines(font, text, { fontSize: 72 })
const result = polylinesToGcode(polys, DEFAULT_GCODE_CONFIG)

writeFileSync('./out/sample.gcode', result.lines.join('\n'))

// SVG preview in MACHINE coordinates (y flipped back for screen display).
const { width, height } = DEFAULT_GCODE_CONFIG.workAreaMm
const paths: string[] = []
let current: string[] = []
for (const line of result.lines) {
  const g0 = /^G0 X([\d.]+) Y([\d.]+)/.exec(line)
  const g1 = /^G1 X([\d.]+) Y([\d.]+)/.exec(line)
  if (g0) {
    if (current.length > 1) paths.push(current.join(' '))
    current = [`M ${g0[1]} ${(height - Number(g0[2])).toFixed(2)}`]
  } else if (g1) {
    current.push(`L ${g1[1]} ${(height - Number(g1[2])).toFixed(2)}`)
  }
}
if (current.length > 1) paths.push(current.join(' '))

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width * 6}" height="${height * 6}">
<rect width="${width}" height="${height}" fill="#fdfbf7" stroke="#ccc" stroke-width="0.5"/>
${paths.map((d) => `<path d="${d}" fill="none" stroke="#1a1a2e" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round"/>`).join('\n')}
</svg>`
writeFileSync('./out/sample-preview.svg', svg)

console.log('polylines:', result.stats.polylines, 'points:', result.stats.points)
console.log('bounds mm:', JSON.stringify(result.stats.boundsMm))
console.log('draw mm:', result.stats.drawLengthMm.toFixed(0), 'travel mm:', result.stats.travelLengthMm.toFixed(0))
console.log('estimated minutes:', result.stats.estMinutes.toFixed(1))
console.log('gcode lines:', result.lines.length)
