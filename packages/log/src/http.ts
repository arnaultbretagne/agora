// The log's HTTP surface (docs/specs/log.md, "HTTP"). Who may read and write a Workstream is not
// decided yet: the lab is behind its own authentication, and owners are what the client says.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'
import type { CredentialSource } from '@agora/executions'
import { parseBundle } from '@agora/harness-bridge/anchor'
import type { Workstreams } from './workstreams.ts'
import type { Command } from './store.ts'
import type { ThreadRow } from './projection.ts'
import { uuid, object, decode, encode, cursor, identity } from './json.ts'
import { MAX_LINE } from './acp.ts'
import { HEAD_LIMIT, OUTPUT_MODES, read, READ_LIMIT, search, type OutputMode } from './search.ts'
import { isDigest } from './files.ts'

/** The types a file is served as (docs/specs/files.md, "Reading a file"); any other is an attachment. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

const VALIDATION = new Set([
  'invalid_body',
  'invalid_identifier',
  'invalid_cursor',
  'future_cursor',
  'unknown_folder',
  'invalid_pattern',
  'invalid_query',
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

/**
 * The folders of an identity (docs/specs/log.md, "HTTP"): `agents` holds the Workstreams of the agents
 * a person's runs staff, owned by the name-based UUID of `agents` and the person's identity — theirs
 * alone, out of their own list.
 */
