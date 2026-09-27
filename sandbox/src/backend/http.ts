// The back-end's API (sandbox-backend.md, "L'API") and the lab page. Every command answers accepted
// or refused with its reason; the effects are read from /api/events, never from the answer alone.
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { AnchorStore } from './anchors.ts'
import type { PodIdentity } from './kube.ts'
import type { CommandResult, SandboxManager } from './manager.ts'
import { AnchorRefused, MAX_ANCHOR_BYTES, parseBundle } from '../shared/anchor.ts'
import { bearerOf } from '../shared/token.ts'

export interface HttpOptions {
  readonly manager: SandboxManager
  readonly anchors: AnchorStore
  readonly lab: boolean
  readonly onRestart?: () => void
}

const PAGE = join(import.meta.dirname, 'public', 'index.html')
const NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function reply<T>(res: ServerResponse, result: CommandResult<T>): void {
  if (result.accepted) json(res, 200, { accepted: true, ...(typeof result.value === 'object' && result.value !== null ? result.value : { value: result.value }) })
  else json(res, result.status, { accepted: false, reason: result.reason })
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength
    if (size > 64 * 1024) throw new Error('corps trop grand')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

export function createApi(options: HttpOptions): Server {
  const { manager, anchors } = options

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://backend')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok\n')
      return
    }
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
      })
      res.end(await readFile(PAGE))
      return
    }

    if (method === 'GET' && path === '/api/pools') return json(res, 200, { pools: await manager.pools() })
    if (method === 'GET' && path === '/api/sandboxes') return json(res, 200, manager.snapshot())
    if (method === 'GET' && path === '/api/anchors') return json(res, 200, { anchors: await anchors.list() })
    if (method === 'GET' && path === '/api/events') return events(req, res)
    if (method === 'GET' && path === '/api/config') return json(res, 200, { lab: options.lab })

    const anchorContent = /^\/api\/anchors\/([^/]+)\/content$/.exec(path)
    if (method === 'GET' && anchorContent !== null) {
      const bytes = await anchors.bundle(anchorContent[1]!)
      if (bytes === null) return json(res, 404, { accepted: false, reason: 'anchor inconnu' })
      // The native files, one after the other, readable in a browser tab.
      const bundle = parseBundle(bytes)
      const text = bundle.files.map((file) => `===== ${file.path} (${file.checksum})\n${Buffer.from(file.content, 'base64').toString('utf8')}`).join('\n')
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(text)
      return
    }

    if (method === 'POST' && path === '/api/sandboxes') {
      const input = await body(req)
      return reply(res, await manager.create(input as Parameters<SandboxManager['create']>[0]))
    }

    const command = /^\/api\/(lab\/)?sandboxes\/([^/]+)\/([a-z-]+)$/.exec(path)
    if (method === 'POST' && command !== null) {
      const [, labPrefix, name, verb] = command
      if (!NAME.test(name!)) return json(res, 400, { accepted: false, reason: 'nom invalide' })
      if (labPrefix === undefined && verb === 'stop') return reply(res, await manager.stopSandbox(name!))
      if (labPrefix !== undefined && options.lab) {
        if (verb === 'drop-bridge') return reply(res, manager.lab.dropBridge(name!))
        if (verb === 'probe-auth') {
          const result = await manager.lab.probeAuth(name!)
          return result.accepted ? json(res, 200, { accepted: true, results: result.value }) : reply(res, result)
        }
      }
    }
    if (method === 'POST' && path === '/api/lab/restart' && options.lab) {
      json(res, 200, { accepted: true, value: 'le processus du back-end s’arrête ; Kubernetes le relance' })
      setTimeout(() => (options.onRestart ?? (() => process.exit(0)))(), 300)
      return
    }
    json(res, 404, { accepted: false, reason: 'route inconnue' })
  }

  function events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const send = (data: unknown): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    void anchors.list().then((list) => send({ type: 'snapshot', ...manager.snapshot(), anchors: list }))
    const unsubscribe = manager.subscribe(send)
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000)
    req.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { accepted: false, reason: error instanceof Error ? error.message : String(error) })
      else res.destroy()
    })
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://backend')
    const match = /^\/api\/sandboxes\/([^/]+)\/acp$/.exec(url.pathname)
    if (match === null || !NAME.test(match[1]!)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    const afterParam = url.searchParams.get('after')
    const after = afterParam === null || afterParam === '' ? null : Number(afterParam)
    wss.handleUpgrade(req, socket, head, (peer) => manager.attachConsumer(match[1]!, peer, after !== null && Number.isFinite(after) ? after : null))
  })

  return server
}

export interface AnchorReceiverOptions {
  readonly manager: SandboxManager
  /** The namespace of the sandboxes: a token from anywhere else is refused. */
  readonly namespace: string
  /** TokenReview of the Pod's projected ServiceAccount token (audience agora-anchors). */
  readonly verify: (token: string) => Promise<PodIdentity | null>
}

/**
 * The only route the sandboxes reach (sandbox-backend.md, "La réception de l'anchor"), on its own
 * port so that the network policy opens this and nothing else of the back-end to them.
 */
export function createAnchorReceiver(options: AnchorReceiverOptions): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://backend')
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok\n')
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/anchors') return json(res, 404, { accepted: false, reason: 'route inconnue' })
      const token = bearerOf(req.headers.authorization)
      const pod = token === undefined ? null : await options.verify(token).catch(() => null)
      if (pod === null) return json(res, 401, { accepted: false, reason: 'jeton projeté absent ou refusé' })
      if (pod.namespace !== options.namespace) return json(res, 403, { accepted: false, reason: `namespace ${pod.namespace} refusé` })
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).byteLength
        if (size > MAX_ANCHOR_BYTES * 1.4) return json(res, 413, { accepted: false, reason: "l'anchor est trop gros" })
        chunks.push(chunk as Buffer)
      }
      const raw = new Uint8Array(Buffer.concat(chunks))
      const bundle = parseBundle(raw)
      const result = await options.manager.receiveAnchor(pod.podName, bundle, raw)
      reply(res, result)
    })().catch((error: unknown) => {
      const status = error instanceof AnchorRefused ? error.status : 500
      if (!res.headersSent) json(res, status, { accepted: false, reason: error instanceof Error ? error.message : String(error) })
      else res.destroy()
    })
  })
}
