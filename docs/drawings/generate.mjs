#!/usr/bin/env node
/**
 * Dispenser working drawings — generated, not drawn.
 *
 * Every dimension below is derived from FOUR numbers: the product's W/D/T and
 * the cardboard thickness. Change the product and the whole drawing follows,
 * which is the point — a hand-drawn sheet goes stale the first time the goods
 * change, and then somebody cuts to it anyway.
 *
 * Labels are English on purpose: this container has no CJK font, so Korean
 * text would render as blank boxes in the PNG. The Korean walkthrough lives in
 * `docs/dispenser-build.ko.md`; this file is the dimensioned sheet you cut to.
 *
 *   node docs/drawings/generate.mjs        # writes dispenser-v1.svg
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── inputs ──────────────────────────────────────────────────────────────────
const P = { W: 60, D: 60, T: 10 } // product: sticker pack 60×60×10mm
const t = 5 // double-wall cardboard thickness
const STOCK = 8 // how many items one magazine holds

// ── derived (see docs/dispenser-build.ko.md §5.2 for the reasoning) ─────────
const innerW = P.W + 5 // 5mm clearance, more and the item tilts and jams
const innerD = P.D + 5
const magW = innerW + 2 * t // outer footprint
const magD = innerD + 2 * t
const magH = P.T * STOCK + 40
const outlet = P.T + 5 // front panel is lifted this much off the base
const frontH = magH - outlet
const shaftY = 20 // servo shaft, from the base plate's back edge
const magBack = shaftY + 10 // magazine's outer back face
const baseD = magBack + magD // base plate ends FLUSH with the front panel
const armR = 65 // pusher arm, shaft centre → tip
const pitch = magW + 10
const baseW = pitch * 3 + magW + 20
const servoX = [0, 1, 2, 3].map((i) => 10 + magW / 2 + i * pitch)
const SERVO = { body: 23, width: 13, height: 23 } // SG90

// The falling test, asserted rather than assumed: the item leaves when its
// centre of mass passes the base plate's front edge. The item's back face
// starts at the magazine's INNER back wall, not at the shaft — getting that
// wrong understates the travel and hides a too-short arm.
const comStart = magBack + t + P.D / 2
const comEnd = shaftY + armR + P.D / 2
if (comEnd <= baseD) throw new Error(`arm too short: CoM ends at ${comEnd}mm, front edge is ${baseD}mm`)
if (shaftY + armR <= magBack + t) throw new Error('arm cannot reach the item')

// ── svg helpers ─────────────────────────────────────────────────────────────
const S = 2.2 // px per mm
const out = []
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const px = (mm) => +(mm * S).toFixed(2)

const P_ = {
  ink: '#1a1a1a',
  thin: '#7a7a7a',
  dim: '#c2410c',
  ghost: '#9ca3af',
  fill: '#f8fafc',
  item: '#dbeafe',
  servo: '#fde68a',
  bg: '#ffffff',
}

function rect(x, y, w, h, o = {}) {
  out.push(
    `<rect x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" fill="${o.fill ?? 'none'}" stroke="${o.stroke ?? P_.ink}" stroke-width="${o.sw ?? 1.6}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`,
  )
}
function line(x1, y1, x2, y2, o = {}) {
  out.push(
    `<line x1="${px(x1)}" y1="${px(y1)}" x2="${px(x2)}" y2="${px(y2)}" stroke="${o.stroke ?? P_.ink}" stroke-width="${o.sw ?? 1.4}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`,
  )
}
function txt(x, y, s, o = {}) {
  out.push(
    `<text x="${px(x)}" y="${px(y)}" font-family="DejaVu Sans, sans-serif" font-size="${o.size ?? 11}" fill="${o.fill ?? P_.ink}" text-anchor="${o.anchor ?? 'start'}"${o.weight ? ` font-weight="${o.weight}"` : ''}>${esc(s)}</text>`,
  )
}
/** Horizontal dimension line with ticks and a centred label. */
function dimH(x1, x2, y, label) {
  line(x1, y, x2, y, { stroke: P_.dim, sw: 1 })
  for (const x of [x1, x2]) line(x, y - 2, x, y + 2, { stroke: P_.dim, sw: 1 })
  txt((x1 + x2) / 2, y - 2.5, label, { anchor: 'middle', size: 10, fill: P_.dim })
}
function dimV(y1, y2, x, label) {
  line(x, y1, x, y2, { stroke: P_.dim, sw: 1 })
  for (const y of [y1, y2]) line(x - 2, y, x + 2, y, { stroke: P_.dim, sw: 1 })
  out.push(
    `<text x="${px(x - 3)}" y="${px((y1 + y2) / 2)}" font-family="DejaVu Sans, sans-serif" font-size="10" fill="${P_.dim}" text-anchor="middle" transform="rotate(-90 ${px(x - 3)} ${px((y1 + y2) / 2)})">${esc(label)}</text>`,
  )
}
function title(x, y, n, s) {
  txt(x, y, `${n}. ${s}`, { size: 15, weight: 'bold' })
}
function note(x, y, s) {
  txt(x, y, s, { size: 10, fill: P_.thin })
}

