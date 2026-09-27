// The bridge (sandbox-image.md). It spawns the ACP adapter once, initializes it once, then relays
// its stdio to ONE WebSocket client, numbering every line the adapter writes. It never interprets
// ACP: lines are relayed and buffered byte-for-byte. Two HTTP routes capture and restore the anchor.
//
// Carried over from the previous implementation's packages/harness-bridge (arnaultbretagne/agora
// main): one client at a time, newest wins — every ACP connection numbers its requests from 0, so two
// attached clients steal each other's responses; and `initialize` done by whoever owns the process,
// because codex-acp refuses a second one ("Already initialized").
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID, type KeyObject } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { bearerOf, verifyBridgeToken } from '../shared/token.ts'
import { AnchorRefused, captureTranscript, MAX_ANCHOR_BYTES, restoreTranscript, type TranscriptLayout } from '../shared/transcript.ts'

export interface BridgeOptions {
  readonly port: number
  readonly host?: string
  readonly adapterCommand: readonly string[]
  readonly workspace: string
  readonly podName: string
  readonly publicKey: KeyObject
  readonly layout: TranscriptLayout
  readonly ringLines?: number
  readonly ringBytes?: number
  readonly initializeTimeoutMs?: number
  readonly log?: (message: string) => void
}

export interface Bridge {
  readonly instance: string
  port(): number
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

  const [command, ...args] = options.adapterCommand
  if (command === undefined) throw new Error("la commande de l'adaptateur est vide")
  const child: ChildProcess = spawn(command, args, { cwd: options.workspace, stdio: ['pipe', 'pipe', 'inherit'] })

  const adapter = { alive: true, exitCode: null as number | null, signal: null as string | null }
  let initializeResult: unknown = null
  let initializeError: unknown = null
  let seq = 0
  const ring: Line[] = []
  let ringSize = 0
  let client: WebSocket | null = null

  let onInitialize: (error: unknown) => void = () => {}
  const initialized = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pas de réponse à initialize après ${String(options.initializeTimeoutMs ?? 30_000)} ms`)), options.initializeTimeoutMs ?? 30_000)
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
    log(`adaptateur terminé code=${String(code)} signal=${String(signal)}`)
    onInitialize(new Error(`l'adaptateur est mort avant de répondre à initialize (code ${String(code)})`))
    // The bridge stays up: /anchor still answers so Agora can capture what the harness wrote.
    client?.close(1011, 'adaptateur terminé')
  })
  child.on('error', (error) => {
    log(`lancement de l'adaptateur impossible : ${error.message}`)
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
      lastSeq: seq,
      firstRetainedSeq: ring[0]?.seq ?? seq + 1,
    }
  }

  function authorized(req: IncomingMessage): { ok: true } | { ok: false; reason: string } {
    const token = bearerOf(req.headers.authorization)
    if (token === undefined) return { ok: false, reason: 'jeton absent' }
    return verifyBridgeToken(options.publicKey, token, options.podName)
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://bridge')
    if (url.pathname === '/healthz') {
      const ready = adapter.alive && initializeResult !== null
      res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' })
      res.end(ready ? 'ACP servable\n' : 'ACP non servable\n')
      return
    }
    const auth = authorized(req)
    if (!auth.ok) return json(res, 401, { reason: auth.reason })

    if (url.pathname === '/info' && req.method === 'GET') return json(res, 200, describe())

    if (url.pathname === '/anchor' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null) return json(res, 400, { reason: 'sessionId manquant' })
      const capture = await captureTranscript(options.layout, sessionId)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-anchor-format': capture.format,
        'x-anchor-checksum': capture.checksum,
        'x-anchor-session': capture.sessionId,
        'content-length': String(capture.bytes.byteLength),
      })
      res.end(Buffer.from(capture.bytes.buffer, capture.bytes.byteOffset, capture.bytes.byteLength))
      log(`anchor capturé : session ${sessionId}, ${String(capture.bytes.byteLength)} octets`)
      return
    }

    if (url.pathname === '/anchor' && req.method === 'PUT') {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).byteLength
        if (size > MAX_ANCHOR_BYTES) throw new AnchorRefused(409, `l'anchor dépasse ${String(MAX_ANCHOR_BYTES)} octets`)
        chunks.push(chunk as Buffer)
      }
      const placement = await restoreTranscript(options.layout, new Uint8Array(Buffer.concat(chunks)))
      log(`anchor restauré : session ${placement.sessionId} → ${placement.path}`)
      return json(res, 200, placement)
    }

    json(res, 404, { reason: 'route inconnue' })
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof AnchorRefused) return json(res, error.status, { reason: error.reason })
      log(`erreur sur ${String(req.method)} ${String(req.url)} : ${error instanceof Error ? error.message : String(error)}`)
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
    wss.handleUpgrade(req, socket, head, (peer) => attach(peer, url.searchParams.get('after')))
  })

  function attach(peer: WebSocket, afterParam: string | null): void {
    if (client !== null) {
      log('nouvelle connexion : la précédente est fermée')
      client.close(4000, 'remplacée par une connexion plus récente')
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
      peer.close(1011, 'adaptateur terminé')
      return
    }
    peer.on('message', (data, isBinary) => {
      if (isBinary) {
        peer.close(1003, 'messages binaires refusés')
        return
      }
      if (!adapter.alive) return
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
  log(`prêt : instance ${instance}, ${String(info.agentInfo?.name)}@${String(info.agentInfo?.version)}, port ${String((server.address() as { port: number }).port)}`)

  return {
    instance,
    port: () => (server.address() as { port: number }).port,
    close: async () => {
      client?.close(1001, 'arrêt du bridge')
      if (adapter.alive) child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        wss.close()
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
