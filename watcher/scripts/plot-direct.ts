/**
 * Operator setup tool: plot a phrase straight to the machine, NO payment
 * queue involved. For calibration and bring-up only — the booth flow is
 * the server's /plot, which requires a paid credit. Keeping the bypass in
 * scripts/ (not an HTTP route) is deliberate: it exists on the operator's
 * laptop, not on the machine's API surface.
 *
 * Usage:
 *   npx tsx scripts/plot-direct.ts "문구"           # uses .env for target/config
 *   npx tsx scripts/plot-direct.ts "두\n줄"         # \n for line breaks
 */
import 'dotenv/config'
import { plotText, plotterEnvFromProcess } from '../src/plotter/plot'

const text = process.argv[2]?.replace(/\\n/g, '\n')
if (!text) {
  console.error('usage: npx tsx scripts/plot-direct.ts "문구"')
  process.exit(1)
}

const env = plotterEnvFromProcess(process.env)
console.log(`[plot-direct] target: ${env.serialTarget || env.tcpTarget || `dry-run → ${env.dryRunDir}/`}`)
console.log(`[plot-direct] work area: ${env.gcode.workAreaMm.width}x${env.gcode.workAreaMm.height}mm, pen: "${env.gcode.penDown}" / "${env.gcode.penUp}"`)

const outcome = await plotText(text, env)
console.log(JSON.stringify(outcome, null, 2))
process.exit(outcome.ok ? 0 : 1)
