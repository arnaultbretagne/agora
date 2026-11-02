// Delegation (docs/specs/delegation.md), on the lab: the caller's MCP calls made as its harness makes them — the SDK's
// client, the execution named as the gateway names it —, the delegates run by the mock agent, reports written by
// Agora's engine. Approvals live seconds here, not 4 min 30 s.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { keys } from '@agora/testkit'
import { CALLER_HEADER, createMcpServer, Delegations } from '../src/index.ts'
import { database, expire, FakeKube, grants, Lab, lines, until, type LabOptions } from './support.ts'

type Text = { content: { type: string; text: string }[]; isError?: boolean }
type T = { after(fn: () => Promise<void>): void }

async function started(
  t: T,
  profiles: string[],
  options: { approvalMs?: number; progressMs?: number; manual?: boolean } = {},
  extra: { workstreams?: LabOptions['workstreams']; open?: Record<string, unknown> } = {},
) {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  const db = await database()
  const lab = await Lab.start({ db, kube, keys: pair, credentials: grants([]).source, workstreams: { maxActive: 8, ...extra.workstreams } })
  const delegations = new Delegations(lab.workstreams, { approvalMs: 3_000, progressMs: 500, ...options })
  const mcp = createMcpServer(lab.workstreams)
  await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${String((mcp.address() as AddressInfo).port)}/mcp`
  t.after(async () => {
    await new Promise((resolve) => mcp.close(resolve))
    await lab.close()
    await db.drop()
  })
  const ws = await lab.workstream()
  const e = await lab.open(ws, { profiles, ...extra.open })
  return { lab, db, url, ws, execution: e.id, delegations }
}

async function client(t: T, url: string, execution: string): Promise<Client> {
  const c = new Client({ name: 'harness', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { [CALLER_HEADER]: `agora ${execution}` } } }))
  t.after(() => c.close())
  return c
}

const text = (result: unknown) => (result as Text).content.map((c) => c.text).join('\n')
const delegateOf = (answer: string) => /^started ([0-9a-f-]{36}) · /.exec(answer)?.[1] ?? assert.fail(`not started: ${answer}`)
const elements = async (lab: Lab, ws: string, type: string) =>
  (await lab.workstreams.projections.objects(ws)).filter((o) => o.kind === 'element' && o.object.type === type).map((o) => o.object)
const reportsOf = (lab: Lab, ws: string) => elements(lab, ws, 'report')
const kinds = async (lab: Lab, ws: string, kind: string) => (await lab.entries(ws)).filter((e) => e.kind === kind)
/** A manual engine beating until the delegate has answered its instructions: its Session opens on its own time. */
const answered = (lab: Lab, delegations: Delegations, delegate: string) =>
  until('the delegate answered', async () => {
    await delegations.tick(true)
    return [...(await lab.state(delegate)).turns.values()].at(-1)?.status === 'done'
  })

test('D1 delegate within the caller’s rights: started at once; a sub-stream one level down, on the pool named, the instructions its first message, marked as its caller’s', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:delegate'])
  const answer = text(await (await client(t, url, execution)).callTool({ name: 'delegate', arguments: { instructions: 'hello delegate', harness: 'mock' } }))
  const delegate = delegateOf(answer)
  assert.equal(answer, `started ${delegate} · hello delegate`)
  const row = (await db.admin.query('SELECT parent, depth FROM workstreams WHERE id=$1', [delegate])).rows[0] as { parent: string; depth: number }
  assert.deepEqual([row.parent, row.depth], [ws, 1])
  await lab.turn(delegate, 'done')
  const [user] = await elements(lab, delegate, 'user')
  assert.equal(user?.from, ws)
  assert.equal((user?.content as { text: string }[])[0]?.text, 'hello delegate')
  assert.equal((await lab.state(delegate)).current?.body.pool, 'mock-test')
})

test('D2 the delegate’s turn ends: once the caller is free, a report marked as Agora’s, the id, completed, the last message', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'delegate', arguments: { instructions: 'report back', harness: 'mock' } })))
  const [report] = await until('a report', async () => ((await reportsOf(lab, ws)).length > 0 ? reportsOf(lab, ws) : null))
  assert.deepEqual(report?.delegates, [delegate])
  assert.match(String(report?.text), /^From Agora, not the person:/)
  assert.match(String(report?.text), new RegExp(`${delegate} "report back": completed, its last message: Echo #1: report back\\.`))
  assert.equal((await kinds(lab, delegate, 'delegation.reported')).length, 1)
  // The report is a turn of the caller's, answered as any.
  await lab.turn(ws, 'done')
})

