// Agora's MCP server (docs/specs/mcp.md), on its own port, called as the gateway's route calls it: the execution's
// grant, `Authorization: Bearer`. An MCP client of the SDK speaks to it as a harness does: initialize, then tools/list or
// tools/call, each message a POST of its own. The transcripts searched are written as the projector writes them.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { SignJWT } from 'jose'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { keys } from '@agora/testkit'
import { createMcpServer, LogStore, Merges } from '../src/index.ts'
import { cluster, database, FakeKube, freePort, grants, Lab, Server, serverGrants, until } from './support.ts'
import { craft } from './transcripts.ts'

type Text = { content: { type: string; text: string }[]; isError?: boolean }

/** A Lab, its MCP server, and one Workstream of `owner` with an execution given `profiles`. */
async function started(t: { after(fn: () => Promise<void>): void }, profiles: string[]) {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  const signer = grants([])
  const db = await database()
  const lab = await Lab.start({ db, kube, keys: pair, credentials: signer.source })
  const mcp = createMcpServer(lab.workstreams, signer.key)
  await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${String((mcp.address() as AddressInfo).port)}/mcp`
  t.after(async () => {
    await new Promise((resolve) => mcp.close(resolve))
    await lab.close()
    await db.drop()
  })
  const owner = randomUUID()
  const ws = await lab.workstream(owner)
  const e = await lab.open(ws, { pool: 'mock-test', profiles })
  return { lab, db, url, owner, ws, execution: e.id, grant: signer.grantOf(e.id), signer }
}

/** An MCP client, as a harness's: its messages carry the grant the gateway forwards, the one its bridge holds. */
async function client(t: { after(fn: () => Promise<void>): void }, url: string, grant: string): Promise<Client> {
  const c = new Client({ name: 'harness', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${grant}` } } }))
  t.after(() => c.close())
  return c
}

const text = (result: unknown) => (result as Text).content.map((c) => c.text).join('\n')

test('M2 tools/list from an execution with agora:read: search and read, read-only, with their parameters', async (t) => {
  const { url, grant } = await started(t, ['agora:read'])
  const { tools } = await (await client(t, url, grant)).listTools()
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint, Object.keys(tool.inputSchema.properties ?? {}), tool.inputSchema.required]),
    [
      ['search', true, ['pattern', 'output_mode', 'ignore_case', 'before', 'after', 'context', 'head_limit', 'offset', 'tools', 'workstream'], ['pattern']],
      ['read', true, ['workstream', 'offset', 'limit'], ['workstream']],
    ],
  )
})

test('M3 a word in another of the person’s Workstreams, in a sub-stream of it and in another person’s: the two, newest first, never the other person’s', async (t) => {
  const { db, url, owner, grant } = await started(t, ['agora:read'])
  const root = await craft(db.admin, owner, [{ user: 'the root', agent: ['a quokka in the root'] }], { changedAt: '2026-11-02 08:00:00+00', title: 'The root' })
  const sub = await craft(db.admin, owner, [{ user: 'a quokka in the sub-stream' }], { changedAt: '2026-11-02 09:00:00+00', parent: root, title: 'The sub-stream' })
  await craft(db.admin, randomUUID(), [{ user: 'a quokka of someone else' }], { changedAt: '2026-11-02 10:00:00+00', title: 'Someone else' })
  const result = await (await client(t, url, grant)).callTool({ name: 'search', arguments: { pattern: 'quokka' } })
  assert.equal((result as Text).isError, undefined)
  assert.equal(
    text(result),
    [`${sub} · The sub-stream · 1 line`, '  2:a quokka in the sub-stream', `${root} · The root · 1 line`, '  4:a quokka in the root'].join('\n'),
  )
})

test('M4 read of one of the person’s Workstreams from an offset with a limit; of another person’s: unknown_workstream', async (t) => {
  const { db, url, owner, grant } = await started(t, ['agora:read'])
  const mine = await craft(db.admin, owner, [{ user: 'first', agent: ['one', 'two'] }, { user: 'second', agent: ['three'] }])
  const theirs = await craft(db.admin, randomUUID(), [{ user: 'not yours' }])
  const c = await client(t, url, grant)
  assert.equal(text(await c.callTool({ name: 'read', arguments: { workstream: mine, offset: 2, limit: 3 } })), ['2\tfirst', '3\t## 1 · agent', '4\tone', '(lines 2–4 of 9; next offset 5)'].join('\n'))
  assert.equal(text(await c.callTool({ name: 'read', arguments: { workstream: mine, offset: 8 } })), ['8\t## 2 · agent', '9\tthree', '(lines 8–9 of 9)'].join('\n'))
  assert.equal(text(await c.callTool({ name: 'read', arguments: { workstream: mine, offset: 12 } })), '(no line from 12; 9 lines)')
  const refused = (await c.callTool({ name: 'read', arguments: { workstream: theirs } })) as Text
  assert.deepEqual([refused.isError, text(refused)], [true, 'unknown_workstream'])
})

