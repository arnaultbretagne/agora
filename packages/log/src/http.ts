// The log's HTTP surface (docs/specs/log.md, "HTTP"). Who may read and write a Workstream is not
// decided yet: the lab is behind its own authentication, and owners are what the client says.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { CredentialSource } from '@agora/executions'
import { parseBundle } from '@agora/harness-bridge/anchor'
import type { Workstreams } from './workstreams.ts'
import type { Command } from './store.ts'
import { uuid, object, decode, encode, cursor, identity } from './json.ts'
import { MAX_LINE } from './acp.ts'

const VALIDATION = new Set([
  'invalid_body',
  'invalid_identifier',
  'invalid_cursor',
  'future_cursor',
  'control_refused',
  'invalid_json',
  'duplicate_key',
  'unsafe_key',
])

export interface LogHttpOptions {
  /** Opens the lab-only routes: control, credentials, entries, anchors. */
  /** The test routes (docs/specs/log.md, "HTTP"): open only while TEST_ROUTES is true. */
  readonly testRoutes: boolean
  readonly credentials?: CredentialSource
}

export async function logHttp(
  workstreams: Workstreams,
  req: IncomingMessage,
  res: ServerResponse,
  options: LogHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://agora')
  if (url.pathname === '/api/log-json.js' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600' })
    res.end(await readFile(createRequire(import.meta.url).resolve('lossless-json')))
    return true
  }
  const anchors = url.pathname === '/api/anchors' || url.pathname.startsWith('/api/anchors/')
  if (!url.pathname.startsWith('/api/workstreams') && !anchors) return false
  const store = workstreams.options.store
  const reply = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(encode(value))
  }
  const body = async () => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_LINE) throw new Error('invalid_body')
      chunks.push(chunk as Buffer)
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } catch {
      throw new Error('invalid_body')
    }
    const value = object(decode(text))
    if (!value) throw new Error('invalid_body')
    return value
  }
  try {
    if (anchors) {
      if (!options.testRoutes || req.method !== 'GET') return reply(404, { reason: 'unknown_route' }), true
      if (url.pathname === '/api/anchors') return reply(200, { anchors: await store.anchorList() }), true
      const content = /^\/api\/anchors\/([^/]+)\/content$/.exec(url.pathname)
      if (!content) return reply(404, { reason: 'unknown_route' }), true
      const anchor = await store.anchorBytes(uuid(content[1]))
      if (!anchor) return reply(404, { reason: 'unknown_anchor' }), true
      // The native files one after the other, readable in a browser tab.
      const bundle = parseBundle(new Uint8Array(anchor.content))
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(bundle.files.map((file) => `===== ${file.path}\n${Buffer.from(file.content, 'base64').toString('utf8')}`).join('\n'))
      return true
    }
    if (req.method === 'GET' && url.pathname === '/api/workstreams') return reply(200, { workstreams: await workstreams.projections.views() }), true
    if (req.method === 'POST' && url.pathname === '/api/workstreams') {
      const input = await body()
      // The identity the proxy in front passes, as a name-based UUID; the body's owner without one.
      const identityHeader = req.headers['x-auth-request-email']
      const id = uuid(input.id),
        owner = typeof identityHeader === 'string' && identityHeader !== '' ? identity('owner', identityHeader) : uuid(input.owner)
      try {
        await store.create(id, owner)
      } catch (error) {
        if (error instanceof Error && error.message === 'workstream_conflict') return reply(409, { reason: 'workstream_conflict' }), true
        throw error
      }
      reply(200, { id })
      return true
    }
    const route = /^\/api\/workstreams\/([^/]+)\/(commands|control|thread|entries|credentials)$/.exec(url.pathname)
    if (!route) return reply(404, { reason: 'unknown_route' }), true
    const workstream = uuid(decodeURIComponent(route[1]!)),
      verb = route[2]
    if (req.method === 'POST' && verb === 'commands') {
      const input = await body(),
        target = object(input.target),
        content = object(input.body)
      if (!['Create', 'Write', 'Cancel', 'RespondPermission', 'Stop'].includes(String(input.kind)) || !target || !content)
        throw new Error('invalid_body')
      const answer = await workstreams.command(workstream, { id: uuid(input.id), kind: input.kind as Command['kind'], target, body: content })
      reply(answer.accepted ? 200 : answer.reason === 'unavailable' ? 503 : 409, answer)
      return true
    }
    if (req.method === 'GET' && verb === 'thread') return (await thread(workstreams, workstream, url, res), true)
    if (!options.testRoutes) return reply(404, { reason: 'unknown_route' }), true
    if (req.method === 'POST' && verb === 'control') {
      const input = await body(),
        params = object(input.params)
      if (typeof input.method !== 'string' || !params) throw new Error('invalid_body')
      const requestId = await workstreams.control(workstream, uuid(input.execution), input.method, params)
      reply(200, { requestId })
      return true
    }
    if (req.method === 'POST' && verb === 'credentials') {
      if (!options.credentials) return reply(503, { reason: 'credentials_unavailable' }), true
      const input = await body(),
        execution = uuid(input.execution)
      const ttlSeconds = input.ttlSeconds === undefined ? 3600 : Number(input.ttlSeconds)
      const profiles = Array.isArray(input.profiles) ? input.profiles.filter((p): p is string => typeof p === 'string') : undefined
      const credentials = await options.credentials.mint({ label: `agora ${execution}`, ttlSeconds, ...(profiles ? { profiles } : {}) })
      const outbound = await workstreams.attachCredentials(workstream, execution, credentials)
      reply(200, { accepted: true, expiresAt: credentials.expiresAt, outbound })
      return true
    }
    if (req.method === 'GET' && verb === 'entries') {
      reply(200, await store.entries(workstream))
      return true
    }
    reply(405, { reason: 'method_refused' })
    return true
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    if (!res.headersSent) {
      if (VALIDATION.has(reason) || error instanceof SyntaxError) reply(400, { reason: VALIDATION.has(reason) ? reason : 'invalid_body' })
      else if (reason === 'unknown_workstream') reply(404, { reason })
      else if (reason === 'execution_unavailable') reply(409, { reason })
      else reply(503, { reason: 'unavailable' })
    } else res.destroy()
    return true
  }
}

/** docs/specs/log.md, "The thread": a snapshot through H, `snapshot-end`, then live updates. */
async function thread(workstreams: Workstreams, workstream: string, url: URL, res: ServerResponse): Promise<void> {
  const after = url.searchParams.get('after') ?? '0'
  cursor(after)
  const snapshot = await workstreams.projections.snapshot(workstream, after)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  let closed = false
  res.on('close', () => {
    closed = true
  })
  const send = async (value: unknown) => {
    if (closed) return
    if (!res.write(`data: ${encode(value)}\n\n`))
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
  }
  for (const row of snapshot.rows) await send({ type: 'snapshot', ...row })
  await send({ type: 'snapshot-end', position: snapshot.end })
  let position = snapshot.end
  while (!closed) {
    const rows = await workstreams.projections.tail(workstream, position)
    for (const row of rows) {
      await send({ type: 'live', ...row })
      position = row.position
    }
    if (!rows.length)
      await new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer)
            res.off('close', done)
            resolve()
          },
          timer = setTimeout(done, 250)
        res.once('close', done)
      })
  }
}
