/**
 * Render a generated G-code program back into an SVG of what the pen will
 * draw — the kiosk's "이대로 그릴까요?" screen. Parsing the PROGRAM (not the
 * input strokes) on purpose: the preview shows exactly what the machine
 * will receive, scaling and margins included, so what you approve is what
 * plots.
 */
import type { GcodeConfig } from './gcode'

export function gcodeToSvg(lines: string[], config: GcodeConfig): string {
  const { width, height } = config.workAreaMm
  const paths: string[] = []
  let current: string[] = []

  for (const line of lines) {
    const g0 = /^G0 X([\d.]+) Y([\d.]+)/.exec(line)
    const g1 = /^G1 X([\d.]+) Y([\d.]+)/.exec(line)
    if (g0) {
      if (current.length > 1) paths.push(current.join(' '))
      // Machine y-up → screen y-down for display.
      current = [`M ${g0[1]} ${(height - Number(g0[2])).toFixed(2)}`]
    } else if (g1) {
      current.push(`L ${g1[1]} ${(height - Number(g1[2])).toFixed(2)}`)
    }
  }
  if (current.length > 1) paths.push(current.join(' '))

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#fdfbf7" stroke="#ccc" stroke-width="0.5"/>
${paths.map((d) => `<path d="${d}" fill="none" stroke="#1a1a2e" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"/>`).join('\n')}
</svg>`
}