// ── panel 1: cut sheet ──────────────────────────────────────────────────────
let oy = 18
title(10, oy, 1, `CUT SHEET — product ${P.W}x${P.D}x${P.T}mm, cardboard ${t}mm`)
note(10, oy + 9, `Every piece below. Cut all of them before gluing anything: a magazine glued early is a magazine you cannot square up.`)
oy += 22

const pieces = [
  { n: 'SIDE panel', w: magD, h: magH, qty: 8, per: '2 per slot' },
  { n: 'BACK panel', w: innerW, h: magH, qty: 4, per: '1 per slot — slot cut at the base' },
  { n: 'FRONT panel', w: innerW, h: frontH, qty: 4, per: `1 per slot — SHORT by ${outlet}mm` },
  { n: 'PUSHER arm', w: 15, h: armR, qty: 4, per: '2 plies + a stick' },
]
let cx = 14
for (const p of pieces) {
  const y = oy + 12
  rect(cx, y, p.w, p.h, { fill: P_.fill })
  if (p.n.startsWith('BACK')) {
    // The arm's doorway, FLUSH with the bottom edge. Leaving even 2mm of
    // material below it puts cardboard in the path of the arm, which sits at
    // 0..T because it has to contact the full face of the bottom item.
    rect(cx + (p.w - 30) / 2, y + p.h - 12, 30, 12, { fill: '#fff', dash: '4 3' })
    txt(cx + p.w / 2, y + p.h - 15, 'arm slot 30x12, flush', { anchor: 'middle', size: 8, fill: P_.thin })
  }
  if (p.n.startsWith('PUSHER')) {
    line(cx + 7.5, y + 6, cx + 7.5, y + p.h - 4, { stroke: P_.ghost, dash: '3 3' })
    txt(cx + p.w + 3, y + 14, 'stick', { size: 8, fill: P_.thin })
    out.push(`<circle cx="${px(cx + p.w / 2)}" cy="${px(y + 7)}" r="${px(3)}" fill="none" stroke="${P_.ink}" stroke-width="1.4"/>`)
    txt(cx + p.w + 3, y + 6, 'horn screw', { size: 8, fill: P_.thin })
  }
  dimH(cx, cx + p.w, y - 3, `${p.w}`)
  dimV(y, y + p.h, cx - 3.5, `${p.h}`)
  txt(cx, y + p.h + 10, p.n, { size: 11, weight: 'bold' })
  txt(cx, y + p.h + 19, `x${p.qty}  (${p.per})`, { size: 9, fill: P_.thin })
  cx += p.w + 34
}
// base plate, referenced rather than drawn — at this scale it would be twice
// the width of the sheet, and a box drawn to the wrong size is worse than none
{
  const y = oy + 12
  rect(cx, y, 90, magH, { fill: '#fff', dash: '6 4', stroke: P_.ghost })
  txt(cx + 45, y + magH / 2 - 6, 'NOT TO SCALE', { anchor: 'middle', size: 10, fill: P_.ghost })
  txt(cx + 45, y + magH / 2 + 6, 'see panel 4', { anchor: 'middle', size: 10, fill: P_.ghost })
  txt(cx, y + magH + 10, 'BASE PLATE', { size: 11, weight: 'bold' })
  txt(cx, y + magH + 19, `x1  ${baseW} x ${baseD}mm`, { size: 9, fill: P_.thin })
}
oy += magH + 46

// ── panel 2: side section ───────────────────────────────────────────────────
title(10, oy, 2, 'SIDE SECTION — one slot, cut through the middle')
note(10, oy + 9, 'The servo drops THROUGH the base plate. That is what puts the shaft at the height of the item, and it is the part a flat-mounted servo gets wrong.')
oy += 20

