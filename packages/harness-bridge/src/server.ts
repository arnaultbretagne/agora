// The bridge owns the adapter's process and transport, never ACP state. It reads stdout only
// while Agora is attached and awaits each socket send before continuing. Unread bytes stay in
// the pipe; only an incomplete line and the remainder of one read belong to this process.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID, type KeyObject } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import { bearerOf, verifyBridgeToken } from './token.ts'
import { AnchorRefused, MAX_ANCHOR_BYTES, parseBundle, readBundle, writeBundle, type Bundle } from './anchor.ts'
import { parseCredentials, startOutbound } from './outbound.ts'

export interface BridgeOptions {
  readonly port: number
  readonly host?: string
  readonly adapterCommand: readonly string[]
  readonly workspace: string
  readonly podName: string
  readonly publicKey: KeyObject
  readonly harness: string
  /** The harness's native directory for this workspace: what an anchor holds. */
  readonly nativeDir: string
  readonly adapterStopMs?: number
  /** Loopback port of the outbound proxy the adapter goes through (docs/specs/credentials.md); 0 picks one. */
  readonly outboundPort?: number
  readonly log?: (message: string) => void
}

export interface Bridge {
  readonly instance: string
  port(): number
  /** The end of the Pod: close the relay, stop the adapter, read the native files en bloc. */
  terminate(): Promise<Bundle>
  close(): Promise<void>
}