test('D3 two delegates ending while the caller’s turn runs: one report after that turn, both outcomes', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  assert.equal((await lab.write(ws, '/sleep 4')).accepted, true)
  const c = await client(t, url, execution)
  const one = delegateOf(text(await c.callTool({ name: 'delegate', arguments: { instructions: 'one', harness: 'mock' } })))
  const two = delegateOf(text(await c.callTool({ name: 'delegate', arguments: { instructions: 'two', harness: 'mock' } })))
  await lab.turn(one, 'done')
  await lab.turn(two, 'done')
  assert.equal((await reportsOf(lab, ws)).length, 0, 'not while the caller’s turn runs')
  const [report] = await until('the report', async () => ((await reportsOf(lab, ws)).length > 0 ? reportsOf(lab, ws) : null), 20_000)
  assert.deepEqual(new Set(report?.delegates as string[]), new Set([one, two]))
  assert.equal((await reportsOf(lab, ws)).length, 1)
})

test('D4 the person writes as the caller turns free, a report pending: the person’s message first, the report after its turn', async (t) => {
  const { lab, url, ws, execution, delegations } = await started(t, ['agora:delegate'], { manual: true })
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'delegate', arguments: { instructions: 'later', harness: 'mock' } })))
  await answered(lab, delegations, delegate)
  assert.equal((await lab.write(ws, '/sleep 2')).accepted, true)
  await delegations.tick(true)
  assert.equal((await reportsOf(lab, ws)).length, 0, 'the person’s turn first')
  await lab.turn(ws, 'done', 20_000)
  await delegations.tick(true)
  const prompts = [...(await lab.state(ws)).turns.values()]
  assert.equal(prompts.length, 2)
  assert.equal((await reportsOf(lab, ws)).length, 1)
})

test('D5 a caller at depth 3; a caller with three delegates working: depth_exceeded; too_many_delegates; no Workstream created', async (t) => {
  const { lab, db, url, execution } = await started(t, ['agora:delegate'])
  const owner = randomUUID()
  const root = randomUUID(),
    a = randomUUID(),
    b = randomUUID(),
    deep = randomUUID()
  await lab.store.create(root, owner)
  await lab.store.create(a, null, root)
  await lab.store.create(b, null, a)
  await lab.store.create(deep, null, b)
  const e = await lab.open(deep, { profiles: ['agora:delegate'] })
  const count = async () => Number((await db.admin.query('SELECT count(*) FROM workstreams')).rows[0].count)
  const before = await count()
  const refusedDeep = (await (await client(t, url, e.id)).callTool({ name: 'delegate', arguments: { instructions: 'too deep', harness: 'mock' } })) as Text
  assert.deepEqual([refusedDeep.isError, text(refusedDeep)], [true, 'depth_exceeded'])
  const c = await client(t, url, execution)
  for (const n of [1, 2, 3]) delegateOf(text(await c.callTool({ name: 'delegate', arguments: { instructions: `/sleep 10 ${String(n)}`, harness: 'mock' } })))
  const fourth = (await c.callTool({ name: 'delegate', arguments: { instructions: 'a fourth', harness: 'mock' } })) as Text
  assert.deepEqual([fourth.isError, text(fourth)], [true, 'too_many_delegates'])
  assert.equal(await count(), before + 3)
})

test('D6 rights beyond the caller’s, then Approve: the call held, an approval in the caller’s Workstream with one option; started once approved', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const call = (await client(t, url, execution)).callTool({ name: 'delegate', arguments: { instructions: 'needs the internet', harness: 'mock', rights: ['internet'] } })
  const ask = await until('the approval', async () => (await lab.state(ws)).question)
  const [approval] = await elements(lab, ws, 'question')
  assert.deepEqual([approval?.kind, approval?.status, (approval?.options as unknown[]).length], ['approval', 'pending', 1])
  assert.match(String(approval?.text), /Rights beyond the caller's: `internet`/)
  assert.equal((await lab.command(ws, 'Answer', { question: ask.position }, { optionId: 'approve' })).accepted, true)
  const delegate = delegateOf(text(await call))
  assert.deepEqual((await lab.state(delegate)).current?.profiles, ['internet'])
})