const sx = 60
const sy = oy + 16
const floor = sy + magH
// magazine walls
rect(sx + magBack, sy, t, magH, { fill: P_.fill }) // back panel
rect(sx + magBack + magD - t, sy + outlet, t, frontH, { fill: P_.fill }) // front panel, lifted
line(sx, floor, sx + baseD, floor, { sw: 2.4 }) // base plate

// stacked items
for (let i = 0; i < 5; i++) {
  const y = floor - P.T * (i + 1)
  rect(sx + magBack + t, y, P.D, P.T, { fill: P_.item, sw: 1.2 })
}
txt(sx + magBack + t + P.D / 2, floor - P.T * 5 - 4, `${STOCK} items max`, { anchor: 'middle', size: 9, fill: P_.thin })

// the outlet
dimV(floor - outlet, floor, sx + magBack + magD + 14, `outlet ${outlet}`)
line(sx + magBack + magD, floor - outlet, sx + magBack + magD + 12, floor - outlet, { stroke: P_.dim, sw: 0.8, dash: '3 2' })
txt(sx + magBack + magD + 20, floor - 1, 'base plate', { size: 9, fill: P_.thin })

// servo through the plate — the shaft line stops short of the stack so the
// label has somewhere to sit that is not on top of the items
rect(sx + shaftY - SERVO.width / 2, floor, SERVO.width, SERVO.height, { fill: P_.servo, sw: 1.4 })
line(sx + shaftY - 9, floor, sx + shaftY + 9, floor, { sw: 2.4 })
txt(sx + shaftY - 14, floor + 16, 'SG90 hangs below the plate', { size: 9, fill: P_.thin })
out.push(`<circle cx="${px(sx + shaftY)}" cy="${px(floor - P.T / 2)}" r="${px(2)}" fill="${P_.ink}"/>`)
line(sx + shaftY, floor - P.T / 2, sx + magBack, floor - P.T / 2, { stroke: P_.ghost, dash: '5 3' })
txt(sx + shaftY - 14, floor - P.T / 2 - 6, `shaft ${P.T / 2}mm up = item centre`, { size: 9, fill: P_.dim })

dimH(sx, sx + baseD, floor + 40, `base depth ${baseD}`)
dimH(sx + magBack, sx + magBack + magD, sy - 4, `magazine ${magD}`)
dimV(sy, floor, sx + magBack - 8, `${magH}`)
note(sx, floor + 56, `Front panel is ${frontH}mm, not ${magH}mm — the ${outlet}mm gap under it IS the outlet. Only one item fits through.`)
oy = floor + 74

// ── panel 3: top view ───────────────────────────────────────────────────────
title(10, oy, 3, 'TOP VIEW — the pusher sweep')
note(10, oy + 9, 'The arm rests BEHIND the magazines, clear of the stack, and sweeps 90 degrees to push. Nothing blocks the drop while it is parked.')
oy += 20

// Headroom for the parked arm, which reaches `armR` above the slot's centre
// line — without it the REST label lands on the panel title.
const tx = 60
const ty = oy + armR - magW / 2 + 14
rect(tx + magBack, ty, magD, magW, { fill: 'none', sw: 1.8 })
rect(tx + magBack + t, ty + t, innerD, innerW, { fill: P_.fill, dash: '4 3' })
rect(tx + magBack + t, ty + t, P.D, P.W, { fill: P_.item, sw: 1.2 })
txt(tx + magBack + t + P.D / 2, ty + t + P.W / 2 + 3, 'item', { anchor: 'middle', size: 9 })

