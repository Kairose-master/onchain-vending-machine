/**
 * Stream G-code to a GRBL controller, one line per "ok".
 *
 * The kit's board is ESP32-based GRBL, reachable over WiFi (telnet-style
 * TCP, conventionally port 23) or USB serial. TCP needs zero native
 * dependencies, so it's the primary transport; a dry-run file sink stands
 * in until the machine arrives (and remains useful for eyeballing output).
 *
 * Protocol: send a line, wait for GRBL to answer `ok` before sending the
 * next — the simple send-response protocol from the GRBL wiki. An
 * `error:N` reply aborts the job: past that point the machine's position
 * can no longer be trusted, and blindly continuing plots garbage over a
 * half-finished card.
 */
import { createConnection } from 'node:net'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const LINE_TIMEOUT_MS = 30_000

/** The bit of a transport this protocol actually needs — satisfied by a
 *  net.Socket and by a serialport instance alike. */
interface DuplexLike {
  on(event: 'data', handler: (chunk: Buffer | string) => void): unknown
  write(data: string): unknown
}

/**
 * Drive the line-per-ok protocol over any duplex byte stream.
 * Transport-agnostic so TCP (WiFi boards) and USB serial share ONE
 * implementation of the ack accounting — the off-by-one class of bug only
 * has one place to live.
 */
export async function runProtocol(stream: DuplexLike, lines: string[], opts: { bootHandshake?: boolean } = {}): Promise<void> {
  let buffer = ''
  let pendingResolve: ((reply: string) => void) | null = null
  let pendingReject: ((err: Error) => void) | null = null

  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString()
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const reply = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (reply === '' || reply.startsWith('<')) continue // status reports, blank keepalives
      if (reply.toLowerCase().startsWith('error')) {
        pendingReject?.(new Error(`GRBL rejected line: ${reply}`))
        pendingResolve = pendingReject = null
      } else if (reply === 'ok') {
        // STRICTLY 'ok' — GRBL answers exactly one ok/error per line sent.
        // The startup banner ("Grbl 1.1 ...") must NOT count as an ack: the
        // first version here accepted it, which shifted every subsequent ack
        // by one line — the job finished one ok early (last stroke's ack
        // never awaited) and an error aborted one line too late. Caught by
        // the fake-board test before any real card was ever cut short.
        pendingResolve?.(reply)
        pendingResolve = pendingReject = null
      }
      // Anything else (banner text, [MSG:...]) is informational — ignore.
    }
  })

  const waitReply = (timeoutMs = LINE_TIMEOUT_MS) =>
    new Promise<string>((resolve, reject) => {
      pendingResolve = resolve
      pendingReject = reject
      setTimeout(() => {
        if (pendingResolve === resolve) {
          pendingResolve = pendingReject = null
          reject(new Error(`GRBL did not answer within ${timeoutMs}ms`))
        }
      }, timeoutMs)
    })

  if (opts.bootHandshake) {
    // GRBL answers a bare newline with "ok". Poke until it does: the ESP32's
    // auto-reset boot time varies, and a line sent mid-boot is silently
    // dropped — the second-ever real plot deadlocked exactly this way,
    // waiting 30s for an ack to a line the board never saw. A fixed settle
    // delay is a guess; a handshake is an answer.
    let awake = false
    for (let attempt = 0; attempt < 10 && !awake; attempt++) {
      try {
        const reply = waitReply(2000)
        stream.write('\n')
        await reply
        awake = true
      } catch {
        /* still booting — poke again */
      }
    }
    if (!awake) throw new Error('GRBL never woke up after 10 handshake attempts — check power and port')
  }

  for (const line of lines) {
    const replyPromise = waitReply()
    stream.write(line + '\n')
    await replyPromise
  }
}

export async function streamOverTcp(lines: string[], host: string, port: number): Promise<void> {
  const socket = createConnection({ host, port })
  socket.setEncoding('utf8')

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })

  try {
    await runProtocol(socket, lines)
  } finally {
    socket.end()
  }
}

/**
 * USB serial transport (e.g. /dev/cu.usbserial-10 on macOS).
 *
 * One quirk TCP doesn't have: ESP32 dev boards AUTO-RESET when the serial
 * port opens (DTR toggle), so the board reboots the moment we connect. The
 * settle delay lets it finish booting and spit its banner before the first
 * real line goes out — without it the first commands land on a board that
 * is mid-reboot and vanish unacked.
 */
export async function streamOverSerial(lines: string[], path: string, baudRate = 115200): Promise<void> {
  // Dynamic import: serialport is a native module that only matters on the
  // machine physically attached to the plotter; the watcher runs fine
  // without it in TCP/dry-run modes.
  const { SerialPort } = await import('serialport')
  const port = new SerialPort({ path, baudRate })

  await new Promise<void>((resolve, reject) => {
    port.once('open', () => resolve())
    port.once('error', reject)
  })

  // ESP32 dev boards wire DTR/RTS to the chip's reset (EN) and boot-select
  // (IO0) pins, and WHICH line state lets the chip boot depends on the
  // carrier board's wiring — deasserting helped one board and holds
  // another in reset. `screen` (which is known to work with this board)
  // ASSERTS both on open, so that's the default here; override with
  // PLOTTER_DTR/PLOTTER_RTS=true|false|skip when a board disagrees.
  const lineState = (name: string, fallback: boolean): boolean | null => {
    const raw = process.env[name]?.trim().toLowerCase()
    if (raw === 'skip') return null
    if (raw === 'true') return true
    if (raw === 'false') return false
    return fallback
  }
  const dtr = lineState('PLOTTER_DTR', true)
  const rts = lineState('PLOTTER_RTS', true)
  if (dtr !== null && rts !== null) {
    await new Promise<void>((resolve, reject) =>
      port.set({ dtr, rts }, (err: Error | null | undefined) => (err ? reject(err) : resolve())),
    )
  }

  // PLOTTER_DEBUG=1: dump every raw byte the board sends. The one signal
  // that separates "board is silent" (line-state/boot problem) from "board
  // is talking and we misparse it" (protocol problem).
  if (process.env.PLOTTER_DEBUG === '1') {
    port.on('data', (chunk: Buffer) => {
      console.error(`[serial rx] ${JSON.stringify(chunk.toString())}`)
    })
  }

  try {
    await runProtocol(port, lines, { bootHandshake: true })
  } finally {
    port.close()
  }
}

/** Dry-run sink: write the program to a file instead of a machine. */
export async function writeGcodeFile(lines: string[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.join('\n') + '\n')
}