test('D7 the person writes while the approval waits: refused with the words; no prompt sent; no delegate', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:delegate'])
  const call = (await client(t, url, execution)).callTool({ name: 'delegate', arguments: { instructions: 'needs the internet', harness: 'mock', rights: ['internet'] } })
  await until('the approval', async () => (await lab.state(ws)).question)
  const turns = (await lab.state(ws)).turns.size
  assert.equal((await lab.write(ws, 'use the read-only rights')).accepted, true)
  const answer = (await call) as Text
  assert.deepEqual([answer.isError, text(answer)], [true, 'refused: use the read-only rights'])
  assert.equal((await lab.state(ws)).turns.size, turns, 'no prompt')
  const [approval] = await elements(lab, ws, 'question')
  assert.deepEqual([approval?.status, (approval?.answer as { note: string }).note], ['refused', 'use the read-only rights'])
  assert.equal(Number((await db.admin.query('SELECT count(*) FROM workstreams WHERE parent=$1', [ws])).rows[0].count), 0)
})

test('D8 no answer: expired at the approval’s end; progress meanwhile; the caller’s turn deadline pushed back by the wait', async (t) => {
  const limits = { leaseSeconds: 60, turnCapSeconds: 30 }
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], { approvalMs: 2_000, progressMs: 400 }, { workstreams: { renewSeconds: 1 }, open: { limits } })
  // The caller's turn runs while its call waits, as when its agent calls `delegate`.
  assert.equal((await lab.write(ws, '/sleep 5')).accepted, true)
  const prompt = Date.parse(lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!.time)
  let progress = 0
  const answer = (await (await client(t, url, execution)).callTool(
    { name: 'delegate', arguments: { instructions: 'nobody answers', harness: 'mock', rights: ['internet'] } },
    undefined,
    { onprogress: () => progress++, timeout: 10_000 },
  )) as Text
  assert.deepEqual([answer.isError, text(answer)], [true, 'expired'])
  assert.ok(progress >= 3, `${String(progress)} progress notifications`)
  const [approval] = await elements(lab, ws, 'question')
  assert.equal(approval?.status, 'expired')
  await lab.turn(ws, 'done', 20_000)
  // Its deadline, at most turn start + maximum duration, moved on by the approval's 2 s.
  const claim = (await lab.state(ws)).current!.claimName
  const beyond = lab.kube.deadlines.filter((d) => d.name === claim).map((d) => Date.parse(d.shutdownTime) - prompt - limits.turnCapSeconds * 1000)
  assert.ok(beyond.some((ms) => ms >= 1_800 && ms < 3_000), `beyond the cap: ${beyond.join(', ')} ms`)
})

test('D9 another call needing approval while one waits: approval_pending', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const first = c.callTool({ name: 'delegate', arguments: { instructions: 'first', harness: 'mock', rights: ['internet'] } })
  await until('the approval', async () => (await lab.state(ws)).question)
  const second = (await (await client(t, url, execution)).callTool({ name: 'delegate', arguments: { instructions: 'second', harness: 'mock', rights: ['internet'] } })) as Text
  assert.deepEqual([second.isError, text(second)], [true, 'approval_pending'])
  assert.equal(text(await first), 'expired')
})

test('D10 output_schema; the delegate submits a mismatch, then a fit: a tool error naming it, then submitted; the report carries the result', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const schema = { type: 'object', properties: { verdict: { type: 'string', enum: ['ship', 'fix'] } }, required: ['verdict'], additionalProperties: false }
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'delegate', arguments: { instructions: '/sleep 4', harness: 'mock', output_schema: schema } })))
  const running = await until('the delegate working', async () => {
    const state = await lab.state(delegate)
    return state.active ? state.current : null
  })
  assert.deepEqual(running.profiles, ['agora:submit'])
  const d = await client(t, url, running.id)
  const listed = (await d.listTools()).tools
  assert.deepEqual(listed.map((tool) => [tool.name, tool.inputSchema]), [['submit', schema]])
  const wrong = (await d.callTool({ name: 'submit', arguments: { verdict: 'maybe' } })) as Text
  assert.equal(wrong.isError, true)
  assert.match(text(wrong), /^invalid_result: \/verdict must be equal to one of the allowed values/)
  assert.equal(text(await d.callTool({ name: 'submit', arguments: { verdict: 'ship' } })), 'submitted')
  const [report] = await until('the report', async () => ((await reportsOf(lab, ws)).length > 0 ? reportsOf(lab, ws) : null), 20_000)
  assert.match(String(report?.text), /completed, result: \{"verdict":"ship"\}/)
})

test('D11 a delegate asked for a result ends without one: reminded once; then completed with no result', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'delegate', arguments: { instructions: 'forgetful', harness: 'mock', output_schema: schema } })))
  const [report] = await until('the report', async () => ((await reportsOf(lab, ws)).length > 0 ? reportsOf(lab, ws) : null), 20_000)
  const reminders = await elements(lab, delegate, 'report')
  assert.equal(reminders.length, 1)
  assert.match(String(reminders[0]?.text), /you were asked for a result: call submit with it/)
  assert.match(String(report?.text), /completed with no result, its last message: Echo #2/)
})

