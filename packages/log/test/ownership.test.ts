// docs/specs/log.md, "HTTP": what a caller acts on and reads through the real server (apps/server/src/main.ts) — its own
// Workstreams, their executions, files, anchors and events —, another owner's answered as one that does not exist. Two
// callers with IDENTITY `oidc`, each a service token standing for a person's e-mail; then IDENTITY `none`, as before.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { mockFile } from '@agora/mock-agent/file'
import { identity, LogStore, type State } from '../src/index.ts'
import { cluster, database, expire, Server, serverGrants, until, type Db, type FakeKube } from './support.ts'

interface Caller {
  readonly headers: Record<string, string>
  readonly owner: string
  /** Its Workstream, its execution open on the mock agent. */
  readonly ws: string
  readonly execution: string
}

interface Answer {
  readonly status: number
  readonly body: unknown
}

/** One request: its status and its body, parsed when it is JSON; a stream's head alone. */
async function ask(base: string, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Answer> {
  const abort = new AbortController()
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: abort.signal,
  })
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    abort.abort()
    return { status: response.status, body: 'stream' }
  }
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) as unknown }
  } catch {
    return { status: response.status, body: text }
  }
}

const command = (kind: string, target: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => ({ id: randomUUID(), kind, target, body })

interface Served {
  readonly server: Server
  readonly db: Db
  readonly reader: LogStore
  readonly kube: FakeKube
  readonly a: Caller
  readonly b: Caller
  state(ws: string): Promise<State>
  /** A Workstream's last position: what was written in it. */
  written(ws: string): Promise<string>
}

/**
 * The real server with IDENTITY `oidc` and its grants, on FakeKube, the Pods pushing their anchors to it; two callers,
 * A and B, each a service token for a person's e-mail, each with a Workstream and an execution open in it.
 */
async function served(t: TestContext): Promise<Served> {
  const db = await database()
  const c = await cluster()
  const dir = mkdtempSync(join(tmpdir(), 'agora-tokens-'))
  const reader = new LogStore(db.urls)
  let server: Server | undefined
  t.after(async () => {
    await server?.stop()
    await reader.close()
    await c.close()
    await db.drop()
    rmSync(dir, { recursive: true, force: true })
  })
  const tokens = { a: randomBytes(32).toString('base64url'), b: randomBytes(32).toString('base64url') }
  writeFileSync(join(dir, 'a'), JSON.stringify({ token: tokens.a, email: 'a@example.org' }))
  writeFileSync(join(dir, 'b'), JSON.stringify({ token: tokens.b, email: 'b@example.org' }))
  // Service tokens alone: the issuer is never asked.
  const env = { IDENTITY: 'oidc', IDENTITY_ISSUER: 'http://127.0.0.1:9', IDENTITY_AUDIENCE: 'agora', IDENTITY_TOKENS_DIR: dir, ...serverGrants().env }
  server = await Server.start({ db, api: c.api, keys: c.keys, env })
  c.kube.anchorUrl = server.anchorUrl
  const state = (ws: string) => reader.state(ws)
  const open = async (token: string, email: string): Promise<Caller> => {
    const headers = { authorization: `Bearer ${token}` }
    const ws = randomUUID()
    assert.equal((await ask(server!.url, 'POST', '/api/workstreams', headers, { id: ws })).status, 200)
    assert.equal((await ask(server!.url, 'POST', `/api/workstreams/${ws}/commands`, headers, command('Create', {}, { pool: 'mock-test' }))).status, 200)
    const e = await until('Session open', async () => {
      const current = (await state(ws)).current
      return current?.session && current.connection ? current : null
    })
    return { headers, owner: identity('owner', email), ws, execution: e.id }
  }
  const [a, b] = [await open(tokens.a, 'a@example.org'), await open(tokens.b, 'b@example.org')]
  const written = async (ws: string) => String((await db.admin.query('SELECT last_position::text AS p FROM workstreams WHERE id=$1', [ws])).rows[0].p)
  return { server, db, reader, kube: c.kube, a, b, state, written }
}

/** A Write and its turn done: the mock agent answers. */
async function talk(s: Served, who: Caller, text: string): Promise<void> {
  const e = (await s.state(who.ws)).current!
  const turns = (await s.state(who.ws)).turns.size
  const written = await ask(s.server.url, 'POST', `/api/workstreams/${who.ws}/commands`, who.headers, command('Write', { execution: e.id, session: e.session }, { prompt: [{ type: 'text', text }] }))
  assert.equal(written.status, 200, JSON.stringify(written))
  await until('the turn done', async () => {
    const state = await s.state(who.ws)
    return state.turns.size > turns && state.active === null
  }, 20_000)
}

const unknownWorkstream = { status: 404, body: { reason: 'unknown_workstream' } }

test('L179 a command on another owner’s Workstream, on its execution: as on one that does not exist, nothing written; on the caller’s own, accepted', async (t) => {
  const s = await served(t)
  const { server, a, b } = s
  const before = await s.written(b.ws)
  const nobody = randomUUID()
  const session = (await s.state(b.ws)).current!.session
  const tried: [string, Record<string, unknown>][] = [
    ['a Write to its execution', command('Write', { execution: b.execution, session }, { prompt: [{ type: 'text', text: 'not yours' }] })],
    ['a Stop of its execution', command('Stop', { execution: b.execution })],
  ]
  for (const [name, body] of tried) {
    assert.deepEqual(await ask(server.url, 'POST', `/api/workstreams/${b.ws}/commands`, a.headers, body), unknownWorkstream, `${name}: B's`)
    assert.deepEqual(await ask(server.url, 'POST', `/api/workstreams/${nobody}/commands`, a.headers, { ...body, id: randomUUID() }), unknownWorkstream, `${name}: none`)
  }
  assert.equal(await s.written(b.ws), before, "nothing written in B's")
  assert.equal((await s.state(b.ws)).current?.stopped ?? false, false, "B's execution not stopped")
  // The controls: A's own, and B's by B.
  const mine = (await s.state(a.ws)).current!
  const own = await ask(server.url, 'POST', `/api/workstreams/${a.ws}/commands`, a.headers, command('Write', { execution: a.execution, session: mine.session }, { prompt: [{ type: 'text', text: 'mine' }] }))
  assert.equal(own.status, 200, JSON.stringify(own))
  assert.equal((await ask(server.url, 'POST', `/api/workstreams/${b.ws}/commands`, b.headers, command('Stop', { execution: b.execution }))).status, 200)
  assert.notEqual(await s.written(b.ws), before)
  t.diagnostic(`A on B's: a Write and a Stop of its execution 404 {"reason":"unknown_workstream"}, as on an id of no Workstream; B's last position ${before} kept, its execution running; A's own Write 200; B's Stop by B 200`)
})

test('L180 another owner’s thread, row, transcript, merge card and file: as for none; the caller’s own, read', async (t) => {
  const s = await served(t)
  const { server, a, b } = s
  await talk(s, b, '/file 100000 31')
  const digest = createHash('sha256').update(mockFile(100_000, 31)).digest('hex')
  const nobody = randomUUID()
  const reads = (ws: string) => [`/api/workstreams/${ws}/thread?after=0`, `/api/workstreams/${ws}/row`, `/api/workstreams/${ws}/read`, `/api/workstreams/${ws}/merge`]
  for (const [i, path] of reads(b.ws).entries()) {
    assert.deepEqual(await ask(server.url, 'GET', path, a.headers), unknownWorkstream, `A: ${path}`)
    assert.deepEqual(await ask(server.url, 'GET', reads(nobody)[i]!, a.headers), unknownWorkstream, `A: ${reads(nobody)[i]!}`)
  }
  const file = `/api/files/${digest}?type=image/jpeg`
  assert.deepEqual(await ask(server.url, 'GET', file, a.headers), { status: 404, body: { reason: 'unknown_file' } }, "A: B's file")
  assert.deepEqual(await ask(server.url, 'GET', `/api/files/${'0'.repeat(64)}?type=image/jpeg`, a.headers), { status: 404, body: { reason: 'unknown_file' } }, 'A: no file')
  // The controls: B reads its own.
  const own = reads(b.ws)
  assert.deepEqual(await ask(server.url, 'GET', own[0]!, b.headers), { status: 200, body: 'stream' })
  assert.equal((await until('its row', async () => ((await ask(server.url, 'GET', own[1]!, b.headers)).status === 200 ? true : null))), true)
  const transcript = await ask(server.url, 'GET', own[2]!, b.headers)
  assert.equal(transcript.status, 200)
  assert.match(JSON.stringify(transcript.body), /\/file 100000 31/)
  assert.deepEqual(await ask(server.url, 'GET', own[3]!, b.headers), { status: 404, body: { reason: 'no_merge' } })
  const bytes = await fetch(`${server.url}${file}`, { headers: b.headers })
  assert.equal(bytes.status, 200)
  assert.equal(createHash('sha256').update(Buffer.from(await bytes.arrayBuffer())).digest('hex'), digest)
  t.diagnostic(`A on B's: thread, row, read, merge 404 {"reason":"unknown_workstream"}, as for an id of none; B's file 404 {"reason":"unknown_file"}, as an unknown digest; B: its thread a stream, its row, its transcript, no_merge, its file's ${digest.slice(0, 12)}… bytes`)
})

test('L181 the test routes on another owner’s Workstream — entries, control, credentials —: as for none, nothing written or handed over; the caller’s own, as before', async (t) => {
  const s = await served(t)
  const { server, a, b } = s
  const outbound = async (who: Caller) => (((await ask(server.url, 'GET', '/api/executions', who.headers)).body as { executions: { execution: string; outbound: unknown }[] }).executions.find((v) => v.execution === who.execution))?.outbound
  const before = { position: await s.written(b.ws), outbound: JSON.stringify(await outbound(b)) }
  const nobody = randomUUID()
  const routes = (ws: string, execution: string): [string, string, unknown?][] => [
    ['GET', `/api/workstreams/${ws}/entries`],
    ['POST', `/api/workstreams/${ws}/control`, { execution, method: 'session/set_config_option', params: { configId: 'model', value: 'mock-large' } }],
    ['POST', `/api/workstreams/${ws}/credentials`, { execution, ttlSeconds: 600 }],
  ]
  for (const [i, [method, path, body]] of routes(b.ws, b.execution).entries()) {
    assert.deepEqual(await ask(server.url, method, path, a.headers, body), unknownWorkstream, `A: ${method} ${path}`)
    const [m, p, bd] = routes(nobody, b.execution)[i]!
    assert.deepEqual(await ask(server.url, m, p, a.headers, bd), unknownWorkstream, `A: ${m} ${p}`)
  }
  assert.equal(await s.written(b.ws), before.position, "nothing written in B's")
  assert.equal(JSON.stringify(await outbound(b)), before.outbound, "no credential handed to B's bridge")
  // The controls: A's own.
  const [entries, control, credentials] = routes(a.ws, a.execution)
  const read = await ask(server.url, entries![0], entries![1], a.headers)
  assert.equal(read.status, 200)
  assert.ok(Array.isArray(read.body) && read.body.length > 0)
  const set = await ask(server.url, control![0], control![1], a.headers, control![2])
  assert.equal(set.status, 200, JSON.stringify(set))
  const handed = await ask(server.url, credentials![0], credentials![1], a.headers, credentials![2])
  assert.deepEqual([handed.status, (handed.body as { accepted?: boolean }).accepted], [200, true], JSON.stringify(handed))
  t.diagnostic(`A on B's: entries, control, credentials 404 {"reason":"unknown_workstream"}, as for an id of none; B's last position ${before.position} kept, its bridge's outbound unchanged; A's own: ${String((read.body as unknown[]).length)} entries, control ${JSON.stringify(set.body)}, credentials accepted, expiring ${String((handed.body as { expiresAt?: string }).expiresAt)}`)
})

test('L182 the anchors: each caller’s list its own; another owner’s anchor as one that does not exist; the caller’s own, read', async (t) => {
  const s = await served(t)
  const { server, db, a, b } = s
  await talk(s, a, 'remember me')
  await talk(s, b, 'remember me too')
  // Each Pod pushes its anchor at its deadline, brought to now.
  for (const who of [a, b]) await expire(s.kube, (await s.state(who.ws)).current!.claimName)
  const stored = await until('an anchor of each', async () => {
    const rows = (await db.admin.query('SELECT id::text, workstream::text FROM anchors')).rows as { id: string; workstream: string }[]
    return rows.some((r) => r.workstream === a.ws) && rows.some((r) => r.workstream === b.ws) ? rows : null
  }, 20_000)
  const listed = async (who: Caller) => (((await ask(server.url, 'GET', '/api/anchors', who.headers)).body as { anchors: { workstream: string }[] }).anchors.map((x) => x.workstream))
  assert.deepEqual([...new Set(await listed(a))], [a.ws])
  assert.deepEqual([...new Set(await listed(b))], [b.ws])
  const theirs = stored.find((r) => r.workstream === b.ws)!.id
  assert.deepEqual(await ask(server.url, 'GET', `/api/anchors/${theirs}/content`, a.headers), { status: 404, body: { reason: 'unknown_anchor' } })
  assert.deepEqual(await ask(server.url, 'GET', `/api/anchors/${randomUUID()}/content`, a.headers), { status: 404, body: { reason: 'unknown_anchor' } })
  const own = await ask(server.url, 'GET', `/api/anchors/${theirs}/content`, b.headers)
  assert.equal(own.status, 200)
  assert.match(String(own.body), /^===== /)
  t.diagnostic(`${String(stored.length)} anchors stored; A's list: its Workstream's alone, B's: its own alone; B's anchor by A 404 {"reason":"unknown_anchor"}, as an unknown id; by B 200, its native files`)
})

test('L183 the executions: each caller’s list and events its own; another owner’s execution cut or probed as one Agora does not know, nothing done; the caller’s own, as before', async (t) => {
  const s = await served(t)
  const { server, a, b } = s
  const listed = async (who: Caller) => (((await ask(server.url, 'GET', '/api/executions', who.headers)).body as { executions: { execution: string }[] }).executions.map((v) => v.execution))
  assert.deepEqual(await listed(a), [a.execution])
  assert.deepEqual(await listed(b), [b.execution])
  // A's events, from their snapshot on.
  const events: { type: string; executions?: { execution: string }[]; execution?: { execution: string } }[] = []
  const abort = new AbortController()
  t.after(() => abort.abort())
  const stream = await fetch(`${server.url}/api/events`, { headers: a.headers, signal: abort.signal })
  assert.equal(stream.status, 200)
  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as (typeof events)[number])
      }
    }
  })().catch(() => {})
  await until('the snapshot', () => events.length > 0)
  assert.deepEqual(events[0]!.executions!.map((v) => v.execution), [a.execution])
  const connection = async () => (await s.state(b.ws)).current?.connection ?? null
  const was = await connection()
  const nobody = randomUUID()
  for (const [verb, reason] of [['drop-bridge', (name: string) => `unknown execution: ${name}`], ['probe-auth', () => 'unknown execution or no Pod']] as const) {
    assert.deepEqual(await ask(server.url, 'POST', `/api/test/executions/${b.execution}/${verb}`, a.headers, {}), { status: 404, body: { accepted: false, reason: reason(b.execution) } }, `A: B's ${verb}`)
    assert.deepEqual(await ask(server.url, 'POST', `/api/test/executions/${nobody}/${verb}`, a.headers, {}), { status: 404, body: { accepted: false, reason: reason(nobody) } }, `A: none's ${verb}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.equal(await connection(), was, "B's connection not cut")
  // The controls: B cuts its own, then A its own; A's events give A's alone.
  assert.equal((await ask(server.url, 'POST', `/api/test/executions/${b.execution}/drop-bridge`, b.headers, {})).status, 200)
  await until("B's bridge back", async () => ((await connection()) !== was && (await connection()) !== null ? true : null))
  const seen = events.length
  assert.equal((await ask(server.url, 'POST', `/api/test/executions/${a.execution}/drop-bridge`, a.headers, {})).status, 200)
  await until("an event of A's", () => events.slice(seen).some((e) => e.execution?.execution === a.execution))
  const named = [...new Set(events.slice(1).map((e) => e.execution?.execution))]
  assert.deepEqual(named, [a.execution])
  const probed = await ask(server.url, 'POST', `/api/test/executions/${a.execution}/probe-auth`, a.headers, {})
  assert.equal(probed.status, 200)
  t.diagnostic(`lists: A's [its own], B's [its own]; A's events: snapshot [its own], then ${String(events.length - 1)} events, all of A's execution, none of B's after B cut its own bridge; A on B's: drop-bridge and probe-auth 404 as for an id of none, B's connection kept; A's own: drop-bridge 200, probe-auth 200`)
})

test('L184 IDENTITY none: with no header, every owner’s Workstreams and executions, as before; with the proxy’s header, its owner’s alone', async (t) => {
  const db = await database()
  const c = await cluster()
  const reader = new LogStore(db.urls)
  const server = await Server.start({ db, api: c.api, keys: c.keys })
  c.kube.anchorUrl = server.anchorUrl
  t.after(async () => {
    await server.stop()
    await reader.close()
    await c.close()
    await db.drop()
  })
  const owners = [identity('owner', 'a@example.org'), identity('owner', 'b@example.org')]
  const opened: { ws: string; execution: string }[] = []
  for (const owner of owners) {
    const ws = randomUUID()
    assert.equal((await ask(server.url, 'POST', '/api/workstreams', {}, { id: ws, owner })).status, 200)
    assert.equal((await ask(server.url, 'POST', `/api/workstreams/${ws}/commands`, {}, command('Create', {}, { pool: 'mock-test' }))).status, 200)
    const e = await until('Session open', async () => {
      const current = (await reader.state(ws)).current
      return current?.session && current.connection ? current : null
    })
    opened.push({ ws, execution: e.id })
  }
  const [a, b] = opened as [{ ws: string; execution: string }, { ws: string; execution: string }]
  // No header: anyone's.
  const write = async (ws: string, headers: Record<string, string>) => {
    const e = (await reader.state(ws)).current!
    return ask(server.url, 'POST', `/api/workstreams/${ws}/commands`, headers, command('Write', { execution: e.id, session: e.session }, { prompt: [{ type: 'text', text: 'hello' }] }))
  }
  for (const { ws } of opened) {
    const written = await write(ws, {})
    assert.equal(written.status, 200, JSON.stringify(written))
    assert.deepEqual(await ask(server.url, 'GET', `/api/workstreams/${ws}/thread?after=0`, {}), { status: 200, body: 'stream' })
    assert.equal((await ask(server.url, 'GET', `/api/workstreams/${ws}/entries`, {})).status, 200)
  }
  const executions = (((await ask(server.url, 'GET', '/api/executions', {})).body as { executions: { execution: string }[] }).executions.map((v) => v.execution)).sort()
  assert.deepEqual(executions, [a.execution, b.execution].sort())
  // As before for an id of no Workstream: the entries empty, the thread 404.
  const nobody = randomUUID()
  assert.deepEqual(await ask(server.url, 'GET', `/api/workstreams/${nobody}/entries`, {}), { status: 200, body: [] })
  assert.deepEqual(await ask(server.url, 'GET', `/api/workstreams/${nobody}/thread?after=0`, {}), unknownWorkstream)
  // The proxy's header: its owner's alone.
  const proxied = { 'x-forwarded-email': 'a@example.org' }
  assert.deepEqual(((await ask(server.url, 'GET', '/api/executions', proxied)).body as { executions: { execution: string }[] }).executions.map((v) => v.execution), [a.execution])
  assert.deepEqual(await ask(server.url, 'POST', `/api/workstreams/${b.ws}/commands`, proxied, command('Stop', { execution: b.execution })), unknownWorkstream)
  assert.equal((await ask(server.url, 'POST', `/api/workstreams/${a.ws}/commands`, proxied, command('Stop', { execution: a.execution }))).status, 200)
  t.diagnostic(`no header: a Write, the thread and the entries of both owners' Workstreams, both executions listed; an id of none: entries [], thread 404; the header of a@example.org: a Stop in B's 404 unknown_workstream, in its own 200, its execution alone listed`)
})
