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

export async function streamOverTcp(lines: string[], host: string, port: number): Promise<void> {
  const socket = createConnection({ host, port })
  socket.setEncoding('utf8')

  let buffer = ''
  let pendingResolve: ((reply: string) => void) | null = null
  let pendingReject: ((err: Error) => void) | null = null

  socket.on('data', (chunk: string) => {
    buffer += chunk
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

  const waitReply = () =>
    new Promise<string>((resolve, reject) => {
      pendingResolve = resolve
      pendingReject = reject
      setTimeout(() => {
        if (pendingResolve === resolve) {
          pendingResolve = pendingReject = null
          reject(new Error(`GRBL did not answer within ${LINE_TIMEOUT_MS}ms`))
        }
      }, LINE_TIMEOUT_MS)
    })

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })

  try {
    for (const line of lines) {
      const replyPromise = waitReply()
      socket.write(line + '\n')
      await replyPromise
    }
  } finally {
    socket.end()
  }
}

/** Dry-run sink: write the program to a file instead of a machine. */
export async function writeGcodeFile(lines: string[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.join('\n') + '\n')
}
