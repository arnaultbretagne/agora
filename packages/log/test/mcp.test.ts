// Agora's MCP server (docs/specs/mcp.md), on its own port, called as the gateway's route calls it: the execution in
// `x-agora-execution`. An MCP client of the SDK speaks to it as a harness does: initialize, then tools/list or
// tools/call, each message a POST of its own. The transcripts searched are written as the projector writes them.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { keys } from '@agora/testkit'
import { CALLER_HEADER, createMcpServer } from '../src/index.ts'
import { database, FakeKube, grants, Lab } from './support.ts'
import { craft } from './transcripts.ts'

type Text = { content: { type: string; text: string }[]; isError?: boolean }

/** A Lab, its MCP server, and one Workstream of `owner` with an execution given `profiles`. */
async function started(t: { after(fn: () => Promise<void>): void }, profiles: string[]) {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  const signer = grants([])
  const db = await database()
  const lab = await Lab.start({ db, kube, keys: pair, credentials: signer.source })
  const mcp = createMcpServer(lab.workstreams)
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
  return { lab, db, url, owner, ws, execution: e.id }
}

/** An MCP client, as a harness's: its messages carry the header the gateway sets. */
async function client(t: { after(fn: () => Promise<void>): void }, url: string, execution: string): Promise<Client> {
  const c = new Client({ name: 'harness', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { [CALLER_HEADER]: `agora ${execution}` } } }))
  t.after(() => c.close())
  return c
}

const text = (result: unknown) => (result as Text).content.map((c) => c.text).join('\n')

test('M2 tools/list from an execution with agora:read: search and read, read-only, with their parameters', async (t) => {
  const { url, execution } = await started(t, ['agora:read'])
  const { tools } = await (await client(t, url, execution)).listTools()
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint, Object.keys(tool.inputSchema.properties ?? {}), tool.inputSchema.required]),
    [
      ['search', true, ['pattern', 'output_mode', 'ignore_case', 'before', 'after', 'context', 'head_limit', 'offset', 'tools', 'workstream'], ['pattern']],
      ['read', true, ['workstream', 'offset', 'limit'], ['workstream']],
    ],
  )
})

test('M3 a word in another of the person’s Workstreams, in a sub-stream of it and in another person’s: the two, newest first, never the other person’s', async (t) => {
  const { db, url, owner, execution } = await started(t, ['agora:read'])
  const root = await craft(db.admin, owner, [{ user: 'the root', agent: ['a quokka in the root'] }], { changedAt: '2026-11-02 08:00:00+00', title: 'The root' })
  const sub = await craft(db.admin, owner, [{ user: 'a quokka in the sub-stream' }], { changedAt: '2026-11-02 09:00:00+00', parent: root, title: 'The sub-stream' })
  await craft(db.admin, randomUUID(), [{ user: 'a quokka of someone else' }], { changedAt: '2026-11-02 10:00:00+00', title: 'Someone else' })
  const result = await (await client(t, url, execution)).callTool({ name: 'search', arguments: { pattern: 'quokka' } })
  assert.equal((result as Text).isError, undefined)
  assert.equal(
    text(result),
    [`${sub} · The sub-stream · 1 line`, '  2:a quokka in the sub-stream', `${root} · The root · 1 line`, '  4:a quokka in the root'].join('\n'),
  )
})

test('M4 read of one of the person’s Workstreams from an offset with a limit; of another person’s: unknown_workstream', async (t) => {
  const { db, url, owner, execution } = await started(t, ['agora:read'])
  const mine = await craft(db.admin, owner, [{ user: 'first', agent: ['one', 'two'] }, { user: 'second', agent: ['three'] }])
  const theirs = await craft(db.admin, randomUUID(), [{ user: 'not yours' }])
  const c = await client(t, url, execution)
  assert.equal(text(await c.callTool({ name: 'read', arguments: { workstream: mine, offset: 2, limit: 3 } })), ['2\tfirst', '3\t## 1 · agent', '4\tone', '(lines 2–4 of 9; next offset 5)'].join('\n'))
  assert.equal(text(await c.callTool({ name: 'read', arguments: { workstream: mine, offset: 8 } })), ['8\t## 2 · agent', '9\tthree', '(lines 8–9 of 9)'].join('\n'))
  assert.equal(text(await c.callTool({ name: 'read', arguments: { workstream: mine, offset: 12 } })), '(no line from 12; 9 lines)')
  const refused = (await c.callTool({ name: 'read', arguments: { workstream: theirs } })) as Text
  assert.deepEqual([refused.isError, text(refused)], [true, 'unknown_workstream'])
})

test('M5 port 8082 without x-agora-execution, naming an execution Agora does not know: 401, nothing read; a GET: 405', async (t) => {
  const { url, execution } = await started(t, ['agora:read'])
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
  const post = (headers: Record<string, string>) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(list) })
  for (const headers of [{}, { [CALLER_HEADER]: `agora ${randomUUID()}` }, { [CALLER_HEADER]: execution }]) {
    const response = await post(headers)
    assert.deepEqual([response.status, await response.json()], [401, { reason: 'unknown_caller' }], JSON.stringify(headers))
  }
  // The control: the same message, the execution named as the gateway names it.
  assert.equal((await post({ [CALLER_HEADER]: `agora ${execution}` })).status, 200)
  assert.equal((await fetch(url, { headers: { [CALLER_HEADER]: `agora ${execution}` } })).status, 405)
})

test('M6 an execution without agora:read: no tool listed, search refused, not_allowed', async (t) => {
  const { url, execution } = await started(t, ['internet'])
  const c = await client(t, url, execution)
  assert.deepEqual((await c.listTools()).tools, [])
  await assert.rejects(c.callTool({ name: 'search', arguments: { pattern: 'quokka' } }), /not_allowed/)
})

test('M7 search with the pattern `(`: invalid_pattern; with head_limit 500: invalid_query naming head_limit', async (t) => {
  const { url, execution } = await started(t, ['agora:read'])
  const c = await client(t, url, execution)
  const pattern = (await c.callTool({ name: 'search', arguments: { pattern: '(' } })) as Text
  assert.deepEqual([pattern.isError, text(pattern)], [true, 'invalid_pattern'])
  const limit = (await c.callTool({ name: 'search', arguments: { pattern: 'quokka', head_limit: 500 } })) as Text
  assert.deepEqual([limit.isError, text(limit)], [true, 'invalid_query: head_limit'])
})