const shaftCX = tx + shaftY
const shaftCY = ty + magW / 2
out.push(`<circle cx="${px(shaftCX)}" cy="${px(shaftCY)}" r="${px(3)}" fill="${P_.servo}" stroke="${P_.ink}" stroke-width="1.4"/>`)
txt(shaftCX - 4, shaftCY - 6, 'shaft', { anchor: 'end', size: 9 })
// rest position (parallel to the back edge) and engaged (pointing at the item)
line(shaftCX, shaftCY, shaftCX, shaftCY - armR, { stroke: P_.ghost, sw: 3 })
txt(shaftCX + 3, shaftCY - armR - 3, 'REST (0 deg) — parked behind', { size: 9, fill: P_.thin })
line(shaftCX, shaftCY, shaftCX + armR, shaftCY, { stroke: P_.dim, sw: 3 })
txt(shaftCX + armR + 4, shaftCY + 3, 'PUSH (90 deg)', { size: 9, fill: P_.dim })
out.push(
  `<path d="M ${px(shaftCX)} ${px(shaftCY - armR)} A ${px(armR)} ${px(armR)} 0 0 1 ${px(shaftCX + armR)} ${px(shaftCY)}" fill="none" stroke="${P_.dim}" stroke-width="1" stroke-dasharray="4 3"/>`,
)
dimH(shaftCX, shaftCX + armR, shaftCY + magW / 2 + 12, `arm ${armR}`)
line(tx + baseD, ty - 4, tx + baseD, ty + magW + 8, { stroke: P_.ghost, dash: '5 3' })
txt(tx + baseD + 3, ty + magW + 14, 'base plate ends here — the item tips off', { size: 9, fill: P_.thin })
note(tx, ty + magW + 30, `Item centre of mass travels ${comStart} -> ${comEnd}mm. The edge is at ${baseD}mm, so it clears by ${comEnd - baseD}mm and falls.`)
oy = ty + magW + 48

// ── panel 4: layout + wiring ────────────────────────────────────────────────
title(10, oy, 4, `LAYOUT — 4 slots on one ${baseW} x ${baseD}mm plate`)
note(10, oy + 9, 'Slot 1 on the LEFT, matching GPIO 18/19/21/22 and the kiosk slot numbers. An operator who has to translate slot numbers will eventually restock the wrong one.')
oy += 22

// The four servo-position dimensions stack upward, so the plate needs that
// much clearance under the panel note.
const lx = 24
const ly = oy + 34
rect(lx, ly, baseW, baseD, { fill: P_.fill, sw: 2 })
for (let i = 0; i < 4; i++) {
  const x = lx + 10 + i * pitch
  rect(x, ly + magBack, magW, magD, { sw: 1.6 })
  rect(x + t, ly + magBack + t, innerW, innerD, { dash: '4 3', stroke: P_.ghost })
  txt(x + magW / 2, ly + magBack + magD / 2 + 4, `SLOT ${i + 1}`, { anchor: 'middle', size: 11, weight: 'bold' })
  // servo cut-out
  rect(servoX[i] + lx - SERVO.body / 2, ly + shaftY - SERVO.width / 2, SERVO.body, SERVO.width, { fill: P_.servo, sw: 1.4 })
  txt(servoX[i] + lx, ly + shaftY - SERVO.width / 2 - 3, `GPIO ${[18, 19, 21, 22][i]}`, { anchor: 'middle', size: 9, fill: P_.thin })
  dimH(lx, servoX[i] + lx, ly - 4 - i * 7, `${servoX[i]}`)
}
dimH(lx, lx + baseW, ly + baseD + 12, `${baseW}`)
dimV(ly, ly + baseD, lx - 4, `${baseD}`)
dimH(lx + 10, lx + 10 + pitch, ly + baseD + 24, `pitch ${pitch}`)
note(lx, ly + baseD + 40, `Servo cut-outs are ${SERVO.body} x ${SERVO.width}mm. The SG90's flanges rest on the plate and hold it; no bracket needed.`)
note(lx, ly + baseD + 52, 'All four servo grounds AND the ESP32 ground must meet at the 5V supply. A missing common ground is the twitching-servo fault.')
oy = ly + baseD + 68

const H = oy + 14
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${px(baseW + 120)}" height="${px(H)}" viewBox="0 0 ${px(baseW + 120)} ${px(H)}">`,
  `<rect width="100%" height="100%" fill="${P_.bg}"/>`,
  ...out,
  `<text x="${px(10)}" y="${px(H - 4)}" font-family="DejaVu Sans, sans-serif" font-size="9" fill="${P_.thin}">Generated by docs/drawings/generate.mjs — change the product dimensions there and re-run. Korean build guide: docs/dispenser-build.ko.md</text>`,
  `</svg>`,
].join('\n')

const here = dirname(fileURLToPath(import.meta.url))
writeFileSync(join(here, 'dispenser-v1.svg'), svg)
console.log(`dispenser-v1.svg written — ${baseW}x${baseD}mm plate, ${magW}x${magD}x${magH}mm magazines, arm ${armR}mm, CoM margin ${comEnd - baseD}mm`)