test('D12 to a delegate whose turn runs; whose turn ended; whose execution ended: delegate_busy; written; continued, then written', async (t) => {
  const { lab, url, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'delegate', arguments: { instructions: '/sleep 3', harness: 'mock' } })))
  await until('the delegate working', async () => (await lab.state(delegate)).active)
  const busy = (await c.callTool({ name: 'delegate', arguments: { to: delegate, instructions: 'next' } })) as Text
  assert.deepEqual([busy.isError, text(busy)], [true, 'delegate_busy'])
  await lab.turn(delegate, 'done', 20_000)
  assert.equal(text(await c.callTool({ name: 'delegate', arguments: { to: delegate, instructions: 'next' } })), `started ${delegate} · next`)
  await until('the next turn', async () => [...(await lab.state(delegate)).turns.values()].length === 2 && (await lab.turn(delegate, 'done')))
  const e = (await lab.state(delegate)).current!
  assert.equal((await lab.command(delegate, 'Stop', { execution: e.id })).accepted, true)
  await expire(lab.kube, e.claimName)
  await until('ended', async () => (await lab.state(delegate)).current?.ended, 30_000)
  assert.equal(text(await c.callTool({ name: 'delegate', arguments: { to: delegate, instructions: 'after the end' } })), `started ${delegate} · after the end`)
  await until('continued and written', async () => {
    const state = await lab.state(delegate)
    return state.executions.size === 2 && [...state.turns.values()].length === 3 && [...state.turns.values()].at(-1)?.status === 'done'
  }, 30_000)
})

test('D13 the caller’s execution ended before the report: continued, then the report written', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'delegate', arguments: { instructions: '/sleep 3', harness: 'mock' } })))
  assert.equal((await lab.command(ws, 'Stop', { execution })).accepted, true)
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the caller ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  await lab.turn(delegate, 'done', 20_000)
  const [report] = await until('the report', async () => ((await reportsOf(lab, ws)).length > 0 ? reportsOf(lab, ws) : null), 40_000)
  assert.deepEqual(report?.delegates, [delegate])
  assert.equal((await lab.state(ws)).executions.size, 2)
})

test('D14 a restart with an outcome not yet reported: a fresh engine on the same log reports it, once', async (t) => {
  const { lab, url, ws, execution, delegations } = await started(t, ['agora:delegate'], { manual: true })
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'delegate', arguments: { instructions: 'before the restart', harness: 'mock' } })))
  await answered(lab, delegations, delegate)
  // Another engine, as after a restart: what it knows, it reads from the log.
  const fresh = new Delegations(lab.workstreams, { manual: true })
  await fresh.start()
  await fresh.tick(true)
  await until('the report', async () => ((await reportsOf(lab, ws)).length > 0 ? true : null))
  await lab.turn(ws, 'done')
  await fresh.tick(true)
  await delegations.tick(true)
  assert.equal((await reportsOf(lab, ws)).length, 1)
  assert.equal((await kinds(lab, delegate, 'delegation.reported')).length, 1)
})

test('C65 a Create, then a Scope, naming agora:submit; a delegate asked for a result: unknown_profile both times; the delegate’s execution holds it, given by Agora', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const other = await lab.workstream()
  assert.deepEqual(await lab.command(other, 'Create', {}, { pool: 'mock-test', profiles: ['agora:submit'] }), { accepted: false, reason: 'unknown_profile' })
  assert.deepEqual(await lab.command(ws, 'Scope', { execution }, { profiles: ['agora:delegate', 'agora:submit'] }), { accepted: false, reason: 'unknown_profile' })
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'delegate', arguments: { instructions: 'typed', harness: 'mock', output_schema: schema } })))
  assert.deepEqual((await lab.state(delegate)).current?.profiles, ['agora:submit'])
})