test('M5 a grant of Agora’s naming an execution it does not know; naming one without `agora ` before it: 401, nothing read; a GET: 405', async (t) => {
  const { url, execution, grant, signer } = await started(t, ['agora:read'])
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
  const post = (token: string) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify(list) })
  const signed = async (label: string) => (await signer.source.mint({ label, ttlSeconds: 600, profiles: ['agora:read'], address: '127.0.0.1' })).token
  for (const [name, label] of [['unknown', `agora ${randomUUID()}`], ['without agora', execution]] as const) {
    const response = await post(await signed(label))
    assert.deepEqual([response.status, await response.json()], [401, { reason: 'unknown_caller' }], name)
  }
  // The control: the same message with the grant the execution's bridge holds.
  assert.equal((await post(grant)).status, 200)
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${grant}` } })).status, 405)
})

test('M6 an execution scoped out of agora:read: no tool listed, search refused, not_allowed', async (t) => {
  const { lab, ws, url, execution, grant, signer } = await started(t, ['internet'])
  // The control: given it unnamed (docs/specs/credentials.md, "Default profiles"), it lists search and read.
  assert.deepEqual((await (await client(t, url, grant)).listTools()).tools.map((tool) => tool.name), ['search', 'read'])
  assert.ok((await lab.command(ws, 'Scope', { execution }, { profiles: ['internet'] })).accepted)
  const c = await client(t, url, signer.grantOf(execution))
  assert.deepEqual((await c.listTools()).tools, [])
  await assert.rejects(c.callTool({ name: 'search', arguments: { pattern: 'quokka' } }), /not_allowed/)
})

test('M7 search with the pattern `(`: invalid_pattern; with head_limit 500: invalid_query naming head_limit', async (t) => {
  const { url, grant } = await started(t, ['agora:read'])
  const c = await client(t, url, grant)
  const pattern = (await c.callTool({ name: 'search', arguments: { pattern: '(' } })) as Text
  assert.deepEqual([pattern.isError, text(pattern)], [true, 'invalid_pattern'])
  const limit = (await c.callTool({ name: 'search', arguments: { pattern: 'quokka', head_limit: 500 } })) as Text
  assert.deepEqual([limit.isError, text(limit)], [true, 'invalid_query: head_limit'])
})

test('G1 tools/list with a repository’s write: propose_merge, which proposes on that repository; with its read alone: no propose_merge, not_allowed', async (t) => {
  const pull = { number: 7, title: 'Add x', url: 'https://github.com/octo/app/pull/7', open: true, merged: false, draft: false, base: 'main', head: 'feat/x', sha: 'abc', author: 'agora-contributor[bot]', mergeableState: 'clean', mergeSha: '' }
  const github = { pull: async () => pull, state: async () => ({ state: 'ready' as const, pull }), merge: async () => ({ merged: true as const, sha: 'def' }) }
  const writer = await started(t, ['github:octo/app:write'])
  new Merges(writer.lab.workstreams, { github })
  const c = await client(t, writer.url, writer.grant)
  const { tools } = await c.listTools()
  assert.deepEqual(tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {}), tool.inputSchema.required]), [
    ['search', ['pattern', 'output_mode', 'ignore_case', 'before', 'after', 'context', 'head_limit', 'offset', 'tools', 'workstream'], ['pattern']],
    ['read', ['workstream', 'offset', 'limit'], ['workstream']],
    ['propose_merge', ['repo', 'number'], ['repo', 'number']],
  ])
  assert.match(text(await c.callTool({ name: 'propose_merge', arguments: { repo: 'octo/app', number: 7 } })), /^proposed octo\/app#7:/)
  const other = await c.callTool({ name: 'propose_merge', arguments: { repo: 'octo/other', number: 7 } })
  assert.deepEqual([text(other), other.isError], ['not_allowed', true])
  const reader = await started(t, ['github:octo/app:read'])
  new Merges(reader.lab.workstreams, { github })
  const r = await client(t, reader.url, reader.grant)
  // The default profiles' tools alone (docs/specs/credentials.md, "Default profiles").
  assert.deepEqual((await r.listTools()).tools.map((tool) => tool.name), ['search', 'read'])
  await assert.rejects(r.callTool({ name: 'propose_merge', arguments: { repo: 'octo/app', number: 7 } }), /not_allowed/)
})

test('M14 port 8082 of the real server: the grant it signed for an execution, as the gateway forwards it, served as that execution; none, the header alone, expired, another key, tampered and the rest: 401, nothing done', async (t) => {
  const db = await database()
  const c = await cluster()
  const g = serverGrants()
  const mcpPort = await freePort()
  const server = await Server.start({ db, api: c.api, keys: c.keys, env: { ...g.env, MCP_PORT: String(mcpPort) } })
  c.kube.anchorUrl = server.anchorUrl
  const reader = new LogStore(db.urls)
  t.after(async () => {
    await server.stop()
    await reader.close()
    await c.close()
    await db.drop()
  })
  // Two Workstreams of one person, each with an execution that may delegate: the caller, and the one a forged grant names.
  const owner = randomUUID()
  const [ws, other] = [randomUUID(), randomUUID()]
  const executions: string[] = []
  for (const id of [ws, other]) {
    assert.equal((await server.post('/api/workstreams', { id, owner })).status, 200)
    assert.equal((await server.command(id, 'Create', {}, { pool: 'mock-test', profiles: ['agora:delegate'] })).status, 200)
    executions.push((await until('Session open', async () => ((await reader.state(id)).current?.session ? (await reader.state(id)).current : null))).id)
  }
  const [mine, theirs] = executions as [string, string]
  const url = `http://127.0.0.1:${String(mcpPort)}/mcp`
  // A spawn_agent call: done, it writes a sub-stream of the caller's Workstream.
  const spawn = (headers: Record<string, string>) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spawn_agent', arguments: { instructions: '/sleep 1', harness: 'mock' } } }),
    })
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const now = Math.floor(Date.now() / 1000)
  /** A grant as the server signs one, each field changeable, `exp` left out with null. */
  const forged = (claims: { sub?: string; iss?: string; aud?: string; exp?: number | null; kid?: string } = {}, key = g.privateKey) => {
    const jwt = new SignJWT({ ip: '127.0.0.1', profiles: ['agora:delegate'], grants: [] })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: claims.kid ?? 'agora-grants-1' })
      .setIssuer(claims.iss ?? 'agora')
      .setAudience(claims.aud ?? 'agora-gateway')
      .setSubject(claims.sub ?? `agora ${mine}`)
      .setJti(randomUUID())
      .setIssuedAt(now - 60)
    if (claims.exp !== null) jwt.setExpirationTime(claims.exp ?? now + 600)
    return jwt.sign(key)
  }
  const valid = await g.grant(mine)
  const [head, payload, signature] = valid.split('.') as [string, string, string]
  const tampered = [head, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: `agora ${theirs}` })).toString('base64url'), signature].join('.')
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`
  const proofs: [string, Record<string, string>][] = [
    ['no Authorization', {}],
    ['x-agora-execution alone', { 'x-agora-execution': `agora ${mine}` }],
    ['expired 2 min ago', bearer(await forged({ exp: now - 120 }))],
    ['no exp', bearer(await forged({ exp: null }))],
    ['another key, the same key id', bearer(await forged({}, generateKeyPairSync('ed25519').privateKey))],
    ['x-agora-execution and a grant of another key', { 'x-agora-execution': `agora ${mine}`, ...bearer(await forged({}, generateKeyPairSync('ed25519').privateKey)) }],
    ['tampered: another execution of the person', bearer(tampered)],
    ['another audience', bearer(await forged({ aud: 'agora-mcp' }))],
    ['another issuer', bearer(await forged({ iss: 'pocket-id' }))],
    ['another key id', bearer(await forged({ kid: 'agora-grants-0' }))],
    ['not signed', bearer(unsigned)],
    ['in Proxy-Authorization', { 'proxy-authorization': `Bearer ${valid}` }],
  ]
  const subStreams = async () => Number((await db.admin.query('SELECT count(*)::int AS n FROM workstreams WHERE parent = ANY($1::uuid[])', [[ws, other]])).rows[0].n)
  for (const [name, headers] of proofs) {
    const response = await spawn(headers)
    assert.deepEqual([response.status, await response.json()], [401, { reason: 'unauthenticated' }], name)
  }
  assert.equal(await subStreams(), 0, 'nothing done')
  // Any request, not only a message: a GET with no grant is refused before its method is looked at.
  const bare = await fetch(url)
  assert.deepEqual([bare.status, await bare.json()], [401, { reason: 'unauthenticated' }], 'a GET')
  // The control: the grant the server signed for the execution, as the gateway forwards it — served as that execution.
  const served = await spawn(bearer(valid))
  assert.equal(served.status, 200)
  const answer = (await served.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)) as { result?: { content: { text: string }[]; isError?: boolean } }).at(-1)
  assert.match(answer?.result?.content[0]?.text ?? '', /^started [0-9a-f-]{36} · /)
  const started = (await db.admin.query('SELECT id::text, parent::text FROM workstreams WHERE parent = ANY($1::uuid[])', [[ws, other]])).rows as { id: string; parent: string }[]
  assert.deepEqual(started.map((r) => r.parent), [ws])
  t.diagnostic(`${String(proofs.length)} proofs: 401 {"reason":"unauthenticated"} each, no sub-stream written; a GET with none 401; the server's grant for ${mine.slice(0, 8)}…: 200, "${answer?.result?.content[0]?.text ?? ''}", its sub-stream under ${ws.slice(0, 8)}…, the caller's Workstream`)
})
