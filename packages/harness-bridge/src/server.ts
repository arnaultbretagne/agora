// The bridge (docs/executions.md). It spawns the ACP adapter once, initializes it once, then relays
// its stdio to ONE WebSocket client, numbering every line the adapter writes. It never interprets
// ACP: lines are relayed and buffered byte-for-byte. The adapter's only way out is the bridge's
// outbound proxy, opened when Agora attaches a credential (docs/credentials.md). When the Pod ends
// (SIGTERM), it stops the adapter and hands back the native files en bloc for the entrypoint to
// push to Agora.
//
// Carried over from the previous implementation's packages/harness-bridge (arnaultbretagne/agora
// main): one client at a time, newest wins — every ACP connection numbers its requests from 0, so two
// attached clients steal each other's responses; `initialize` done by whoever owns the process,
// because codex-acp refuses a second one ("Already initialized"); the adapter outlives any socket.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID, type KeyObject } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
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
  readonly ringLines?: number
  readonly ringBytes?: number
  readonly initializeTimeoutMs?: number
  readonly adapterStopMs?: number
  /** Loopback port of the outbound proxy the adapter goes through (docs/credentials.md); 0 picks one. */
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

interface Line {
  readonly seq: number
  readonly text: string
  readonly bytes: number
}

const INITIALIZE_ID = 'bridge-initialize'

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const log = options.log ?? ((message: string) => console.log(`[bridge] ${message}`))
  const ringLines = options.ringLines ?? 2000
  const ringBytes = options.ringBytes ?? 16 * 1024 * 1024
  const instance = randomUUID()
  const startedAt = new Date().toISOString()

  mkdirSync(options.workspace, { recursive: true })

  // Started before the adapter, whose environment must point at it: no credential yet, only the
  // way out (docs/credentials.md).
  const outbound = await startOutbound({ port: options.outboundPort ?? 0, log })
  const loopback = 'localhost,127.0.0.1'
  const env = { ...process.env, HTTPS_PROXY: outbound.url, https_proxy: outbound.url, NO_PROXY: loopback, no_proxy: loopback }

  const [command, ...args] = options.adapterCommand
  if (command === undefined) throw new Error('the adapter command is empty')
  const child: ChildProcess = spawn(command, args, { cwd: options.workspace, env, stdio: ['pipe', 'pipe', 'inherit'] })

  const adapter = { alive: true, exitCode: null as number | null, signal: null as string | null }
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  let initializeResult: unknown = null
  let initializeError: unknown = null
  let terminating = false
  let seq = 0
  const ring: Line[] = []
  let ringSize = 0
  let client: WebSocket | null = null

  let onInitialize: (error: unknown) => void = () => {}
  const initialized = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to initialize after ${String(options.initializeTimeoutMs ?? 30_000)} ms`)), options.initializeTimeoutMs ?? 30_000)
    timer.unref()
    onInitialize = (error) => {
      clearTimeout(timer)
      if (error === null) resolve()
      else reject(error instanceof Error ? error : new Error(JSON.stringify(error)))
    }
  })

  function record(text: string): void {
    // The initialize answer is the bridge's own: it is kept, not relayed. Everything else is numbered.
    if (initializeResult === null && initializeError === null && text.includes(INITIALIZE_ID)) {
      try {
        const parsed = JSON.parse(text) as { id?: unknown; result?: unknown; error?: unknown }
        if (parsed.id === INITIALIZE_ID) {
          if (parsed.error !== undefined) {
            initializeError = parsed.error
            onInitialize(parsed.error)
          } else {
            initializeResult = parsed.result ?? {}
            onInitialize(null)
          }
          return
        }
      } catch {
        // Not JSON: numbered and relayed like any other line.
      }
    }
    seq += 1
    const line: Line = { seq, text, bytes: Buffer.byteLength(text) }
    ring.push(line)
    ringSize += line.bytes
    while (ring.length > ringLines || ringSize > ringBytes) {
      const dropped = ring.shift()
      if (dropped === undefined) break
      ringSize -= dropped.bytes
    }
    if (client !== null && client.readyState === client.OPEN) client.send(JSON.stringify({ seq: line.seq, acp: line.text }))
  }

  let pending = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const text = pending.slice(0, end).replace(/\r$/, '')
      pending = pending.slice(end + 1)
      if (text.length > 0) record(text)
    }
  })
  child.on('exit', (code, signal) => {
    adapter.alive = false
    adapter.exitCode = code
    adapter.signal = signal
    log(`adapter exited code=${String(code)} signal=${String(signal)}`)
    onInitialize(new Error(`the adapter died before answering initialize (code ${String(code)})`))
    // The bridge stays up: the native files still leave with the Pod, at SIGTERM.
    if (!terminating) client?.close(1011, 'adapter exited')
  })
  child.on('error', (error) => {
    log(`cannot start the adapter: ${error.message}`)
  })

  child.stdin?.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: INITIALIZE_ID,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'agora-bridge', version: '1' },
      },
    })}\n`,
  )

  function describe(): Record<string, unknown> {
    return {
      instance,
      pod: options.podName,
      workspace: options.workspace,
      startedAt,
      initialize: initializeResult,
      initializeError,
      adapter: { ...adapter },
      terminating,
      lastSeq: seq,
      firstRetainedSeq: ring[0]?.seq ?? seq + 1,
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
      const ready = adapter.alive && initializeResult !== null && !terminating
      res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' })
      res.end(ready ? 'ACP servable\n' : 'ACP non servable\n')
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
      log(`error on ${String(req.method)} ${String(req.url)}: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) json(res, 500, { reason: error instanceof Error ? error.message : String(error) })
      else res.destroy()
    })
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
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
    wss.handleUpgrade(req, socket, head, (peer) => attach(peer, url.searchParams.get('after')))
  })

  function attach(peer: WebSocket, afterParam: string | null): void {
    if (client !== null) {
      log('new connection: the previous one is closed')
      client.close(4000, 'replaced by a newer connection')
    }
    client = peer

    const after = afterParam === null ? null : Number(afterParam)
    let replay: Line[] = []
    let gap = false
    if (after !== null && Number.isFinite(after)) {
      replay = ring.filter((line) => line.seq > after)
      const firstWanted = after + 1
      const firstKept = ring[0]?.seq ?? seq + 1
      gap = firstWanted < firstKept && firstWanted <= seq
    }
    peer.send(JSON.stringify({ hello: { ...describe(), replayFrom: replay[0]?.seq ?? null, gap } }))
    for (const line of replay) peer.send(JSON.stringify({ seq: line.seq, acp: line.text }))

    if (!adapter.alive) {
      peer.close(1011, 'adapter exited')
      return
    }
    peer.on('message', (data, isBinary) => {
      if (isBinary) {
        peer.close(1003, 'binary messages refused')
        return
      }
      if (!adapter.alive || terminating) return
      const text = data.toString().replace(/\n+$/, '')
      child.stdin?.write(`${text}\n`)
    })
    peer.on('close', () => {
      if (client === peer) client = null
    })
    peer.on('error', () => {})
  }

  await initialized
  await new Promise<void>((resolve) => server.listen(options.port, options.host ?? '0.0.0.0', resolve))
  const info = initializeResult as { agentInfo?: { name?: string; version?: string } }
  log(`ready: instance ${instance}, ${String(info.agentInfo?.name)}@${String(info.agentInfo?.version)}, port ${String((server.address() as { port: number }).port)}`)

  let terminated: Promise<Bundle> | null = null

  return {
    instance,
    port: () => (server.address() as { port: number }).port,
    terminate: () => {
      terminated ??= (async () => {
        terminating = true
        log('end of the Pod: relay closed, stopping the adapter')
        if (client !== null && client.readyState === client.OPEN) {
          client.send(JSON.stringify({ terminating: { at: new Date().toISOString() } }))
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
      client?.close(1001, 'bridge stopping')
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