export const FOLDERS = ['agents'] as const
export const folderOwner = (folder: (typeof FOLDERS)[number], person: string): string => identity(folder, person)

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
  const file = /^\/api\/files\/([^/]+)$/.exec(url.pathname)
  if (!url.pathname.startsWith('/api/workstreams') && !anchors && !file && !['/api/pools', '/api/account', '/api/search'].includes(url.pathname)) return false
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
    // The identity the proxy in front passes (oauth2-proxy sets it and drops a client's own), as a
    // name-based UUID; none when Agora is reached without the proxy.
    const identityHeader = req.headers['x-forwarded-email']
    const caller = typeof identityHeader === 'string' && identityHeader !== '' ? identity('owner', identityHeader) : undefined
    const email = typeof identityHeader === 'string' && identityHeader !== '' ? identityHeader : null
    if (req.method === 'GET' && url.pathname === '/api/account') return reply(200, { email }), true
    // What the caller owns: its own Workstreams and its agents' folder's; anything without the proxy.
    const owned = email === null ? null : [caller!, folderOwner('agents', email)]
    if (file) {
      // docs/specs/files.md, "Reading a file": a file an entry of the caller's Workstreams names, streamed from R2.
      if (req.method !== 'GET') return reply(405, { reason: 'method_refused' }), true
      const sha256 = file[1]!
      const owners = owned ?? [uuid(url.searchParams.get('owner'))]
      if (!isDigest(sha256) || !store.files || !(await store.readable(sha256, owners))) return reply(404, { reason: 'unknown_file' }), true
      const object = await store.files.stream(sha256)
      if (!object) return reply(404, { reason: 'unknown_file' }), true
      const type = url.searchParams.get('type') ?? ''
      const image = IMAGE_TYPES.has(type)
      res.writeHead(200, {
        'content-type': image ? type : 'application/octet-stream',
        ...(image ? {} : { 'content-disposition': 'attachment' }),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=31536000, immutable',
        ...(object.size === undefined ? {} : { 'content-length': String(object.size) }),
      })
      await pipeline(object.body, res).catch(() => res.destroy())
      return true
    }
    if (req.method === 'GET' && (url.pathname === '/api/workstreams/list' || url.pathname === '/api/workstreams/page')) {
      // docs/specs/log.md, "The list": the caller's own, its agents' folder, or one of its Workstreams'
      // sub-streams; without the proxy, the owner or parent given.
      const folder = url.searchParams.get('folder')
      if (folder !== null && !(FOLDERS as readonly string[]).includes(folder)) throw new Error('unknown_folder')
      const parent = url.searchParams.get('parent')
      let list: string
      if (parent !== null) {
        list = uuid(parent)
        if (!(await workstreams.projections.belongs(list, owned))) throw new Error('unknown_workstream')
      } else list = email === null ? uuid(url.searchParams.get('owner')) : folder === null ? caller! : folderOwner('agents', email)
      if (url.pathname === '/api/workstreams/page')
        return reply(200, await workstreams.projections.listPage(list, url.searchParams.get('before'), url.searchParams.get('title'), parent === null)), true
      const after = url.searchParams.get('after') ?? '0'
      cursor(after)
      await feed(
        res,
        () => workstreams.projections.listSnapshot(list, after),
        (position) => workstreams.projections.listTail(list, position),
      )
      return true
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {
      // docs/specs/search.md, "Search": the caller's Workstreams; without the proxy, the owner given.
      const q = url.searchParams
      const number = (name: string, fallback: number, max: number) => {
        const raw = q.get(name)
        if (raw === null || raw === '') return fallback
        const value = Number(raw)
        if (!Number.isInteger(value) || value < 0 || value > max) throw new Error('invalid_query')
        return value
      }
      const flag = (name: string) => q.get(name) === 'true'
      const pattern = q.get('pattern') ?? ''
      if (pattern === '') throw new Error('invalid_pattern')
      const output = (q.get('output_mode') ?? 'workstreams_with_matches') as OutputMode
      if (!OUTPUT_MODES.includes(output)) throw new Error('invalid_query')
      const context = number('context', 0, 50)
      const only = q.get('workstream') === null ? null : uuid(q.get('workstream'))
      const owners = owned ?? [uuid(q.get('owner'))]
      if (only !== null && !(await workstreams.projections.belongs(only, owners))) throw new Error('unknown_workstream')
      const headLimit = number('head_limit', HEAD_LIMIT.default, HEAD_LIMIT.max)
      if (headLimit === 0) throw new Error('invalid_query')
      const answer = await search(workstreams.projections.store.projector, owners, {
        pattern,
        ignoreCase: flag('ignore_case'),
        output,
        before: number('before', context, 50),
        after: number('after', context, 50),
        tools: flag('tools'),
        workstream: only,
        headLimit,
        offset: number('offset', 0, 1_000_000),
      })
      return reply(200, answer), true
    }
    if (req.method === 'GET' && url.pathname === '/api/pools') return reply(200, { pools: await workstreams.catalogue() }), true
    if (req.method === 'POST' && url.pathname === '/api/workstreams') {
      const input = await body()
      // The caller's identity; the body's owner without one; with a parent, the parent's ("Sub-streams").
      const id = uuid(input.id),
        parent = input.parent === undefined || input.parent === null ? null : uuid(input.parent),
        owner = caller ?? (parent === null ? uuid(input.owner) : null)
      try {
        await store.create(id, owner, parent, owned)
      } catch (error) {
        if (error instanceof Error && error.message === 'workstream_conflict') return reply(409, { reason: 'workstream_conflict' }), true
        if (error instanceof Error && error.message === 'unknown_parent') return reply(404, { reason: 'unknown_parent' }), true
        throw error
      }
      reply(200, { id })
      return true
    }
    const route = /^\/api\/workstreams\/([^/]+)\/(commands|control|thread|entries|credentials|row|read|merge)$/.exec(url.pathname)
    if (!route) return reply(404, { reason: 'unknown_route' }), true
    const workstream = uuid(decodeURIComponent(route[1]!)),
      verb = route[2]
    if (req.method === 'POST' && verb === 'commands') {
      const input = await body(),
        target = object(input.target),
        content = object(input.body)
      if (!['Create', 'Write', 'Retract', 'Cancel', 'RespondPermission', 'Configure', 'Scope', 'Stop', 'Ask', 'Answer'].includes(String(input.kind)) || !target || !content)
        throw new Error('invalid_body')
      const answer = await workstreams.command(workstream, { id: uuid(input.id), kind: input.kind as Command['kind'], target, body: content })
      reply(answer.accepted ? 200 : answer.reason === 'unavailable' || answer.reason === 'files_unavailable' ? 503 : 409, answer)
      return true
    }
    if (req.method === 'GET' && verb === 'thread') return (await thread(workstreams, workstream, url, res), true)
    if (req.method === 'GET' && verb === 'read') {
      // docs/specs/search.md, "Read": a window of one of the caller's Workstreams' transcript.
      if (!(await workstreams.projections.belongs(workstream, owned))) throw new Error('unknown_workstream')
      const value = (name: string, fallback: number, min: number, max: number) => {
        const raw = url.searchParams.get(name)
        if (raw === null || raw === '') return fallback
        const n = Number(raw)
        if (!Number.isInteger(n) || n < min || n > max) throw new Error('invalid_query')
        return n
      }
      const answer = await read(workstreams.projections.store.projector, workstream, value('offset', 1, 1, 1_000_000_000), value('limit', READ_LIMIT.lines, 1, READ_LIMIT.lines))
      return reply(200, answer), true
    }
    if (req.method === 'GET' && verb === 'merge') {
      // docs/specs/merge.md, "The card": the pending card's state, read from GitHub.
      if (!(await workstreams.projections.belongs(workstream, owned))) throw new Error('unknown_workstream')
      const state = workstreams.merges === null ? null : await workstreams.merges.state(workstream)
      return state === null ? reply(404, { reason: 'no_merge' }) : reply(200, state), true
    }
    if (req.method === 'GET' && verb === 'row') {
      // docs/specs/log.md, "HTTP": a Workstream's row, so that a client climbs its line.
      const row = await workstreams.projections.row(workstream, owned)
      return row === null ? reply(404, { reason: 'unknown_workstream' }) : reply(200, row), true
    }
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
      const address = await workstreams.podAddress(execution)
      const credentials = await options.credentials.mint({ label: `agora ${execution}`, ttlSeconds, ...(profiles ? { profiles } : {}), address })
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
  await feed(
    res,
    () => workstreams.projections.snapshot(workstream, after),
    (position) => workstreams.projections.tail(workstream, position),
  )
}

/**
 * Server-sent events of a feed — the thread, a list (docs/specs/log.md, "The thread", "The list"): its
 * snapshot, `snapshot-end` carrying H, then what follows H, read again every 250 ms while nothing comes.
 */
async function feed(
  res: ServerResponse,
  first: () => Promise<{ rows: ThreadRow[]; end: string }>,
  next: (after: string) => Promise<ThreadRow[]>,
): Promise<void> {
  const snapshot = await first()
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
    const rows = await next(position)
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