export const MAX_LINE_BYTES = 16 * 1024 * 1024

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const log = options.log ?? ((message: string) => console.log(`[bridge] ${message}`))
  const instance = randomUUID()
  const startedAt = new Date().toISOString()

  mkdirSync(options.workspace, { recursive: true })

  // Started before the adapter, whose environment must point at it: no credential yet, only the
  // way out (docs/specs/credentials.md).
  const outbound = await startOutbound({ port: options.outboundPort ?? 0, log })
  const loopback = 'localhost,127.0.0.1'
  const env = { ...process.env, HTTPS_PROXY: outbound.url, https_proxy: outbound.url, NO_PROXY: loopback, no_proxy: loopback }

  const [command, ...args] = options.adapterCommand
  if (command === undefined) throw new Error('the adapter command is empty')
  const child: ChildProcess = spawn(command, args, { cwd: options.workspace, env, stdio: ['pipe', 'pipe', 'inherit'] })

  const adapter = { alive: true, exitCode: null as number | null, signal: null as string | null }
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  let terminating = false
  let client: WebSocket | null = null
  let reading = false
  let chunk: Buffer | null = null
  let offset = 0
  let parts: Buffer[] = []
  let lineBytes = 0

  function failAdapter(reason: string): void {
    if (!adapter.alive) return
    log(reason)
    adapter.alive = false
    client?.close(1011, 'adapter stopped')
    child.kill('SIGKILL')
  }

  // No data listener: readable mode leaves output buffered until there is a socket to consume it.
  // A send that reached a failed socket is never replayed: its acceptance cannot be known.
  async function pipeOutput(): Promise<void> {
    if (reading) return
    reading = true
    try {
      while (client?.readyState === WebSocket.OPEN && !terminating && adapter.alive) {
        if (chunk === null) {
          chunk = child.stdout?.read() as Buffer | null
          offset = 0
          if (chunk == null) { chunk = null; return }
        }
        const end = chunk.indexOf(0x0a, offset)
        const limit = end < 0 ? chunk.length : end
        const piece = chunk.subarray(offset, limit)
        lineBytes += piece.length
        if (lineBytes > MAX_LINE_BYTES) {
          failAdapter('adapter line exceeds 16 MiB')
          return
        }
        if (piece.length > 0) parts.push(piece)
        offset = limit + (end < 0 ? 0 : 1)
        if (offset === chunk.length) chunk = null
        if (end < 0) continue
        const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts, lineBytes)
        parts = []
        lineBytes = 0
        const peer = client
        await new Promise<void>((resolve) => {
          peer.send(line, { binary: false }, (error) => {
            if (error) peer.terminate()
            resolve()
          })
        })
        // ws's send callback runs after the underlying write finishes. If the peer disappeared,
        // the next loop iteration stops; the remaining read belongs to the next connection.
        while (peer.readyState === WebSocket.OPEN && peer.bufferedAmount > 0 && client === peer && !terminating) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
    } finally {
      reading = false
    }
  }
  child.stdout?.on('readable', () => void pipeOutput())
  child.on('exit', (code, signal) => {
    adapter.alive = false
    adapter.exitCode = code
    adapter.signal = signal
    log(`adapter exited code=${String(code)} signal=${String(signal)}`)
    if (!terminating) client?.close(1011, 'adapter exited')
  })
  child.on('error', () => {
    adapter.alive = false
    log('cannot start the adapter')
    client?.close(1011, 'adapter failed to start')
  })
  child.stdin?.on('error', () => failAdapter('adapter stdin failed'))
  child.stdout?.on('error', () => failAdapter('adapter stdout failed'))

  function describe(): Record<string, unknown> {
    return {
      instance,
      pod: options.podName,
      workspace: options.workspace,
      startedAt,
      adapter: { ...adapter },
      terminating,
      outbound: outbound.describe(),
    }
  }

  function authorized(req: IncomingMessage): { ok: true } | { ok: false; reason: string } {
    const token = bearerOf(req.headers.authorization)
    if (token === undefined) return { ok: false, reason: 'token missing' }
    return verifyBridgeToken(options.publicKey, token, options.podName)
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://bridge')
    if (url.pathname === '/healthz') {
      const ready = adapter.alive && !terminating
      res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' })
      res.end(ready ? 'adapter alive\n' : 'adapter unavailable\n')
      return
    }
    const auth = authorized(req)
    if (!auth.ok) return json(res, 401, { reason: auth.reason })

    if (url.pathname === '/info' && req.method === 'GET') return json(res, 200, describe())

    if (url.pathname === '/credentials' && req.method === 'PUT') {
      if (terminating) return json(res, 503, { reason: 'Pod ending' })
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).byteLength
        if (size > 16 * 1024) return json(res, 413, { reason: 'body too big' })
        chunks.push(chunk as Buffer)
      }
      let credentials
      try {
        credentials = parseCredentials(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        return json(res, 400, { reason: error instanceof Error ? error.message : String(error) })
      }
      outbound.set(credentials)
      return json(res, 200, outbound.describe())
    }

    if (url.pathname === '/anchor' && req.method === 'PUT') {
      if (terminating) return json(res, 503, { reason: 'Pod ending' })
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).byteLength
        // base64 inflates by a third, plus the JSON around it.
        if (size > MAX_ANCHOR_BYTES * 1.4) throw new AnchorRefused(413, 'the anchor is too big')
        chunks.push(chunk as Buffer)
      }
      const placed = await writeBundle(options.nativeDir, parseBundle(new Uint8Array(Buffer.concat(chunks))))
      log(`anchor restored: ${String(placed.length)} file(s) in ${options.nativeDir}`)
      return json(res, 200, { files: placed })
    }

    json(res, 404, { reason: 'unknown route' })
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof AnchorRefused) return json(res, error.status, { reason: error.message })
      log(`error on ${String(req.method)} ${new URL(req.url ?? '/', 'http://bridge').pathname}`)
      if (!res.headersSent) json(res, 500, { reason: error instanceof Error ? error.message : String(error) })
      else res.destroy()
    })
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LINE_BYTES })
  wss.on('headers', (headers) => headers.push(`agora-bridge-instance: ${instance}`))
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://bridge')
    if (url.pathname !== '/acp') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    const auth = authorized(req)
    if (!auth.ok) {
      socket.end(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${auth.reason}\n`)
      return
    }
    if (terminating) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nPod ending\n')
      return
    }
    wss.handleUpgrade(req, socket, head, attach)
  })

  function attach(peer: WebSocket): void {
    if (client !== null) {
      log('new connection: the previous one is closed')
      client.close(4000, 'replaced by a newer connection')
    }
    client = peer
    if (!adapter.alive) {
      peer.close(1011, 'adapter exited')
      return
    }
    const drain = (): void => {
      if (client === peer && peer.readyState === WebSocket.OPEN && !terminating) peer.resume()
    }
    child.stdin?.on('drain', drain)
    if (child.stdin?.writableNeedDrain) peer.pause()
    peer.on('message', (data, isBinary) => {
      if (client !== peer || !adapter.alive || terminating) return
      if (isBinary) { peer.close(1003, 'binary messages refused'); return }
      const line = data.toString()
      if (line.includes('\n')) { peer.close(1008, 'one line per message'); return }
      if (!child.stdin?.write(`${line}\n`)) peer.pause()
    })
    peer.on('close', () => {
      child.stdin?.off('drain', drain)
      if (client === peer) client = null
    })
    peer.on('error', (error: Error & { code?: string }) => {
      if (error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') failAdapter('client line exceeds 16 MiB')
    })
    void pipeOutput()
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '0.0.0.0', () => { server.off('error', reject); resolve() })
  }).catch(async (error: unknown) => {
    child.kill('SIGKILL')
    await outbound.close()
    throw error
  })
  log(`listening: instance ${instance}, port ${String((server.address() as { port: number }).port)}`)

  let terminated: Promise<Bundle> | null = null

  return {
    instance,
    port: () => (server.address() as { port: number }).port,
    terminate: () => {
      terminated ??= (async () => {
        terminating = true
        log('end of the Pod: relay closed, stopping the adapter')
        if (client !== null && client.readyState === client.OPEN) {
          client.close(1001, 'Pod ending')
        }
        if (adapter.alive) {
          child.kill('SIGTERM')
          const stopMs = options.adapterStopMs ?? 5000
          const stopped = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), stopMs))])
          if (!stopped) {
            log(`adapter still there after ${String(stopMs)} ms: SIGKILL`)
            child.kill('SIGKILL')
            await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))])
          }
        }
        await outbound.close()
        try {
          return await readBundle(options.harness, options.nativeDir)
        } catch (error) {
          return { format: 'agora-anchor/1', harness: options.harness, files: [], stable: false, error: error instanceof Error ? error.message : String(error) }
        }
      })()
      return terminated
    },
    close: async () => {
      terminating = true
      for (const peer of wss.clients) peer.terminate()
      if (adapter.alive) child.kill('SIGTERM')
      await outbound.close()
      await new Promise<void>((resolve) => {
        wss.close()
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
