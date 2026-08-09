import { describe, expect, it } from 'vitest'
import { createServer, createConnection, type Server } from 'node:net'
import { runProtocol, streamOverTcp } from '../src/plotter/grbl-stream'

/**
 * A fake GRBL board: answers "ok" per line, records what it received.
 * The one seam between our code and the real machine, tested without one.
 */
function fakeGrbl(opts: { errorOnLine?: number } = {}): Promise<{
  server: Server
  port: number
  received: string[]
}> {
  const received: string[] = []
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.write('Grbl 1.1 [\'$\' for help]\n') // real boards greet with a banner
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        received.push(line)
        if (opts.errorOnLine !== undefined && received.length === opts.errorOnLine) {
          socket.write('error:20\n')
        } else {
          socket.write('ok\n')
        }
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port, received })
    })
  })
}

describe('streamOverTcp against a fake GRBL board', () => {
  it('delivers every line, in order, one per ok', async () => {
    const { server, port, received } = await fakeGrbl()
    const program = ['G21', 'G90', 'M5', 'G0 X10 Y10 F3000', 'G1 X20 Y20 F1500']
    await streamOverTcp(program, '127.0.0.1', port)
    server.close()
    expect(received).toEqual(program)
  })

  it('aborts on error:N — past that point the machine position is untrusted', async () => {
    const { server, port, received } = await fakeGrbl({ errorOnLine: 3 })
    const program = ['G21', 'G90', 'BAD LINE', 'G0 X10 Y10 F3000', 'G1 X20 Y20 F1500']
    await expect(streamOverTcp(program, '127.0.0.1', port)).rejects.toThrow(/error:20/)
    server.close()
    // Nothing after the rejected line was sent.
    expect(received).toEqual(['G21', 'G90', 'BAD LINE'])
  })

  it('rejects instead of hanging when the machine is unreachable', async () => {
    // Port 1 on localhost: nothing listens there.
    await expect(streamOverTcp(['G21'], '127.0.0.1', 1)).rejects.toThrow()
  })
})

describe('boot handshake against a board that is still booting', () => {
  it('pokes until the board wakes, then delivers everything — no line lost to the reboot window', async () => {
    // A board that DROPS all input for the first 3 pokes (mid-boot), then
    // behaves. This reproduced the real deadlock: the second-ever physical
    // plot sent its first line into the ESP32's reset window and waited
    // 30s for an ack that never came.
    const received: string[] = []
    let drops = 3
    const server = createServer((socket) => {
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        let idx: number
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (drops > 0) {
            drops--
            continue // booting: input silently discarded
          }
          if (line !== '') received.push(line)
          socket.write('ok\n')
        }
      })
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })

    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setEncoding('utf8')
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))

    const program = ['G21', 'G90', 'G0 X5 Y5 F3000']
    await runProtocol(socket, program, { bootHandshake: true })
    socket.end()
    server.close()
    expect(received).toEqual(program)
  }, 15_000)
})
