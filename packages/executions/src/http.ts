// The HTTP surface of the execution mechanics (docs/specs/executions.md, "The lab"): the catalogue, what
// the mechanics see of each execution, and the lab's hooks. Commands and the thread are the log's
// (docs/specs/log.md, "HTTP"); a deployable mounts both through `handle`.
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { PodIdentity } from './kube.ts'
import type { CommandResult, CredentialSource, ExecutionManager } from './manager.ts'
import { AnchorRefused, MAX_ANCHOR_BYTES, parseBundle, type Bundle } from '@agora/harness-bridge/anchor'
import { bearerOf } from '@agora/harness-bridge/token'

/** Where an execution's credential comes from (docs/specs/credentials.md): Agora's signed grants for the gateway. */

export interface HttpOptions {
  readonly manager: ExecutionManager
  /** Routes of the mounting deployable, tried first (the log's). */
  readonly handle?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  /** Opens the lab's own routes (docs/specs/executions.md, "The lab"). */
  readonly lab: boolean
  /** A page to serve at `/`, if the deployable has one. */
  readonly page?: string
  readonly credentials?: CredentialSource
  /** The lab's restart: `clean` drains like a SIGTERM, `kill` dies like a SIGKILL. */
  readonly onRestart?: (mode: 'clean' | 'kill') => void
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
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

export function createApi(options: HttpOptions): Server {
  const { manager } = options

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.handle !== undefined && (await options.handle(req, res))) return
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
    if (method === 'GET' && path === '/api/executions') return json(res, 200, { executions: manager.views() })
    if (method === 'GET' && path === '/api/events') return events(req, res)
    if (method === 'GET' && path === '/api/config') return json(res, 200, { lab: options.lab, credentials: options.credentials?.describe() ?? null })

    const command = /^\/api\/lab\/executions\/([^/]+)\/([a-z-]+)$/.exec(path)
    if (method === 'POST' && command !== null && options.lab) {
      const [, name, verb] = command
      if (!NAME.test(name!) && !/^[0-9a-f-]{36}$/.test(name!)) return json(res, 400, { accepted: false, reason: 'invalid name' })
      if (verb === 'drop-bridge') return reply(res, manager.lab.dropBridge(name!, Number((await body(req)).pauseSeconds ?? 0)))
      if (verb === 'probe-auth') {
        const result = await manager.lab.probeAuth(name!)
        return result.accepted ? json(res, 200, { accepted: true, results: result.value }) : reply(res, result)
      }
    }
    if (method === 'POST' && path === '/api/lab/restart' && options.lab) {
      const mode = (await body(req)).mode === 'kill' ? 'kill' : 'clean'
      json(res, 200, { accepted: true, value: mode === 'kill' ? 'the lab process is killed; Kubernetes restarts it' : 'the lab process stops cleanly; Kubernetes restarts it' })
      setTimeout(() => (options.onRestart ?? (() => process.exit(0)))(mode), 300)
      return
    }
    json(res, 404, { accepted: false, reason: 'unknown route' })
  }

  function events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const send = (data: unknown): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    send({ type: 'snapshot', executions: manager.views() })
    const unsubscribe = manager.subscribe((execution) => send({ type: 'execution', execution }))
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000)
    req.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { accepted: false, reason: 'unavailable' })
      else res.destroy()
    })
  })
}

export interface AnchorReceiverOptions {
  /** Stores an authenticated Pod's anchor (the log's Workstreams). */
  readonly receive: (pod: PodIdentity, bundle: Bundle, raw: Uint8Array) => Promise<CommandResult<{ anchorId: string }>>
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
      if (pod.namespace !== options.namespace) return json(res, 403, { accepted: false, reason: 'namespace refused' })
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).byteLength
        if (size > MAX_ANCHOR_BYTES * 1.4) return json(res, 413, { accepted: false, reason: 'the anchor is too big' })
        chunks.push(chunk as Buffer)
      }
      const raw = new Uint8Array(Buffer.concat(chunks))
      reply(res, await options.receive(pod, parseBundle(raw), raw))
    })().catch((error: unknown) => {
      const status = error instanceof AnchorRefused ? error.status : 503
      if (!res.headersSent) json(res, status, { accepted: false, reason: error instanceof AnchorRefused ? error.message : 'unavailable' })
      else res.destroy()
    })
  })
}
