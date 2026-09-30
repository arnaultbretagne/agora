// The HTTP surface of the executions (docs/specs/executions.md, "On Agora's side"), and a deployable's page. Every command answers accepted
// or refused with its reason; the effects are read from /api/events, never from the answer alone.
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { AnchorStore } from './anchors.ts'
import type { PodIdentity } from './kube.ts'
import type { CommandResult, ExecutionManager } from './manager.ts'
import { AnchorRefused, MAX_ANCHOR_BYTES, parseBundle } from '@agora/harness-bridge/anchor'
import { bearerOf } from '@agora/harness-bridge/token'
import type { Credentials } from '@agora/harness-bridge/outbound'

/** Where an execution's credential comes from (docs/specs/credentials.md): Agora's signed grants for the gateway. */
export interface CredentialSource {
  describe(): Record<string, unknown>
  mint(input: { label: string; ttlSeconds: number; profiles?: readonly string[] }): Promise<Credentials>
}

export interface HttpOptions {
  readonly manager: ExecutionManager
  readonly handle?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  readonly anchors: AnchorStore
  /** Opens the lab's own routes (docs/specs/executions.md, "The lab"). */
  readonly lab: boolean
  /** A page to serve at `/`, if the deployable has one. */
  readonly page?: string
  /** Opens POST /api/executions/{name}/credentials. */
  readonly credentials?: CredentialSource
  readonly onRestart?: () => void
}
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
    if (options.handle !== undefined && await options.handle(req, res)) return
    const url = new URL(req.url ?? '/', 'http://agora')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok\n')
      return
    }
    if (method === 'GET' && (path === '/' || path === '/index.html') && options.page !== undefined) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
      })
      res.end(await readFile(options.page))
      return
    }

    if (method === 'GET' && path === '/api/pools') return json(res, 200, { pools: await manager.pools() })
    if (method === 'GET' && path === '/api/executions') return json(res, 200, manager.snapshot())
    if (method === 'GET' && path === '/api/anchors') return json(res, 200, { anchors: await anchors.list() })
    if (method === 'GET' && path === '/api/events') return events(req, res)
    if (method === 'GET' && path === '/api/config') {
      return json(res, 200, { lab: options.lab, credentials: options.credentials?.describe() ?? null })
    }

    const anchorContent = /^\/api\/anchors\/([^/]+)\/content$/.exec(path)
    if (method === 'GET' && anchorContent !== null) {
      const bytes = await anchors.bundle(anchorContent[1]!)
      if (bytes === null) return json(res, 404, { accepted: false, reason: 'unknown anchor' })
      // The native files, one after the other, readable in a browser tab.
      const bundle = parseBundle(bytes)
      const text = bundle.files.map((file) => `===== ${file.path} (${file.checksum})\n${Buffer.from(file.content, 'base64').toString('utf8')}`).join('\n')
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(text)
      return
    }

    if (method === 'POST' && path === '/api/executions') {
      const input = await body(req)
      return reply(res, await manager.create(input as Parameters<ExecutionManager['create']>[0]))
    }

    const command = /^\/api\/(lab\/)?executions\/([^/]+)\/([a-z-]+)$/.exec(path)
    if (method === 'POST' && command !== null) {
      const [, labPrefix, name, verb] = command
      if (!NAME.test(name!)) return json(res, 400, { accepted: false, reason: 'invalid name' })
      if (labPrefix === undefined && verb === 'stop') return reply(res, await manager.stopSandbox(name!))
      if (labPrefix === undefined && verb === 'credentials') return attachCredentials(res, name!, await body(req))
      if (labPrefix !== undefined && options.lab) {
        if (verb === 'drop-bridge') return reply(res, manager.lab.dropBridge(name!, Number((await body(req)).pauseSeconds ?? 0)))
        if (verb === 'probe-auth') {
          const result = await manager.lab.probeAuth(name!)
          return result.accepted ? json(res, 200, { accepted: true, results: result.value }) : reply(res, result)
        }
      }
    }
    if (method === 'POST' && path === '/api/lab/restart' && options.lab) {
      json(res, 200, { accepted: true, value: 'the lab process stops; Kubernetes restarts it' })
      setTimeout(() => (options.onRestart ?? (() => process.exit(0)))(), 300)
      return
    }
    json(res, 404, { accepted: false, reason: 'unknown route' })
  }

  async function attachCredentials(res: ServerResponse, name: string, input: Record<string, unknown>): Promise<void> {
    const source = options.credentials
    if (source === undefined) return json(res, 503, { accepted: false, reason: 'no credential source configured' })
    const ttlSeconds = input.ttlSeconds === undefined ? 3600 : Number(input.ttlSeconds)
    const profiles = Array.isArray(input.profiles) ? input.profiles.filter((p): p is string => typeof p === 'string') : undefined
    let credentials: Credentials
    try {
      credentials = await source.mint({ label: `agora ${name}`, ttlSeconds, ...(profiles === undefined ? {} : { profiles }) })
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 502
      return json(res, status, { accepted: false, reason: error instanceof Error ? error.message : String(error) })
    }
    return reply(res, await manager.attachCredentials(name, credentials))
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
    const url = new URL(req.url ?? '/', 'http://agora')
    const match = /^\/api\/executions\/([^/]+)\/acp$/.exec(url.pathname)
    if (match === null || !NAME.test(match[1]!)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    const afterParam = url.searchParams.get('after')
    const after = afterParam === null || afterParam === '' ? null : Number(afterParam)
    wss.handleUpgrade(req, socket, head, (peer) => manager.attachConsumer(match[1]!, peer, after !== null && Number.isFinite(after) ? after : null, url.searchParams.get('epoch')))
  })

  return server
}

export interface AnchorReceiverOptions {
  readonly manager: Pick<ExecutionManager, 'receiveAnchor'>
  /** The namespace of the sandboxes: a token from anywhere else is refused. */
  readonly namespace: string
  /** TokenReview of the Pod's projected ServiceAccount token (audience agora-anchors). */
  readonly verify: (token: string) => Promise<PodIdentity | null>
}

/**
 * The only route the sandboxes reach (docs/specs/executions.md, "Receiving an anchor"), on its own
 * port so that the network policy opens this and nothing else of Agora to them.
 */
export function createAnchorReceiver(options: AnchorReceiverOptions): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://agora')
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok\n')
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/anchors') return json(res, 404, { accepted: false, reason: 'unknown route' })
      const token = bearerOf(req.headers.authorization)
      const pod = token === undefined ? null : await options.verify(token).catch(() => null)
      if (pod === null) return json(res, 401, { accepted: false, reason: 'projected token missing or refused' })
      if (pod.namespace !== options.namespace) return json(res, 403, { accepted: false, reason: `namespace ${pod.namespace} refused` })
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).byteLength
        if (size > MAX_ANCHOR_BYTES * 1.4) return json(res, 413, { accepted: false, reason: 'the anchor is too big' })
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