test('S12 a delegate’s transcript, its caller’s instructions then a report in its caller’s: `caller`, its lines found as the person’s; `agora`, its lines of kind agora, never found', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:read', 'agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'delegate', arguments: { instructions: 'count the quokkas', harness: 'mock' } })))
  await until('the report', async () => ((await reportsOf(lab, ws)).length > 0 ? true : null))
  await lab.turn(ws, 'done')
  const header = (who: string) => new RegExp(`^## \\d+ · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d · ${who}$`)
  const theirs = text(await c.callTool({ name: 'read', arguments: { workstream: delegate } })).split('\n')
  assert.match(theirs[0]!.split('\t')[1]!, header('caller'))
  assert.equal(theirs[1], '2\tcount the quokkas')
  const transcript = (await db.admin.query('SELECT line, kind, text FROM transcript(ARRAY[$1]::uuid[]) ORDER BY line', [ws])).rows as { line: string; kind: string; text: string }[]
  const at = transcript.findIndex((l) => header('agora').test(l.text))
  assert.ok(at >= 0, transcript.map((l) => l.text).join('\n'))
  const report = transcript.slice(at + 1, transcript.findIndex((l, i) => i > at && l.kind === 'header'))
  assert.ok(report.length > 0 && report.every((l) => l.kind === 'agora'), JSON.stringify(report))
  assert.match(report[0]!.text, /^From Agora, not the person:$/)
  // The delegate's lines are found as the person's are; the report's never — the caller's agent's echo of it is its own.
  const hits = text(await c.callTool({ name: 'search', arguments: { pattern: 'quokkas', output_mode: 'content' } }))
    .split('\n')
    .map((l) => /^([0-9a-f-]{36}):(\d+):/.exec(l))
    .filter((m) => m !== null)
    .map((m) => ({ workstream: m[1], line: Number(m[2]) }))
  assert.ok(hits.some((h) => h.workstream === delegate && h.line === 2), JSON.stringify(hits))
  const reported = new Set(report.map((l) => Number(l.line)))
  assert.deepEqual(hits.filter((h) => h.workstream === ws && reported.has(h.line)), [])
})

test('L99 a delegate through its turn, then continued with `to`; its caller: its view’s and its row’s delegation working, completed, working, completed; none in its caller’s', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const view = async (id: string) => (await lab.workstreams.projections.objects(id)).find((o) => o.kind === 'workstream')?.object
  const row = async (id: string) => (await db.admin.query('SELECT row FROM listings WHERE workstream=$1', [id])).rows[0]?.row as Record<string, unknown> | undefined
  const both = (id: string, state: string) => async () => (await view(id))?.delegation === state && (await row(id))?.delegation === state
  const delegate = delegateOf(text(await c.callTool({ name: 'delegate', arguments: { instructions: '/sleep 2', harness: 'mock' } })))
  await until('working', both(delegate, 'working'))
  await until('completed', both(delegate, 'completed'), 20_000)
  assert.equal(text(await c.callTool({ name: 'delegate', arguments: { to: delegate, instructions: '/sleep 2' } })), `started ${delegate} · /sleep 2`)
  await until('working again', both(delegate, 'working'))
  await until('completed again', both(delegate, 'completed'), 20_000)
  assert.equal((await view(ws))?.delegation, undefined)
  assert.equal((await row(ws))?.delegation, undefined)
})

test('M10 tools/list with agora:delegate; from a delegate asked for a result, with agora:submit alone: delegate; submit alone, the schema its input', async (t) => {
  const { lab, url, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const [tool] = (await c.listTools()).tools
  assert.deepEqual([tool?.name, tool?.annotations?.readOnlyHint, Object.keys(tool?.inputSchema.properties ?? {})], [
    'delegate',
    undefined,
    ['instructions', 'harness', 'model', 'effort', 'rights', 'output_schema', 'to'],
  ])
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
  const delegate = delegateOf(text(await c.callTool({ name: 'delegate', arguments: { instructions: '/sleep 3', harness: 'mock', output_schema: schema } })))
  const running = await until('the delegate working', async () => ((await lab.state(delegate)).active ? (await lab.state(delegate)).current : null))
  assert.deepEqual((await (await client(t, url, running.id)).listTools()).tools.map((x) => [x.name, x.inputSchema]), [['submit', schema]])
})

test('M11 a delegate call Agora holds: an SSE stream, progress then the answer; another message, one JSON answer', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], { approvalMs: 1_500, progressMs: 300 })
  const post = (body: unknown) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [CALLER_HEADER]: `agora ${execution}` }, body: JSON.stringify(body) })
  const listed = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  assert.match(String(listed.headers.get('content-type')), /application\/json/)
  const held = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate', arguments: { instructions: 'held', harness: 'mock', rights: ['internet'] }, _meta: { progressToken: 7 } } })
  assert.match(String(held.headers.get('content-type')), /text\/event-stream/)
  const events = (await held.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)) as { method?: string; id?: number; result?: unknown })
  assert.ok(events.filter((e) => e.method === 'notifications/progress').length >= 3)
  assert.equal(events.at(-1)?.id, 2)
  assert.equal(((await elements(lab, ws, 'question'))[0])?.status, 'expired')
})
