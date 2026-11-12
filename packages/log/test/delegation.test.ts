// Delegation (docs/specs/delegation.md), on the lab: the caller's MCP calls made as its harness makes them — the SDK's
// client, the execution named as the gateway names it —, the delegates run by the mock agent, what comes back by itself
// written by Agora's engine. Approvals live seconds here, not 4 min 30 s.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { keys, mockBridge } from '@agora/testkit'
import { exchangesOf } from '../src/catch-up.ts'
import { join } from 'node:path'
import { CALLER_HEADER, createMcpServer, delegationOf, Delegations, loadRoles, object, parseRole, type Entry, type Role } from '../src/index.ts'
import { database, expire, FakeKube, grants, Lab, lines, sleep, until, type LabOptions } from './support.ts'

type Text = { content: { type: string; text: string }[]; isError?: boolean }
type T = { after(fn: () => Promise<void>): void }

async function started(
  t: T,
  profiles: string[],
  options: { approvalMs?: number; progressMs?: number; manual?: boolean; roles?: ReadonlyMap<string, Role> } = {},
  extra: { workstreams?: LabOptions['workstreams']; open?: Record<string, unknown>; noSteering?: boolean; kube?: (kube: FakeKube) => void } = {},
) {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  if (extra.noSteering) kube.bridgeFactory = (publicKey, pod) => mockBridge(publicKey, pod, { noSteering: true })
  extra.kube?.(kube)
  const db = await database()
  const lab = await Lab.start({ db, kube, keys: pair, credentials: grants([]).source, workstreams: { maxActive: 8, ...extra.workstreams }, delegations: { approvalMs: 3_000, progressMs: 500, ...options } })
  const mcp = createMcpServer(lab.workstreams)
  await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${String((mcp.address() as AddressInfo).port)}/mcp`
  // The Lab in `lab` when the test ends is closed: a test that restarts Agora puts the new one there.
  const context = { lab, db, url, ws: '', execution: '', delegations: lab.workstreams.delegations! }
  t.after(async () => {
    await new Promise((resolve) => mcp.close(resolve))
    await context.lab.close()
    await db.drop()
  })
  context.ws = await lab.workstream()
  context.execution = (await lab.open(context.ws, { profiles, ...extra.open })).id
  return context
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
/** The elements of a type once one `ok` accepts is projected: the log's fold, which `lab.state` reads, runs ahead of the projector. */
const projected = (lab: Lab, ws: string, type: string, ok: (o: Record<string, unknown>) => boolean = () => true) =>
  until(`a ${type} projected`, async () => {
    const found = await elements(lab, ws, type)
    return found.some(ok) ? found : null
  })
const kinds = async (lab: Lab, ws: string, kind: string) => (await lab.entries(ws)).filter((e) => e.kind === kind)
const prompts = async (lab: Lab, ws: string) => lines(await lab.entries(ws), 'out', 'session/prompt').filter((x) => x.rpc_kind === 'request')
const steerings = async (lab: Lab, ws: string) => lines(await lab.entries(ws), 'out', '_session/steering').filter((x) => x.rpc_kind === 'request')
const blocksOf = (line: Entry) => object(line.content.params)?.prompt as { text: string; _meta?: Record<string, unknown> }[]
const wordsOf = (o: Record<string, unknown>) => (o.content as { text: string }[]).map((b) => b.text).join('\n')
/** The last Write of a Workstream, as it was answered. */
const lastAnswer = async (lab: Lab, db: { admin: { query(sql: string, values: unknown[]): Promise<{ rows: unknown[] }> } }, ws: string) => {
  const write = (await kinds(lab, ws, 'command')).filter((x) => x.content.kind === 'Write').at(-1)!
  return ((await db.admin.query('SELECT answer FROM commands WHERE workstream=$1 AND id=$2', [ws, write.command])).rows[0] as { answer: Record<string, unknown> }).answer
}
/** A delegate's execution, once it runs a turn: what its harness calls Agora's MCP server as. */
const working = (lab: Lab, delegate: string) =>
  until('the delegate working', async () => {
    const state = await lab.state(delegate)
    return state.active?.status === 'in_progress' ? state.current : null
  })
/** The messages of another's that reached a Workstream, as projected: the `user` elements with a writer. */
const fromOthers = async (lab: Lab, ws: string) => (await elements(lab, ws, 'user')).filter((u) => u.as !== undefined)
const manyFromOthers = (lab: Lab, ws: string, count: number, timeoutMs = 15_000) =>
  until(`${String(count)} messages from others`, async () => {
    const found = await fromOthers(lab, ws)
    return found.length >= count ? found : null
  }, timeoutMs)

test('D1 spawn_agent within the delegator’s rights: started at once; a sub-stream one level down, on the pool named, the instructions its first message, marked as its delegator’s', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:delegate'])
  const answer = text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: 'hello delegate', harness: 'mock' } }))
  const delegate = delegateOf(answer)
  assert.equal(answer, `started ${delegate} · hello delegate`)
  const row = (await db.admin.query('SELECT parent, depth FROM workstreams WHERE id=$1', [delegate])).rows[0] as { parent: string; depth: number }
  assert.deepEqual([row.parent, row.depth], [ws, 1])
  await lab.turn(delegate, 'done')
  const [user] = await projected(lab, delegate, 'user')
  assert.deepEqual([user?.from, user?.as], [ws, 'delegator'])
  assert.equal(wordsOf(user!), 'hello delegate')
  assert.equal((await lab.state(delegate)).current?.body.pool, 'mock-test')
  const [line, words] = blocksOf((await prompts(lab, delegate))[0]!)
  assert.equal(line!.text, `From your delegator ${ws}, an agent, not the person. It receives your last message:`)
  assert.equal(words!.text, 'hello delegate')
})

test('D5 a delegator at depth 3; a delegator with three delegates working: depth_exceeded; too_many_delegates; no Workstream created', async (t) => {
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
  const refusedDeep = (await (await client(t, url, e.id)).callTool({ name: 'spawn_agent', arguments: { instructions: 'too deep', harness: 'mock' } })) as Text
  assert.deepEqual([refusedDeep.isError, text(refusedDeep)], [true, 'depth_exceeded'])
  const c = await client(t, url, execution)
  for (const n of [1, 2, 3]) delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: `/sleep 10 ${String(n)}`, harness: 'mock' } })))
  const fourth = (await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'a fourth', harness: 'mock' } })) as Text
  assert.deepEqual([fourth.isError, text(fourth)], [true, 'too_many_delegates'])
  assert.equal(await count(), before + 3)
})

test('D5 four calls at once: three started, one too_many_delegates; three Workstreams', async (t) => {
  const { db, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const answers = (await Promise.all([1, 2, 3, 4].map((n) => c.callTool({ name: 'spawn_agent', arguments: { instructions: `/sleep 10 ${String(n)}`, harness: 'mock' } })))) as Text[]
  assert.deepEqual(answers.map((a) => a.isError === true).sort(), [false, false, false, true])
  assert.equal(text(answers.find((a) => a.isError)), 'too_many_delegates')
  assert.equal(Number((await db.admin.query('SELECT count(*) FROM workstreams WHERE parent=$1', [ws])).rows[0].count), 3)
})

test('D6 rights beyond the delegator’s, then Approve: the call held, an approval in the delegator’s Workstream with one option; started once approved', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const call = (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: 'needs the internet', harness: 'mock', rights: ['internet'] } })
  const ask = await until('the approval', async () => (await lab.state(ws)).question)
  const [approval] = await projected(lab, ws, 'question')
  assert.deepEqual([approval?.kind, approval?.status, (approval?.options as unknown[]).length], ['approval', 'pending', 1])
  assert.match(String(approval?.text), /Rights beyond the caller's: `internet`/)
  assert.equal((await lab.command(ws, 'Answer', { question: ask.position }, { optionId: 'approve' })).accepted, true)
  const delegate = delegateOf(text(await call))
  assert.deepEqual((await lab.state(delegate)).current?.profiles, ['internet', 'agora:submit'])
})

test('D7 the person writes while the approval waits: refused with the words; no prompt sent; no delegate', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:delegate'])
  const call = (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: 'needs the internet', harness: 'mock', rights: ['internet'] } })
  await until('the approval', async () => (await lab.state(ws)).question)
  const turns = (await lab.state(ws)).turns.size
  assert.equal((await lab.write(ws, 'use the read-only rights')).accepted, true)
  const answer = (await call) as Text
  assert.deepEqual([answer.isError, text(answer)], [true, 'refused: use the read-only rights'])
  assert.equal((await lab.state(ws)).turns.size, turns, 'no prompt')
  const [approval] = await projected(lab, ws, 'question', (q) => q.status !== 'pending')
  assert.deepEqual([approval?.status, (approval?.answer as { note: string }).note], ['refused', 'use the read-only rights'])
  assert.equal(Number((await db.admin.query('SELECT count(*) FROM workstreams WHERE parent=$1', [ws])).rows[0].count), 0)
})

test('D8 no answer: expired at the approval’s end; progress meanwhile; the delegator’s turn deadline pushed back by the wait', async (t) => {
  const limits = { leaseSeconds: 60, turnCapSeconds: 30 }
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], { approvalMs: 2_000, progressMs: 400 }, { workstreams: { renewSeconds: 1 }, open: { limits } })
  // Its turn runs while its call waits, as when its agent calls `delegate`.
  assert.equal((await lab.write(ws, '/sleep 5')).accepted, true)
  const prompt = Date.parse(lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!.time)
  let progress = 0
  const answer = (await (await client(t, url, execution)).callTool(
    { name: 'spawn_agent', arguments: { instructions: 'nobody answers', harness: 'mock', rights: ['internet'] } },
    undefined,
    { onprogress: () => progress++, timeout: 10_000 },
  )) as Text
  assert.deepEqual([answer.isError, text(answer)], [true, 'expired'])
  assert.ok(progress >= 3, `${String(progress)} progress notifications`)
  const [approval] = await projected(lab, ws, 'question', (q) => q.status !== 'pending')
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
  const first = c.callTool({ name: 'spawn_agent', arguments: { instructions: 'first', harness: 'mock', rights: ['internet'] } })
  await until('the approval', async () => (await lab.state(ws)).question)
  const second = (await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: 'second', harness: 'mock', rights: ['internet'] } })) as Text
  assert.deepEqual([second.isError, text(second)], [true, 'approval_pending'])
  assert.equal(text(await first), 'expired')
})

test('D17 a restart while an approval waits, in a delegator with no delegate yet: the approval marked expired at start', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], { approvalMs: 5_000 })
  const call = (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: 'never asked again', harness: 'mock', rights: ['internet'] } })
  // Projected, as a server's start projects the Workstreams it recovers before the engine looks.
  await projected(lab, ws, 'question', (q) => q.status === 'pending')
  // Another engine, as after a restart: the call that held the approval is gone with the one before.
  await new Delegations(lab.workstreams, { manual: true }).start()
  const [approval] = await elements(lab, ws, 'question')
  assert.equal(approval?.status, 'expired')
  assert.equal((await kinds(lab, ws, 'question.expired')).length, 1)
  assert.equal((await lab.state(ws)).question, null)
  // The call before, its engine's clock aside: answered expired, the fact not written twice.
  assert.equal(text(await call), 'expired')
  assert.equal((await kinds(lab, ws, 'question.expired')).length, 1)
})

test('D18 a delegate’s send_message to parent, its delegator free: sent; a turn of the delegator’s, its prompt Agora’s line then the words; its user element from the delegate, without the line', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 2', harness: 'mock' } })))
  const e = await working(lab, delegate)
  assert.equal(text(await (await client(t, url, e.id)).callTool({ name: 'send_message', arguments: { to: 'parent', message: 'the words' } })), 'sent')
  await lab.turn(ws, 'done')
  const [line, words] = blocksOf((await prompts(lab, ws))[0]!)
  assert.equal(line!.text, `From your delegate ${delegate} "/sleep 2", not the person:`)
  assert.equal(words!.text, 'the words')
  const [user] = await manyFromOthers(lab, ws, 1)
  assert.deepEqual([user?.from, user?.as, wordsOf(user!)], [delegate, 'delegate', 'the words'])
})

test('D19 a delegate’s last message of 100,000 characters: the delegator’s prompt holds them all', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/words 100001', harness: 'mock' } })))
  const message = 'word '.repeat(20_001).slice(0, 100_001)
  await until('its prompt', async () => (await prompts(lab, ws)).length === 1, 20_000)
  assert.equal(blocksOf((await prompts(lab, ws))[0]!)[1]!.text, message)
})

test('D20 two delegates’ send_message to parent, then another from the first, into the delegator’s running turn: sent each time; a steering line each, in order; three steered elements, each from its delegate; no second turn', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  assert.equal((await lab.write(ws, '/sleep 7')).accepted, true)
  await lab.turn(ws, 'in_progress')
  const one = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 20', harness: 'mock' } })))
  const two = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 20', harness: 'mock' } })))
  const [a, b] = [await client(t, url, (await working(lab, one)).id), await client(t, url, (await working(lab, two)).id)]
  for (const [d, message] of [[a, 'first'], [b, 'second'], [a, 'third']] as const) {
    assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message } })), 'sent')
    await sleep(100)
  }
  await lab.turn(ws, 'done', 20_000)
  const sent = await steerings(lab, ws)
  assert.deepEqual(sent.map((x) => blocksOf(x)[1]!.text), ['first', 'second', 'third'])
  assert.equal((await prompts(lab, ws)).length, 1)
  const users = (await manyFromOthers(lab, ws, 3)).sort((x, y) => (BigInt(String(x.firstPosition)) < BigInt(String(y.firstPosition)) ? -1 : 1))
  assert.deepEqual(users.map((u) => [u.from, u.as, u.steered, wordsOf(u)]), [
    [one, 'delegate', true, 'first'],
    [two, 'delegate', true, 'second'],
    [one, 'delegate', true, 'third'],
  ])
})

test('D30 the same, its agent not taking them: sent each time; no turn until that one ends; then three turns, one each, in the order sent', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], {}, { noSteering: true })
  const c = await client(t, url, execution)
  assert.equal((await lab.write(ws, '/sleep 7')).accepted, true)
  await lab.turn(ws, 'in_progress')
  const one = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 20', harness: 'mock' } })))
  const two = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 20', harness: 'mock' } })))
  const [a, b] = [await client(t, url, (await working(lab, one)).id), await client(t, url, (await working(lab, two)).id)]
  for (const [d, message] of [[a, 'first'], [b, 'second'], [a, 'third']] as const) assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message } })), 'sent')
  assert.equal((await prompts(lab, ws)).length, 1, 'no turn until that one ends')
  await until('its three turns', async () => (await prompts(lab, ws)).length === 4, 20_000)
  assert.deepEqual((await prompts(lab, ws)).slice(1).map((x) => blocksOf(x)[1]!.text), ['first', 'second', 'third'])
  assert.equal((await steerings(lab, ws)).length, 0)
})

test('D21 send_message to a delegate whose turn runs; whose last turn is done; whose execution has ended: sent each time; into that turn; written at once; its execution continued, then written', async (t) => {
  const { lab, url, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 3', harness: 'mock' } })))
  await working(lab, delegate)
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: 'also this' } })), new RegExp(`^sent ${delegate} · `))
  await lab.turn(delegate, 'done', 20_000)
  assert.deepEqual((await steerings(lab, delegate)).map((x) => blocksOf(x)[1]!.text), ['also this'])
  assert.equal((await prompts(lab, delegate)).length, 1)
  // Its last turn done: at once, a turn.
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: 'next' } })), /^sent /)
  await until('the next turn', async () => (await prompts(lab, delegate)).length === 2)
  assert.equal(blocksOf((await prompts(lab, delegate))[1]!)[1]!.text, 'next')
  await until('it done', async () => [...(await lab.state(delegate)).turns.values()].every((x) => x.status === 'done'))
  // Its execution ended, at its deadline: continued, then written.
  await expire(lab.kube, (await lab.state(delegate)).current!.claimName)
  await until('ended', async () => (await lab.state(delegate)).current?.ended, 30_000)
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: 'after the end' } })), /^sent /)
  await until('continued and written', async () => {
    const state = await lab.state(delegate)
    return state.executions.size === 2 && state.turns.size === 3 && [...state.turns.values()].at(-1)?.status === 'done'
  }, 30_000)
})

test('D22 a delegate’s message to a delegator whose execution has ended: continued, then a turn', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 4', harness: 'mock' } })))
  const e = await working(lab, delegate)
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the delegator ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  assert.equal(text(await (await client(t, url, e.id)).callTool({ name: 'send_message', arguments: { to: 'parent', message: 'to one ended' } })), 'sent')
  await until('continued, then a turn', async () => {
    const state = await lab.state(ws)
    return state.executions.size === 2 && [...state.turns.values()].at(-1)?.status === 'done'
  }, 30_000)
  assert.equal(blocksOf((await prompts(lab, ws)).at(-1)!).at(-1)!.text, 'to one ended')
})

test('D22 a delegate’s message to a delegator the person stopped: waiting, no Create, until the person’s next one', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 4', harness: 'mock' } })))
  const e = await working(lab, delegate)
  assert.ok((await lab.command(ws, 'Stop', { execution })).accepted)
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the delegator ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  assert.equal(text(await (await client(t, url, e.id)).callTool({ name: 'send_message', arguments: { to: 'parent', message: 'to one stopped' } })), 'sent')
  await sleep(1500)
  let state = await lab.state(ws)
  assert.deepEqual([state.executions.size, state.waiting.length], [1, 1])
  // The person's next one: the message goes.
  await lab.open(ws)
  await until('its turn', async () => (await prompts(lab, ws)).some((x) => blocksOf(x).at(-1)!.text === 'to one stopped'), 20_000)
  state = await lab.state(ws)
  assert.deepEqual([state.executions.size, state.waiting.length], [2, 0])
})

test('D23 send_message to a delegate the person stopped; to a Workstream that is not the caller’s delegate: delegate_stopped; not_a_delegate', async (t) => {
  const { lab, url, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'short', harness: 'mock' } })))
  await lab.turn(delegate, 'done')
  assert.ok((await lab.command(delegate, 'Stop', { execution: (await lab.state(delegate)).current!.id })).accepted)
  const stopped = (await c.callTool({ name: 'send_message', arguments: { to: delegate, message: 'again' } })) as Text
  assert.deepEqual([stopped.isError, text(stopped)], [true, 'delegate_stopped'])
  const other = await lab.workstream()
  const foreign = (await c.callTool({ name: 'send_message', arguments: { to: other, message: 'hello' } })) as Text
  assert.deepEqual([foreign.isError, text(foreign)], [true, 'not_a_delegate'])
  const notAnId = (await c.callTool({ name: 'send_message', arguments: { to: 'not an id', message: 'hello' } })) as Text
  assert.deepEqual([notAnId.isError, text(notAnId)], [true, 'not_a_delegate'])
})

test('D26 a delegate’s turn done; one with a send_message to parent in it; the person’s; the person’s with a send_message sent into it; with no message: its last message whole; that message, then its last; nothing; its last message; a message of Agora’s', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const inOrder = (found: Record<string, unknown>[]) => found.sort((x, y) => (BigInt(String(x.firstPosition)) < BigInt(String(y.firstPosition)) ? -1 : 1))
  // Its delegator started it: its last message, whole.
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'plain', harness: 'mock' } })))
  const [first] = await manyFromOthers(lab, ws, 1)
  assert.deepEqual([first?.from, first?.as, wordsOf(first!)], [delegate, 'delegate', 'Echo #1: plain.'])
  const free = () => until('the delegator and its delegate free', async () => (await lab.state(ws)).active === null && (await lab.state(delegate)).active === null && (await lab.state(ws)).waiting.length === 0)
  await free()
  // With a send_message to parent in it: that message, then its last message all the same.
  const e = (await lab.state(delegate)).current!
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: '/sleep 2' } })), /^sent /)
  await working(lab, delegate)
  assert.equal(text(await (await client(t, url, e.id)).callTool({ name: 'send_message', arguments: { to: 'parent', message: 'said before the end' } })), 'sent')
  await lab.turn(delegate, 'done', 20_000)
  const both = inOrder(await manyFromOthers(lab, ws, 3, 20_000)).slice(1)
  assert.deepEqual(both.map((u) => [u.from, u.as]), [[delegate, 'delegate'], [delegate, 'delegate']])
  assert.equal(wordsOf(both[0]!), 'said before the end')
  assert.match(wordsOf(both[1]!), /Slept 2 s\./)
  await free()
  await sleep(600)
  assert.equal((await fromOthers(lab, ws)).length, 3)
  // The person's own: nothing.
  assert.ok((await lab.write(delegate, 'from the person')).accepted)
  await until('its turn over', async () => (await lab.state(delegate)).turns.size === 3 && (await lab.state(delegate)).active === null)
  await sleep(600)
  assert.equal((await fromOthers(lab, ws)).length, 3)
  // The person's, a send_message sent into it: its last message.
  assert.ok((await lab.write(delegate, '/sleep 2')).accepted)
  await working(lab, delegate)
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: 'also this' } })), /^sent /)
  const last = inOrder(await manyFromOthers(lab, ws, 4, 20_000)).at(-1)!
  assert.match(wordsOf(last), /Slept 2 s\./)
  await free()
  // With no message: Agora says so.
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: '/raw ' } })), /^sent /)
  const [notice] = (await manyFromOthers(lab, ws, 5, 20_000)).filter((u) => u.as === 'agora')
  assert.equal(notice?.from, delegate)
  assert.equal(wordsOf(notice!), `Your delegate ${delegate} "plain": It ended its turn with nothing to say.`)
})

test('D27 a delegate’s turn fails: one message of Agora’s in its delegator’s Workstream', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/turn-error', harness: 'mock' } })))
  const [notice] = await manyFromOthers(lab, ws, 1)
  assert.deepEqual([notice?.from, notice?.as], [delegate, 'agora'])
  assert.equal(wordsOf(notice!), `Your delegate ${delegate} "/turn-error": Its turn failed: the model refused.`)
  assert.equal(blocksOf((await prompts(lab, ws))[0]!)[0]!.text, 'From Agora, not the person:')
  await sleep(600)
  assert.equal((await fromOthers(lab, ws)).length, 1)
})

test('D27 a delegate’s Session does not open: one message of Agora’s', async (t) => {
  let pods = 0
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], {}, {
    workstreams: { responseTimeoutMs: 1_000 },
    // The delegator's opens; its delegate's answers `initialize` with what the schema refuses.
    kube: (kube) => {
      kube.bridgeFactory = (publicKey, pod) => mockBridge(publicKey, pod, { initializeInvalid: pods++ > 0 })
    },
  })
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: 'never read', harness: 'mock' } })))
  const [notice] = await manyFromOthers(lab, ws, 1, 20_000)
  assert.deepEqual([notice?.from, notice?.as], [delegate, 'agora'])
  assert.match(wordsOf(notice!), /: Its execution could not start\.$/)
})

test('D27 a delegate’s execution is lost: one message of Agora’s', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/die 1', harness: 'mock' } })))
  const [notice] = await manyFromOthers(lab, ws, 1, 20_000)
  assert.deepEqual([notice?.from, notice?.as], [delegate, 'agora'])
  assert.match(wordsOf(notice!), /: Its execution was lost\.$/)
  await sleep(600)
  assert.equal((await fromOthers(lab, ws)).length, 1)
})

test('D27 the person stops a delegate; cancels the turn of another: one message of Agora’s each', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const one = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30', harness: 'mock' } })))
  const e = await working(lab, one)
  assert.ok((await lab.command(one, 'Stop', { execution: e.id })).accepted)
  const [stopped] = await manyFromOthers(lab, ws, 1, 20_000)
  assert.deepEqual([stopped?.from, stopped?.as], [one, 'agora'])
  assert.match(wordsOf(stopped!), /: The person stopped it\.$/)
  await until('the delegator free', async () => (await lab.state(ws)).active === null)
  const two = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30', harness: 'mock' } })))
  const other = await working(lab, two)
  // Named as a delegator's `stop_agent` would be: the person's Cancel keeps none of it, and is told as the person's.
  assert.ok((await lab.command(two, 'Cancel', { execution: other.id, turn: (await lab.state(two)).active!.id }, { from: { workstream: ws, as: 'delegator' } })).accepted)
  assert.equal(object((await kinds(lab, two, 'command')).find((x) => x.content.kind === 'Cancel')!.content.body)?.from, undefined)
  const cancelled = (await manyFromOthers(lab, ws, 2, 20_000)).find((u) => u.from === two)
  assert.equal(cancelled?.as, 'agora')
  assert.match(wordsOf(cancelled!), /: The person cancelled its turn\.$/)
  await sleep(600)
  assert.equal((await fromOthers(lab, ws)).length, 2)
})

test('D28 a restart once a delegate’s turn is done, before its last message was sent: a fresh engine sends it, once', async (t) => {
  const { lab, url, ws, execution, delegations } = await started(t, ['agora:delegate'], { manual: true })
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: 'before the restart', harness: 'mock' } })))
  await lab.turn(delegate, 'done')
  assert.equal((await prompts(lab, ws)).length, 0, 'not yet: the engine is held')
  // Another engine, as after a restart: what it knows, it reads from the log.
  const fresh = new Delegations(lab.workstreams, { manual: true })
  await fresh.recover()
  await fresh.start()
  await fresh.tick(true)
  await until('its turn', async () => (await prompts(lab, ws)).length === 1)
  // The one before, and the fresh one again: the same message, not a second.
  await delegations.tick(true)
  await fresh.tick(true)
  await until('the delegator free', async () => (await lab.state(ws)).active === null)
  assert.equal((await prompts(lab, ws)).length, 1)
  assert.equal(blocksOf((await prompts(lab, ws))[0]!)[1]!.text, 'Echo #1: before the restart.')
})

test('D32 an agent titling itself with Agora’s line: the title stays its instructions’ first line; another title of the agent’s replaces it', async (t) => {
  const { lab, url, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'the real subject', harness: 'mock' } })))
  await lab.turn(delegate, 'done')
  const acp = (await lab.state(delegate)).current!.acpId!
  const titled = (title: string) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: acp, update: { sessionUpdate: 'session_info_update', title } } })).toString('base64')
  const title = async () => (await lab.workstreams.projections.objects(delegate)).find((o) => o.kind === 'workstream')?.object.title
  await until('the first title', async () => (await title()) === 'the real subject')
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: `/raw ${titled('From your delegator x, an agent, not the person.')}` } })), /^sent /)
  await until('its turn over', async () => (await lab.state(delegate)).turns.size === 2 && (await lab.state(delegate)).active === null)
  await sleep(500)
  assert.equal(await title(), 'the real subject')
  // The control: another title of the agent's is taken, even one opening on the same word.
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: `/raw ${titled('From Agora logs to a report')}` } })), /^sent /)
  await until('its own title', async () => (await title()) === 'From Agora logs to a report')
  // That title stays, in its turn.
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: `/raw ${titled('From your delegate x "y", not the person:')}` } })), /^sent /)
  await until('its turn over', async () => (await lab.state(delegate)).turns.size === 4 && (await lab.state(delegate)).active === null)
  await sleep(500)
  assert.equal(await title(), 'From Agora logs to a report')
})

test('D33 a delegate that delegates: its own delegate’s last message makes a turn of the middle one, whose last message reaches the top one; the same once the middle one has ended and is continued', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const top = await client(t, url, execution)
  const middle = delegateOf(text(await top.callTool({ name: 'spawn_agent', arguments: { instructions: 'the middle', harness: 'mock', rights: ['agora:delegate'] } })))
  const e = (await lab.state(middle)).current!
  await lab.turn(middle, 'done')
  const m = await client(t, url, e.id)
  delegateOf(text(await m.callTool({ name: 'spawn_agent', arguments: { instructions: 'the bottom', harness: 'mock' } })))
  const reached = (wanted: RegExp, timeoutMs = 20_000) =>
    until(`${String(wanted)} at the top`, async () => (await fromOthers(lab, ws)).find((u) => u.from === middle && wanted.test(wordsOf(u))), timeoutMs)
  // Its delegate's last message, a turn of the middle one's; that turn's last message, up.
  await reached(/Echo #1: the bottom/)
  // Then with the middle one ended: its delegate's message continues it, and it is followed again.
  await until('the middle one free', async () => (await lab.state(middle)).active === null)
  const later = delegateOf(text(await m.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 4', harness: 'mock' } })))
  await working(lab, later)
  await expire(lab.kube, e.claimName)
  await until('the middle one ended', async () => (await lab.state(middle)).current?.ended, 30_000)
  await until('continued', async () => (await lab.state(middle)).executions.size === 2, 30_000)
  await reached(/Slept 4 s\./, 30_000)
})

test('D34 a restart with a message of Agora’s waiting, its Workstream’s execution ended: continued after the restart; the message sent once', async (t) => {
  const context = await started(t, ['agora:delegate'], {}, { kube: (k) => k.morePools.push(['only-pool', 'solo']), open: { pool: 'only-pool' } })
  const { lab, url, ws, execution } = context
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30', harness: 'mock' } })))
  const d = await client(t, url, (await working(lab, delegate)).id)
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the delegator ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  // Its pool and harness gone once the catalogue is read again: nothing to continue it with, the message waiting.
  lab.kube.morePools.length = 0
  await sleep(10_200)
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'across the restart' } })), 'sent')
  let state = await lab.state(ws)
  assert.deepEqual([state.waiting.length, state.executions.size], [1, 1])
  lab.kube.morePools.push(['only-pool', 'solo'])
  context.lab = await lab.restart('halt')
  await until('its turn', async () => (await prompts(context.lab, ws)).length === 1, 30_000)
  state = await context.lab.state(ws)
  assert.deepEqual([state.waiting.length, state.executions.size], [0, 2])
  assert.equal(blocksOf((await prompts(context.lab, ws))[0]!).at(-1)!.text, 'across the restart')
})

test('D35 a delegate’s execution ending while Agora is down: after the restart, one message of Agora’s in its delegator’s Workstream', async (t) => {
  const context = await started(t, ['agora:delegate'])
  const { lab, url, ws, execution } = context
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30', harness: 'mock' } })))
  const e = await working(lab, delegate)
  lab.workstreams.halt()
  await expire(lab.kube, e.claimName)
  await until('its claim gone', () => !lab.kube.claims.has(e.claimName))
  context.lab = await lab.restart('halt')
  await until('it ended', async () => (await context.lab.state(delegate)).current?.ended, 30_000)
  const [notice] = await manyFromOthers(context.lab, ws, 1, 30_000)
  assert.deepEqual([notice?.from, notice?.as], [delegate, 'agora'])
  assert.match(wordsOf(notice!), /Its turn failed/)
  await sleep(600)
  assert.equal((await fromOthers(context.lab, ws)).length, 1)
})

test('D36 a delegate of an earlier delegation at start: nothing written to its delegator; a later send_message followed as any', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], { manual: true })
  // As the engine before left it: its fact naming a `caller`, its prompts marked `delegation`, a turn that failed.
  const old = randomUUID()
  await lab.store.create(old, null, ws)
  await lab.open(old)
  await lab.workstreams.record(old, { kind: 'delegation.started', content: { caller: ws, callerExecution: execution, harness: 'mock', pool: 'mock-test', settings: {}, rights: [], instructions: 'old instructions' } })
  const e = (await lab.state(old)).current!
  for (const words of ['/turn-error', 'old words']) {
    const before = (await lab.state(old)).turns.size
    assert.ok((await lab.command(old, 'Write', { execution: e.id, session: e.session }, { prompt: [{ type: 'text', text: words, _meta: { 'agora.bretagne.dev/delegation': { caller: ws, step: '1' } } }] })).accepted)
    await until('its turn over', async () => (await lab.state(old)).turns.size === before + 1 && (await lab.state(old)).active === null)
  }
  const fresh = new Delegations(lab.workstreams, { manual: true })
  await fresh.recover()
  await fresh.start()
  await fresh.tick(true)
  await sleep(300)
  assert.deepEqual([(await kinds(lab, ws, 'command')).filter((x) => x.content.kind === 'Write').length, (await prompts(lab, ws)).length], [0, 0])
  // Its element reads as it did: `from` alone.
  const [user] = await projected(lab, old, 'user', (u) => wordsOf(u) === 'old words')
  assert.deepEqual([(user?.content as unknown[]).length >= 1, Object.hasOwn(user!, 'as')], [true, false])
  // A `to`: followed from there on.
  assert.match(text(await (await client(t, url, execution)).callTool({ name: 'send_message', arguments: { to: old, message: 'new words' } })), /^sent /)
  await until('its turn over', async () => (await lab.state(old)).turns.size === 3 && (await lab.state(old)).active === null)
  await fresh.tick(true)
  await until('its last message', async () => (await prompts(lab, ws)).length === 1)
  assert.match(blocksOf((await prompts(lab, ws))[0]!).at(-1)!.text, /new words/)
})

test('D37 a delegate that cannot start: one message of Agora’s; no further Create by itself; a send_message: one more', async (t) => {
  let pods = 0
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], {}, {
    workstreams: { responseTimeoutMs: 1_000 },
    kube: (kube) => {
      kube.bridgeFactory = (publicKey, pod) => mockBridge(publicKey, pod, { initializeInvalid: pods++ > 0 })
    },
  })
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'never read', harness: 'mock' } })))
  await manyFromOthers(lab, ws, 1, 20_000)
  await expire(lab.kube, (await lab.state(delegate)).current!.claimName)
  await until('it ended', async () => (await lab.state(delegate)).current?.ended, 30_000)
  const view = async () => (await lab.workstreams.projections.objects(delegate)).find((o) => o.kind === 'workstream')?.object
  await sleep(1_500)
  assert.deepEqual([(await lab.state(delegate)).executions.size, (await fromOthers(lab, ws)).length, (await view())?.delegation], [1, 1, 'failed'])
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: 'try again' } })), /^sent /)
  await until('one more', async () => (await lab.state(delegate)).executions.size === 2)
  await manyFromOthers(lab, ws, 2, 20_000)
  await expire(lab.kube, (await lab.state(delegate)).current!.claimName)
  await until('it ended again', async () => (await lab.state(delegate)).current?.ended, 30_000)
  await sleep(1_500)
  assert.equal((await lab.state(delegate)).executions.size, 2)
})

test('D37 a send_message while the execution that could not start still holds its claim: sent; one more Create once it ends', async (t) => {
  let pods = 0
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], {}, {
    workstreams: { responseTimeoutMs: 1_000 },
    kube: (kube) => {
      kube.bridgeFactory = (publicKey, pod) => mockBridge(publicKey, pod, { initializeInvalid: pods++ > 0 })
    },
  })
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'never read', harness: 'mock' } })))
  await manyFromOthers(lab, ws, 1, 20_000)
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: 'try again' } })), /^sent /)
  await sleep(500)
  assert.deepEqual([(await lab.state(delegate)).executions.size, (await lab.state(delegate)).current?.ended], [1, false])
  await expire(lab.kube, (await lab.state(delegate)).current!.claimName)
  await until('one more', async () => (await lab.state(delegate)).executions.size === 2, 30_000)
})

test('D38 a Cancel with a message of Agora’s waiting, then its execution’s end: no Create; the next message: a Create, then both, in order', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30', harness: 'mock' } })))
  const d = await client(t, url, (await working(lab, delegate)).id)
  assert.ok((await lab.write(ws, '/tool-open 30')).accepted)
  await until('the tool line', async () => (await lab.state(ws)).tools.size === 1)
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'the first' } })), 'sent')
  const turn = await lab.turn(ws, 'in_progress')
  assert.ok((await lab.command(ws, 'Cancel', { execution, turn: turn.id })).accepted)
  await lab.turn(ws, 'cancelled')
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the delegator ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  await sleep(1_500)
  assert.equal((await lab.state(ws)).executions.size, 1, 'no Create')
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'the second' } })), 'sent')
  await until('both', async () => (await prompts(lab, ws)).length === 3, 30_000)
  assert.deepEqual((await prompts(lab, ws)).slice(1).map((x) => blocksOf(x).at(-1)!.text), ['the first', 'the second'])
  assert.equal((await lab.state(ws)).executions.size, 2)
})

test('D39 a delegate continued with a catch-up, its anchor lost: its last message in its delegator’s Workstream, as any', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'first words', harness: 'mock' } })))
  await manyFromOthers(lab, ws, 1)
  await until('free', async () => (await lab.state(ws)).active === null && (await lab.state(delegate)).active === null)
  await expire(lab.kube, (await lab.state(delegate)).current!.claimName)
  await until('it ended', async () => (await lab.state(delegate)).current?.ended, 30_000)
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: 'second words' } })), /^sent /)
  await until('its second turn', async () => (await prompts(lab, delegate)).length === 2, 30_000)
  const blocks = blocksOf((await prompts(lab, delegate))[1]!)
  assert.match(String(blocks[0]!.text), /^<agora-catch-up>/, 'the catch-up first')
  const after = await manyFromOthers(lab, ws, 2, 20_000)
  assert.ok(after.some((u) => /second words/.test(wordsOf(u))), JSON.stringify(after.map(wordsOf)))
})

test('D40 a delegate whose Pod never starts, its execution ending with no failure recorded: one message of Agora’s; failed; no Create', async (t) => {
  let pods = 0
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], {}, {
    kube: (kube) => {
      kube.bridgeFactory = (publicKey, pod) => (pods++ > 0 ? new Promise(() => {}) : mockBridge(publicKey, pod))
    },
  })
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: 'never read', harness: 'mock' } })))
  await expire(lab.kube, (await lab.state(delegate)).current!.claimName)
  await until('it ended', async () => (await lab.state(delegate)).current?.ended, 30_000)
  const e = (await lab.state(delegate)).current!
  assert.deepEqual([e.failed ?? false, e.lost, e.session], [false, false, null], 'nothing says it failed but its end')
  const [notice] = await manyFromOthers(lab, ws, 1, 20_000)
  assert.deepEqual([notice?.from, notice?.as], [delegate, 'agora'])
  assert.match(wordsOf(notice!), /: Its execution could not start\.$/)
  await sleep(1_500)
  const state = await lab.state(delegate)
  assert.deepEqual([state.executions.size, delegationOf(state), (await fromOthers(lab, ws)).length], [1, 'failed', 1])
})

test('D41 the person cancels a delegate’s turn, a send_message waiting: cancelled; it counts no more among the three at once', async (t) => {
  const { lab, url, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/tool-open 30', harness: 'mock' } })))
  const e = await working(lab, delegate)
  await until('the tool line', async () => (await lab.state(delegate)).tools.size === 1)
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: 'behind the tool' } })), /^sent /)
  assert.ok((await lab.command(delegate, 'Cancel', { execution: e.id, turn: (await lab.state(delegate)).active!.id })).accepted)
  await lab.turn(delegate, 'cancelled')
  const state = await lab.state(delegate)
  assert.deepEqual([state.waiting.length, state.held, delegationOf(state)], [1, true, 'cancelled'])
  for (const n of [1, 2, 3]) delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: `/sleep 10 ${String(n)}`, harness: 'mock' } })))
})

test('D42 send_message naming a delegate in capitals: sent; its last message written once', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'first words', harness: 'mock' } })))
  await manyFromOthers(lab, ws, 1)
  const free = () => until('the delegator and its delegate free', async () => (await lab.state(ws)).active === null && (await lab.state(delegate)).active === null)
  await free()
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate.toUpperCase(), message: 'second words' } })), new RegExp(`^sent ${delegate} · `))
  await until('its second turn over', async () => (await lab.state(delegate)).turns.size === 2 && (await lab.state(delegate)).active === null)
  await manyFromOthers(lab, ws, 2)
  await free()
  await sleep(1_500)
  assert.equal((await fromOthers(lab, ws)).length, 2)
})

test('D43 a delegate whose Session opens and never takes its message, an opening setting never answered: no further Create by itself; a send_message: one more', async (t) => {
  let pods = 0
  const { lab, url, execution } = await started(t, ['agora:delegate'], {}, {
    kube: (kube) => {
      kube.bridgeFactory = (publicKey, pod) => mockBridge(publicKey, pod, { silentSettings: pods++ > 0 })
    },
  })
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'never read', harness: 'mock', model: 'mock-small' } })))
  await until('its Session', async () => (await lab.state(delegate)).current?.session, 20_000)
  await sleep(500)
  assert.deepEqual([(await prompts(lab, delegate)).length, (await lab.state(delegate)).waiting.length], [0, 1])
  await expire(lab.kube, (await lab.state(delegate)).current!.claimName)
  await until('it ended', async () => (await lab.state(delegate)).current?.ended, 30_000)
  await sleep(1_500)
  assert.equal((await lab.state(delegate)).executions.size, 1)
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: 'try again' } })), /^sent /)
  await until('one more', async () => (await lab.state(delegate)).executions.size === 2)
  await until('its Session', async () => (await lab.state(delegate)).current?.session, 20_000)
  await expire(lab.kube, (await lab.state(delegate)).current!.claimName)
  await until('it ended again', async () => (await lab.state(delegate)).current?.ended, 30_000)
  await sleep(1_500)
  assert.equal((await lab.state(delegate)).executions.size, 2)
})

test('D44 a message of Agora’s saying a delegate’s end, refused for a moment: written at the next beat, once', async (t) => {
  const { lab, url, ws, execution, delegations } = await started(t, ['agora:delegate'], { manual: true })
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/turn-error', harness: 'mock' } })))
  await lab.turn(delegate, 'failed')
  await expire(lab.kube, (await lab.state(delegate)).current!.claimName)
  await until('it ended', async () => (await lab.state(delegate)).current?.ended, 30_000)
  const { command } = lab.workstreams
  lab.workstreams.command = async () => ({ accepted: false, reason: 'unavailable' })
  await delegations.tick(true)
  lab.workstreams.command = command
  assert.equal((await kinds(lab, ws, 'command')).filter((x) => x.content.kind === 'Write').length, 0)
  await delegations.tick(true)
  await manyFromOthers(lab, ws, 1)
  await delegations.tick(true)
  await sleep(300)
  assert.equal((await fromOthers(lab, ws)).length, 1)
})

test('D45 ten send_message to a delegate, then an eleventh: too_many_exchanges, nothing written; its own to parent still goes; the person writing in either Workstream: ten more', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'first words', harness: 'mock' } })))
  const e = await until('its Session', async () => ((await lab.state(delegate)).current?.session ? (await lab.state(delegate)).current : null))
  const to = () => c.callTool({ name: 'send_message', arguments: { to: delegate, message: 'again' } }) as Promise<Text>
  const written = async () => (await kinds(lab, delegate, 'command')).filter((x) => x.content.kind === 'Write').length
  const tenThenRefused = async () => {
    for (let n = 0; n < 10; n++) assert.match(text(await to()), /^sent /)
    const before = await written()
    const refused = await to()
    assert.deepEqual([refused.isError, text(refused)], [true, 'too_many_exchanges: the person has to write first'])
    assert.equal(await written(), before, 'nothing written')
  }
  const say = async (w: string) => {
    const current = (await lab.state(w)).current!
    assert.ok((await lab.command(w, 'Write', { execution: current.id, session: current.session }, { prompt: [{ type: 'text', text: 'go on' }], mayWait: true })).accepted)
  }
  await tenThenRefused()
  assert.equal(text(await (await client(t, url, e.id)).callTool({ name: 'send_message', arguments: { to: 'parent', message: 'still heard' } })), 'sent')
  await say(ws)
  await tenThenRefused()
  await say(delegate)
  assert.match(text(await to()), /^sent /)
})

test('C66 the person, in a delegate: a Scope, then once its execution ended a Create, each keeping the agora:submit it holds: both accepted', async (t) => {
  const { lab, url, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: 'short', harness: 'mock' } })))
  await lab.turn(delegate, 'done')
  const e = (await lab.state(delegate)).current!
  assert.ok((await lab.command(delegate, 'Scope', { execution: e.id }, { profiles: ['agora:submit'] })).accepted)
  await expire(lab.kube, e.claimName)
  await until('it ended', async () => (await lab.state(delegate)).current?.ended, 30_000)
  assert.ok((await lab.command(delegate, 'Create', {}, { pool: 'mock-test', profiles: ['agora:submit'] })).accepted)
  assert.deepEqual((await lab.state(delegate)).current?.profiles, ['agora:submit'])
})

test('C65 a Create, then a Scope, naming agora:submit; a delegate: unknown_profile both times; the delegate’s execution holds it, given by Agora', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const other = await lab.workstream()
  assert.deepEqual(await lab.command(other, 'Create', {}, { pool: 'mock-test', profiles: ['agora:submit'] }), { accepted: false, reason: 'unknown_profile' })
  assert.deepEqual(await lab.command(ws, 'Scope', { execution }, { profiles: ['agora:delegate', 'agora:submit'] }), { accepted: false, reason: 'unknown_profile' })
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: 'any', harness: 'mock' } })))
  assert.deepEqual((await lab.state(delegate)).current?.profiles, ['agora:submit'])
})

test('S13 a delegate’s transcript, its delegator’s message first; its delegator’s, holding its messages, as its own turn and sent into a turn: who wrote in each header; Agora’s line in none; their lines of kind user, found', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:read', 'agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 5', harness: 'mock' } })))
  const d = await client(t, url, (await working(lab, delegate)).id)
  // As its own turn, the delegator free; then into a turn of the person's.
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'count the quokkas' } })), 'sent')
  await until('its turn over', async () => (await prompts(lab, ws)).length === 1 && (await lab.state(ws)).active === null)
  assert.equal((await lab.write(ws, '/sleep 2')).accepted, true)
  await lab.turn(ws, 'in_progress')
  await sleep(200)
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'count the wombats' } })), 'sent')
  await until('both projected', async () => (await fromOthers(lab, ws)).length === 2)
  await lab.turn(ws, 'done', 20_000)
  const transcript = async (id: string) => (await db.admin.query('SELECT line, kind, text FROM transcript(ARRAY[$1]::uuid[]) ORDER BY line', [id])).rows as { line: string; kind: string; text: string }[]
  const header = (who: string) => new RegExp(`^## \\d+ · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d · ${who}$`)
  const theirs = await transcript(delegate)
  assert.match(theirs[0]!.text, header('delegator'))
  assert.deepEqual([theirs[1]!.kind, theirs[1]!.text], ['user', '/sleep 5'])
  const ours = await until('the delegator’s lines', async () => {
    const found = await transcript(ws)
    return found.some((l) => l.text === 'count the wombats') && found
  })
  const own = ours.findIndex((l) => header('delegate').test(l.text))
  assert.ok(own >= 0, ours.map((l) => l.text).join('\n'))
  assert.deepEqual([ours[own + 1]!.kind, ours[own + 1]!.text], ['user', 'count the quokkas'])
  const into = ours.findIndex((l) => /^## \d+ · delegate, during the turn$/.test(l.text))
  assert.ok(into >= 0, ours.map((l) => l.text).join('\n'))
  assert.deepEqual([ours[into + 1]!.kind, ours[into + 1]!.text], ['user', 'count the wombats'])
  assert.ok(![...ours, ...theirs].some((l) => /^From your /.test(l.text)), 'Agora’s line in none')
  const hits = text(await c.callTool({ name: 'search', arguments: { pattern: 'wombats', output_mode: 'content' } }))
  assert.match(hits, new RegExp(`^${ws}:${String(ours[into + 1]!.line)}:count the wombats$`, 'm'))
})

test('L99 a delegate through its turn, then given another message with send_message; its delegator; a new Session of the delegate’s opening: its view’s and its row’s delegation working, idle, working, idle; none in its delegator’s; working', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const view = async (id: string) => (await lab.workstreams.projections.objects(id)).find((o) => o.kind === 'workstream')?.object
  const row = async (id: string) => (await db.admin.query('SELECT row FROM listings WHERE workstream=$1', [id])).rows[0]?.row as Record<string, unknown> | undefined
  const both = (id: string, state: string) => async () => (await view(id))?.delegation === state && (await row(id))?.delegation === state
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 2', harness: 'mock' } })))
  await until('working', both(delegate, 'working'))
  await until('idle', both(delegate, 'idle'), 20_000)
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: '/sleep 2' } })), /^sent /)
  await until('working again', both(delegate, 'working'))
  await until('idle again', both(delegate, 'idle'), 20_000)
  assert.equal((await view(ws))?.delegation, undefined)
  assert.equal((await row(ws))?.delegation, undefined)
  // Its Pod starting: `working`, whatever its last turn said.
  await expire(lab.kube, (await lab.state(delegate)).current!.claimName)
  await until('it ended', async () => (await lab.state(delegate)).current?.ended, 30_000)
  lab.kube.allocationDelayMs = 2_000
  assert.ok((await lab.command(delegate, 'Create', {}, { pool: 'mock-test', profiles: ['agora:submit'] })).accepted)
  assert.equal(delegationOf(await lab.state(delegate)), 'working')
})

test('L125 a Write of Agora’s before the Session opens: accepted, waiting; sent once it is open', async (t) => {
  const { lab, ws } = await started(t, [])
  const fresh = await lab.workstream()
  assert.ok((await lab.command(fresh, 'Create', {}, { pool: 'mock-test' })).accepted)
  const answer = await lab.workstreams.command(fresh, { id: randomUUID(), kind: 'Write', target: {}, body: { prompt: [{ type: 'text', text: 'From Agora', _meta: { 'agora.bretagne.dev/from': { workstream: ws, as: 'agora' } } }, { type: 'text', text: 'early words' }], mayWait: true } }, 'agora')
  assert.ok(answer.accepted)
  assert.equal(answer.waiting, true)
  await until('its turn', async () => (await prompts(lab, fresh)).length === 1)
  assert.equal(blocksOf((await prompts(lab, fresh))[0]!)[1]!.text, 'early words')
})

test('L125 a Write of Agora’s with the execution ended: accepted, waiting; a Create with its pool, settings, profiles and limits, then sent', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:delegate'], {}, { open: { settings: { model: 'mock-large' }, limits: { leaseSeconds: 90, turnCapSeconds: 600 } } })
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30', harness: 'mock' } })))
  const d = await client(t, url, (await working(lab, delegate)).id)
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the delegator ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  const before = (await lab.state(ws)).current!
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'after its end' } })), 'sent')
  assert.equal((await lastAnswer(lab, db, ws)).waiting, true)
  const next = await until('continued', async () => {
    const state = await lab.state(ws)
    return state.executions.size === 2 && state.current
  }, 30_000)
  assert.deepEqual([next.body.pool, next.body.settings, next.profiles, next.body.limits], [before.body.pool, before.body.settings, before.profiles, before.body.limits])
  assert.equal(String(object(next.body.limits)?.turnCapSeconds), '600')
  await until('sent', async () => (await prompts(lab, ws)).length === 1, 30_000)
  assert.equal(blocksOf((await prompts(lab, ws))[0]!).at(-1)!.text, 'after its end')
})

test('L125 a Write of Agora’s after a Stop: accepted, waiting; no Create, until the person’s next one', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30', harness: 'mock' } })))
  const d = await client(t, url, (await working(lab, delegate)).id)
  assert.ok((await lab.command(ws, 'Stop', { execution })).accepted)
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the delegator ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'after the Stop' } })), 'sent')
  assert.equal((await lastAnswer(lab, db, ws)).waiting, true)
  await sleep(1_500)
  assert.deepEqual([(await lab.state(ws)).executions.size, (await prompts(lab, ws)).length], [1, 0])
  await lab.open(ws)
  await until('sent', async () => (await prompts(lab, ws)).length === 1, 20_000)
  assert.equal((await lab.state(ws)).executions.size, 2)
})

test('L125 a Write of Agora’s with the execution ended, its pool gone: continued in a pool of its harness, its settings, profiles and limits', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:delegate'], {}, { kube: (k) => k.morePools.push(['mock-older', 'mock']), open: { pool: 'mock-older', limits: { leaseSeconds: 90, turnCapSeconds: 600 } } })
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30', harness: 'mock' } })))
  const e = await working(lab, delegate)
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the delegator ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  // The pool its last execution ran in, gone with an older image, once the catalogue is read again; another of its harness offered.
  const before = (await lab.state(ws)).current!
  lab.kube.morePools.length = 0
  await sleep(10_200)
  assert.equal(text(await (await client(t, url, e.id)).callTool({ name: 'send_message', arguments: { to: 'parent', message: 'to a gone pool' } })), 'sent')
  assert.equal((await lastAnswer(lab, db, ws)).waiting, true)
  const next = await until('continued', async () => {
    const state = await lab.state(ws)
    return state.executions.size === 2 && state.current
  }, 30_000)
  assert.deepEqual([before.body.pool, next.body.pool, next.profiles, next.body.limits], ['mock-older', 'mock-test', before.profiles, before.body.limits])
})

test('L125 a Write of Agora’s with the execution ended, its Create refused quota: tried again once a place is free', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:delegate'], {}, { workstreams: { maxActive: 3 } })
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30', harness: 'mock' } })))
  const d = await client(t, url, (await working(lab, delegate)).id)
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the delegator ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  const [one, two] = [await lab.workstream(), await lab.workstream()]
  await lab.open(one)
  await lab.open(two)
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'behind the quota' } })), 'sent')
  assert.equal((await lastAnswer(lab, db, ws)).waiting, true)
  await sleep(1_500)
  assert.equal((await lab.state(ws)).executions.size, 1)
  await expire(lab.kube, (await lab.state(one)).current!.claimName)
  await until('continued', async () => (await lab.state(ws)).executions.size === 2, 30_000)
  await until('its turn', async () => (await prompts(lab, ws)).length === 1, 30_000)
  assert.equal(blocksOf((await prompts(lab, ws))[0]!).at(-1)!.text, 'behind the quota')
})

test('L126 a Write of Agora’s while an approval is pending: waiting, the approval not refused; sent once it is settled', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], { approvalMs: 8_000 })
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 5', harness: 'mock' } })))
  const d = await client(t, url, (await working(lab, delegate)).id)
  const call = c.callTool({ name: 'spawn_agent', arguments: { instructions: 'needs the internet', harness: 'mock', rights: ['internet'] } })
  const ask = await until('the approval', async () => (await lab.state(ws)).question)
  const [approval] = await projected(lab, ws, 'question')
  assert.equal(approval?.status, 'pending')
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'not a refusal' } })), 'sent')
  await sleep(500)
  const state = await lab.state(ws)
  assert.deepEqual([state.question?.position, state.waiting.length, (await prompts(lab, ws)).length], [ask.position, 1, 0])
  assert.equal((await elements(lab, ws, 'question'))[0]?.status, 'pending')
  assert.ok((await lab.command(ws, 'Answer', { question: ask.position }, { optionId: 'approve' })).accepted)
  delegateOf(text(await call))
  await until('sent', async () => (await prompts(lab, ws)).length === 1)
  assert.equal(blocksOf((await prompts(lab, ws))[0]!)[1]!.text, 'not a refusal')
})

test('L126 a Write of Agora’s while a question, then a permission, is pending: waiting; sent once it is settled', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 8', harness: 'mock' } })))
  const d = await client(t, url, (await working(lab, delegate)).id)
  const asked = await lab.command(ws, 'Ask', {}, { title: 'Which?', text: 'Which one?', options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { optionId: 'b', name: 'B', kind: 'reject_once' }] })
  assert.ok(asked.accepted)
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'behind the question' } })), 'sent')
  await sleep(300)
  assert.equal((await prompts(lab, ws)).length, 0)
  assert.ok((await lab.command(ws, 'Answer', { question: asked.position }, { optionId: 'a' })).accepted)
  await until('sent', async () => (await prompts(lab, ws)).length === 1)
  await until('its turn over', async () => (await lab.state(ws)).active === null)
  // A permission, its turn running: the message waits for its answer.
  assert.ok((await lab.write(ws, '/permission')).accepted)
  const permission = await until('the permission', async () => [...(await lab.state(ws)).permissions.values()][0])
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'behind the permission' } })), 'sent')
  await sleep(300)
  assert.equal((await steerings(lab, ws)).length, 0)
  const e = (await lab.state(ws)).current!
  assert.ok((await lab.command(ws, 'RespondPermission', { execution: e.id, session: e.session, requestPosition: permission.position }, { requestId: permission.rpc_id, outcome: { outcome: 'selected', optionId: 'allow-once' } })).accepted)
  await until('sent', async () => (await prompts(lab, ws)).some((x) => blocksOf(x).at(-1)!.text === 'behind the permission'))
})

test('L127 a Write of Agora’s during a turn, to an agent that says it: one steering line, its first block Agora’s line; the user element steered, from and as, without that line; in the catch-up, with it', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 5', harness: 'mock' } })))
  const d = await client(t, url, (await working(lab, delegate)).id)
  assert.equal((await lab.write(ws, '/sleep 3')).accepted, true)
  await lab.turn(ws, 'in_progress')
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: 'parent', message: 'into the turn' } })), 'sent')
  await until('its answer', async () => lines(await lab.entries(ws), 'in', '_session/steering').length === 1)
  const [line] = await steerings(lab, ws)
  assert.match(blocksOf(line!)[0]!.text, new RegExp(`^From your delegate ${delegate} `))
  assert.equal(blocksOf(line!)[1]!.text, 'into the turn')
  const [user] = await manyFromOthers(lab, ws, 1)
  assert.deepEqual([user?.steered, user?.from, user?.as, wordsOf(user!)], [true, delegate, 'delegate', 'into the turn'])
  await lab.turn(ws, 'done', 20_000)
  const entries = await lab.entries(ws)
  const [exchange] = exchangesOf(entries, [(await prompts(lab, ws))[0]!.position])
  assert.match(exchange!.agent, new RegExp(`\\[during this turn: From your delegate ${delegate} .*\\n?into the turn\\]`))
})

test('M10 tools/list with agora:delegate; from a delegate, with agora:submit alone, as its Session opens, before its instructions; from one holding both: the four tools, list_agents alone read-only; send_message alone; the four, each once', async (t) => {
  const { lab, url, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const tools = (await c.listTools()).tools
  assert.deepEqual(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint, Object.keys(tool.inputSchema.properties ?? {}), tool.inputSchema.required]), [
    ['spawn_agent', undefined, ['instructions', 'harness', 'model', 'effort', 'rights'], ['instructions']],
    ['send_message', undefined, ['to', 'message'], ['to', 'message']],
    ['stop_agent', undefined, ['to'], ['to']],
    ['list_agents', true, [], undefined],
  ])
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 3', harness: 'mock' } })))
  // As its Session opens: what a harness listing its tools once is given (Codex); nothing of it depends on its instructions.
  const opened = await until('the delegate’s Session', async () => ((await lab.state(delegate)).current?.session ? (await lab.state(delegate)).current : null))
  const listed = (await (await client(t, url, opened.id)).listTools()).tools
  assert.deepEqual(listed.map((x) => [x.name, Object.keys(x.inputSchema.properties ?? {}), x.inputSchema.required]), [['send_message', ['to', 'message'], ['to', 'message']]])
  // A delegate that may delegate holds `send_message` by both its rights: listed once.
  const both = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 3', harness: 'mock', rights: ['agora:delegate'] } })))
  const holder = await until('its Session', async () => ((await lab.state(both)).current?.session ? (await lab.state(both)).current : null))
  assert.deepEqual(holder.profiles, ['agora:delegate', 'agora:submit'])
  assert.deepEqual((await (await client(t, url, holder.id)).listTools()).tools.map((x) => x.name), ['spawn_agent', 'send_message', 'stop_agent', 'list_agents'])
})

test('M11 a spawn_agent call Agora holds: an SSE stream, progress then the answer; another message, one JSON answer', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], { approvalMs: 1_500, progressMs: 300 })
  const post = (body: unknown) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [CALLER_HEADER]: `agora ${execution}` }, body: JSON.stringify(body) })
  const listed = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  assert.match(String(listed.headers.get('content-type')), /application\/json/)
  const held = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spawn_agent', arguments: { instructions: 'held', harness: 'mock', rights: ['internet'] }, _meta: { progressToken: 7 } } })
  assert.match(String(held.headers.get('content-type')), /text\/event-stream/)
  const events = (await held.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)) as { method?: string; id?: number; result?: unknown })
  assert.ok(events.filter((e) => e.method === 'notifications/progress').length >= 3)
  assert.equal(events.at(-1)?.id, 2)
  assert.equal((await projected(lab, ws, 'question', (q) => q.status !== 'pending'))[0]?.status, 'expired')
})

test('M12 stop_agent and list_agents from a delegate with agora:submit alone; delegate and submit, the names of an earlier contract; send_message to a delegate of its own, scoped down to agora:submit: not_allowed each time, nothing done; not_a_delegate', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 5', harness: 'mock' } })))
  const d = await client(t, url, (await working(lab, delegate)).id)
  const refused = async (who: Client, name: string, args: Record<string, unknown>) => {
    await assert.rejects(who.callTool({ name, arguments: args }), /not_allowed/)
  }
  await refused(d, 'stop_agent', { to: delegate })
  await refused(d, 'list_agents', {})
  await refused(c, 'delegate', { instructions: 'as before', harness: 'mock' })
  await refused(c, 'submit', { message: 'as before' })
  assert.equal((await lab.state(delegate)).active?.status, 'in_progress', 'the delegate still at work')
  assert.equal(Number((await lab.store.writer.query('SELECT count(*) FROM workstreams WHERE parent=$1', [ws])).rows[0].count), 1)
  // A delegate that delegated, then scoped down to its own right: its delegator alone, not the delegates it has.
  const middle = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'plain', harness: 'mock', rights: ['agora:delegate'] } })))
  await until('the middle one free', async () => (await lab.state(middle)).turns.size === 1 && (await lab.state(middle)).active === null)
  const e = (await lab.state(middle)).current!
  const m = await client(t, url, e.id)
  const bottom = delegateOf(text(await m.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 5', harness: 'mock' } })))
  assert.ok((await lab.command(middle, 'Scope', { execution: e.id }, { profiles: ['agora:submit'] })).accepted)
  const scoped = await client(t, url, e.id)
  assert.deepEqual((await scoped.listTools()).tools.map((x) => x.name), ['send_message'])
  const beyond = (await scoped.callTool({ name: 'send_message', arguments: { to: bottom, message: 'still mine?' } })) as Text
  assert.deepEqual([beyond.isError, text(beyond)], [true, 'not_a_delegate'])
  assert.equal((await kinds(lab, bottom, 'command')).filter((x) => x.content.kind === 'Write').length, 1, 'its instructions alone')
})

test('D46 stop_agent on a delegate whose turn runs, a permission pending in it; then send_message to it: stopped; one session/cancel, the permission cancelled; the delegate cancelled, out of the three at once; nothing written to its delegator; then sent, and a turn', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/permission', harness: 'mock' } })))
  await projected(lab, delegate, 'permission', (p) => p.status === 'pending')
  const title = '/permission'
  assert.equal(text(await c.callTool({ name: 'stop_agent', arguments: { to: delegate } })), `stopped ${delegate} · ${title}`)
  await lab.turn(delegate, 'cancelled')
  assert.equal(lines(await lab.entries(delegate), 'out', 'session/cancel').length, 1)
  // Agora answers it `cancelled` itself, as after the person's Cancel (docs/specs/log.md, "Commands").
  const [permission] = await projected(lab, delegate, 'permission', (p) => p.status !== 'pending')
  assert.match(JSON.stringify(permission?.answer), /cancelled/)
  const cancel = (await kinds(lab, delegate, 'command')).find((x) => x.content.kind === 'Cancel')!
  assert.deepEqual(object(cancel.content.body)?.from, { workstream: ws, as: 'delegator' })
  assert.equal(delegationOf(await lab.state(delegate)), 'cancelled')
  // It counts no more among the three at once.
  for (const n of [1, 2, 3]) delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: `/sleep 20 ${String(n)}`, harness: 'mock' } })))
  // The person's own Cancel is told to its delegator within a second (D27): none of this one is.
  await sleep(1_500)
  assert.equal((await fromOthers(lab, ws)).length, 0, 'nothing written to its delegator')
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: '/sleep 20' } })), new RegExp(`^sent ${delegate} · `))
  await until('its next turn', async () => (await prompts(lab, delegate)).length === 2, 20_000)
  // Its delegator's Cancel silenced that turn alone: the person's, on the next, is told.
  const next = await working(lab, delegate)
  assert.ok((await lab.command(delegate, 'Cancel', { execution: next.id, turn: (await lab.state(delegate)).active!.id })).accepted)
  const told = (await manyFromOthers(lab, ws, 1, 20_000)).find((u) => u.from === delegate)
  assert.deepEqual([told?.as, /: The person cancelled its turn\.$/.test(wordsOf(told!))], ['agora', true])
})

test('D46 stop_agent on a delegate that takes its time to stop, two others working: from its Cancel on, a place among the three is free', async (t) => {
  const { lab, url, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  // It ends its turn only 15 s on, cancelled or not: its Cancel is written, its turn still in progress.
  const slow = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/stubborn 15', harness: 'mock' } })))
  for (const n of [1, 2]) delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: `/sleep 20 ${String(n)}`, harness: 'mock' } })))
  await working(lab, slow)
  const full = (await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'a fourth', harness: 'mock' } })) as Text
  assert.deepEqual([full.isError, text(full)], [true, 'too_many_delegates'])
  assert.match(text(await c.callTool({ name: 'stop_agent', arguments: { to: slow } })), new RegExp(`^stopped ${slow} · `))
  assert.equal((await lab.state(slow)).active?.status, 'in_progress', 'its agent has not answered yet')
  delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'a fourth', harness: 'mock' } })))
})

test('D47 stop_agent on a delegate with no turn in progress; on one the person stopped; on a Workstream that is not the caller’s delegate: no turn to stop, no line sent; delegate_stopped; not_a_delegate', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'plain', harness: 'mock' } })))
  await manyFromOthers(lab, ws, 1)
  await until('the delegate free', async () => (await lab.state(delegate)).active === null)
  assert.equal(text(await c.callTool({ name: 'stop_agent', arguments: { to: delegate } })), `no turn to stop ${delegate} · plain`)
  assert.equal(lines(await lab.entries(delegate), 'out', 'session/cancel').length, 0)
  assert.equal((await kinds(lab, delegate, 'command')).filter((x) => x.content.kind === 'Cancel').length, 0)
  const e = (await lab.state(delegate)).current!
  assert.ok((await lab.command(delegate, 'Stop', { execution: e.id })).accepted)
  const stopped = (await c.callTool({ name: 'stop_agent', arguments: { to: delegate } })) as Text
  assert.deepEqual([stopped.isError, text(stopped)], [true, 'delegate_stopped'])
  const other = await lab.workstream()
  const foreign = (await c.callTool({ name: 'stop_agent', arguments: { to: other } })) as Text
  assert.deepEqual([foreign.isError, text(foreign)], [true, 'not_a_delegate'])
})

test('D48 stop_agent on a delegate whose own delegate works: its turn cancelled; its own delegate’s turn goes on, and that one’s last message is a turn of the stopped delegate’s', async (t) => {
  const { lab, url, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  // The middle one may delegate in turn: the right is the top one's own, so it starts at once.
  const middle = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30', harness: 'mock', rights: ['agora:delegate'] } })))
  const m = await client(t, url, (await working(lab, middle)).id)
  const bottom = delegateOf(text(await m.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 4', harness: 'mock' } })))
  await working(lab, bottom)
  assert.match(text(await c.callTool({ name: 'stop_agent', arguments: { to: middle } })), new RegExp(`^stopped ${middle} · `))
  await lab.turn(middle, 'cancelled')
  assert.equal((await lab.state(bottom)).active?.status, 'in_progress', 'its own delegate goes on')
  await until('a turn of the stopped one’s, from its own delegate', async () => (await prompts(lab, middle)).length === 2, 30_000)
  const [line, words] = blocksOf((await prompts(lab, middle))[1]!)
  assert.match(line!.text, new RegExp(`^From your delegate ${bottom} `))
  assert.match(words!.text, /Slept 4 s\./)
})

test('D49 list_agents with no delegate; with three — one working, one idle, one the person stopped —, a call waiting for its approval beside them: no delegate; three lines, the most recently changed first; the waiting call in none', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], { approvalMs: 20_000 })
  const c = await client(t, url, execution)
  assert.equal(text(await c.callTool({ name: 'list_agents', arguments: {} })), 'no delegate')
  const idle = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'plain', harness: 'mock' } })))
  await manyFromOthers(lab, ws, 1)
  await until('free', async () => (await lab.state(ws)).active === null && (await lab.state(idle)).active === null)
  const stopped = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30 stopped', harness: 'mock' } })))
  assert.ok((await lab.command(stopped, 'Stop', { execution: (await working(lab, stopped)).id })).accepted)
  await manyFromOthers(lab, ws, 2, 20_000)
  await until('free', async () => (await lab.state(ws)).active === null)
  const busy = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 30 working', harness: 'mock' } })))
  await working(lab, busy)
  // A call beyond the caller's rights, held: no delegate yet.
  const held = c.callTool({ name: 'spawn_agent', arguments: { instructions: 'held', harness: 'mock', rights: ['internet'] } }).catch(() => null)
  await projected(lab, ws, 'question', (q) => q.status === 'pending')
  const rowsOf = async () => text(await c.callTool({ name: 'list_agents', arguments: {} })).split('\n')
  const listed = await until('the three as their rows say them', async () => {
    const found = await rowsOf()
    return found.length === 3 && found.some((l) => l.endsWith(' · idle')) && found.some((l) => l.endsWith(' · cancelled')) ? found : null
  })
  assert.deepEqual(listed, [`${busy} · /sleep 30 working · working`, `${stopped} · /sleep 30 stopped · cancelled`, `${idle} · plain · idle`])
  assert.ok(!listed.some((l) => l.includes('held')))
  void held
})

test('D50 a delegate’s send_message to its delegator’s id; to another delegate of its delegator’s, and stop_agent on it, holding agora:delegate itself; a delegator’s to its delegate’s own delegate; parent from an execution that is no delegate: sent, as to parent; not_a_delegate each time; no_delegator', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'])
  const c = await client(t, url, execution)
  // The first may delegate itself: only whose delegate the other is keeps it from it.
  const one = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 20 one', harness: 'mock', rights: ['agora:delegate'] } })))
  const two = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 20 two', harness: 'mock' } })))
  const d = await client(t, url, (await working(lab, one)).id)
  await working(lab, two)
  assert.equal(text(await d.callTool({ name: 'send_message', arguments: { to: ws, message: 'by its id' } })), 'sent')
  const [user] = await manyFromOthers(lab, ws, 1)
  assert.deepEqual([user?.from, user?.as, wordsOf(user!)], [one, 'delegate', 'by its id'])
  const refusedAs = async (who: Client, name: string, args: Record<string, unknown>, reason: string) => {
    const answer = (await who.callTool({ name, arguments: args })) as Text
    assert.deepEqual([answer.isError, text(answer)], [true, reason], `${name} ${JSON.stringify(args)}`)
  }
  await refusedAs(d, 'send_message', { to: two, message: 'to a sibling' }, 'not_a_delegate')
  await refusedAs(d, 'stop_agent', { to: two }, 'not_a_delegate')
  const below = delegateOf(text(await d.callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 20 below', harness: 'mock' } })))
  await working(lab, below)
  await refusedAs(c, 'send_message', { to: below, message: 'past its delegate' }, 'not_a_delegate')
  await refusedAs(c, 'stop_agent', { to: below }, 'not_a_delegate')
  await refusedAs(c, 'send_message', { to: 'parent', message: 'to nobody' }, 'no_delegator')
  assert.equal((await lab.state(two)).active?.status, 'in_progress', 'the sibling still at work')
  assert.equal((await lab.state(below)).active?.status, 'in_progress', 'the one below still at work')
  for (const w of [two, below]) assert.equal((await kinds(lab, w, 'command')).filter((x) => ['Write', 'Cancel'].includes(String(x.content.kind))).length, 1, 'its instructions alone')
})

test('D52 a turn of the earlier contract, done with a submit in it; then a fresh engine, as after a restart: nothing more written to its delegator, then or after', async (t) => {
  const { lab, url, ws, execution, delegations } = await started(t, ['agora:delegate'])
  const delegate = delegateOf(text(await (await client(t, url, execution)).callTool({ name: 'spawn_agent', arguments: { instructions: '/sleep 2', harness: 'mock' } })))
  await working(lab, delegate)
  // As that contract's `submit` wrote it: a message of the delegate's marked with the turn it was called in.
  const turn = (await lab.state(delegate)).active!.id
  assert.ok((await delegations.write(ws, randomUUID(), { workstream: delegate, as: 'delegate', turn }, `From your delegate ${delegate} "/sleep 2", not the person:`, 'handed in by submit')).accepted)
  await lab.turn(delegate, 'done', 20_000)
  await manyFromOthers(lab, ws, 1)
  await sleep(1_500)
  assert.deepEqual((await fromOthers(lab, ws)).map(wordsOf), ['handed in by submit'])
  // Another engine, as at the first start of this contract: it reads the delegate's past with nothing seen.
  const fresh = new Delegations(lab.workstreams, { manual: true })
  await fresh.recover()
  await fresh.start()
  await fresh.tick(true)
  await sleep(1_000)
  assert.deepEqual((await fromOthers(lab, ws)).map(wordsOf), ['handed in by submit'])
  // The same turn with no such message sends its last one: D26, and after a restart D28.
})

/** Two roles as a card gives them: one of another harness with its model and effort, one that leaves them to its pool. */
const ROLES = new Map<string, Role>([
  ['scout', { name: 'scout', summary: 'Looks before anyone builds.', harness: 'other', model: 'mock-large', effort: 'high', persona: '# Scout\n\nYou look, and you say what you saw.' }],
  ['plain', { name: 'plain', summary: 'Leaves its settings to its pool.', harness: 'mock', model: null, effort: null, persona: '# Plain\n\nNothing of your own.' }],
])
const otherPool = (k: FakeKube) => k.morePools.push(['other-test', 'other'])

test('D53 spawn_agent with agent_type, a role of another harness with its model and effort; then a send_message; the agent titling itself with what it read first: that harness’s pool, the role’s settings; its first prompt the role’s line, its persona, then its delegator’s line, the instructions apart; its user element and its title the instructions alone; the next message with no persona', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], { roles: ROLES }, { kube: otherPool })
  const c = await client(t, url, execution)
  const answer = text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'look at the tests\nand say what fails', agent_type: 'scout' } }))
  const delegate = delegateOf(answer)
  assert.equal(answer, `started ${delegate} · look at the tests`)
  await lab.turn(delegate, 'done')
  const current = (await lab.state(delegate)).current!
  assert.deepEqual([current.body.pool, current.body.harness, current.body.settings], ['other-test', 'other', [{ id: 'model', value: 'mock-large' }, { id: 'effort', value: 'high' }]])
  const [opening, words, ...rest] = blocksOf((await prompts(lab, delegate))[0]!)
  assert.equal(
    opening!.text,
    `From Agora, not the person: your role, \`scout\`.\n\n# Scout\n\nYou look, and you say what you saw.\n\n---\n\nFrom your delegator ${ws}, an agent, not the person. It receives your last message:`,
  )
  assert.deepEqual([words!.text, rest.length], ['look at the tests\nand say what fails', 0])
  const [user] = await projected(lab, delegate, 'user')
  assert.deepEqual([user?.from, user?.as, wordsOf(user!)], [ws, 'delegator', 'look at the tests\nand say what fails'])
  const title = async () => (await lab.workstreams.projections.objects(delegate)).find((o) => o.kind === 'workstream')?.object.title
  await until('its title', async () => (await title()) === 'look at the tests')
  assert.equal((await kinds(lab, delegate, 'delegation.started'))[0]!.content.agentType, 'scout')
  // An agent titling itself with the first thing it read: the role's line is Agora's, not what it works on.
  const acp = current.acpId!
  const titled = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: acp, update: { sessionUpdate: 'session_info_update', title: opening!.text.split('\n')[0] } } })).toString('base64')
  assert.match(text(await c.callTool({ name: 'send_message', arguments: { to: delegate, message: `/raw ${titled}` } })), /^sent /)
  await until('its turn over', async () => (await lab.state(delegate)).turns.size === 2 && (await lab.state(delegate)).active === null)
  await sleep(500)
  assert.equal(await title(), 'look at the tests')
  // Its role is said once: the next message opens on its delegator's line alone.
  const [line] = blocksOf((await prompts(lab, delegate))[1]!)
  assert.equal(line!.text, `From your delegator ${ws}, an agent, not the person. It receives your last message:`)
})

test('D54 a role with harness naming another; with model given; a role that names no model and no effort; no agent_type: the pool named, none of the role’s settings, its persona all the same; that model, the role’s effort; its pool’s own; the delegator’s harness and its line alone', async (t) => {
  const { lab, url, ws, execution } = await started(t, ['agora:delegate'], { roles: ROLES }, { kube: otherPool })
  const c = await client(t, url, execution)
  const spawn = async (args: Record<string, unknown>) => {
    const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'a task', ...args } })))
    await lab.turn(delegate, 'done')
    const current = (await lab.state(delegate)).current!
    return { pool: current.body.pool, settings: current.body.settings ?? [], opening: blocksOf((await prompts(lab, delegate))[0]!)[0]!.text }
  }
  const from = `From your delegator ${ws}, an agent, not the person. It receives your last message:`
  // On another harness than its own, a role's model and effort mean nothing: that pool's defaults stand.
  const elsewhere = await spawn({ agent_type: 'scout', harness: 'mock' })
  assert.deepEqual([elsewhere.pool, elsewhere.settings], ['mock-test', []])
  assert.match(elsewhere.opening, /^From Agora, not the person: your role, `scout`\.\n\n# Scout\n/)
  // What the call names wins over the role's.
  const chosen = await spawn({ agent_type: 'scout', model: 'mock-small' })
  assert.deepEqual([chosen.pool, chosen.settings], ['other-test', [{ id: 'model', value: 'mock-small' }, { id: 'effort', value: 'high' }]])
  const plain = await spawn({ agent_type: 'plain' })
  assert.deepEqual([plain.pool, plain.settings], ['mock-test', []])
  assert.equal(plain.opening, `From Agora, not the person: your role, \`plain\`.\n\n# Plain\n\nNothing of your own.\n\n---\n\n${from}`)
  // The control: with no role, as before.
  const none = await spawn({})
  assert.deepEqual([none.pool, none.settings, none.opening], ['mock-test', [], from])
})

test('D55 agent_type naming no role; not a string; with no role held at all; a role, rights beyond the delegator’s: unknown_agent_type each time, no Workstream created; the approval names the role', async (t) => {
  const { lab, db, url, ws, execution } = await started(t, ['agora:delegate'], { roles: ROLES }, { kube: otherPool })
  const c = await client(t, url, execution)
  for (const agent_type of ['judge', 'Scout', '', 7, null]) {
    const refused = (await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'a task', agent_type } })) as Text
    assert.deepEqual([refused.isError, text(refused)], [true, 'unknown_agent_type'], JSON.stringify(agent_type))
  }
  assert.equal(Number(((await db.admin.query('SELECT count(*) AS n FROM workstreams WHERE parent=$1', [ws])).rows[0] as { n: string }).n), 0)
  const call = c.callTool({ name: 'spawn_agent', arguments: { instructions: 'needs the internet', agent_type: 'scout', rights: ['internet'] } })
  await until('the approval', async () => (await lab.state(ws)).question)
  const [approval] = await projected(lab, ws, 'question')
  assert.match(String(approval?.text), /^Role `scout`: \*\*other\*\*, mock-large, effort high\n\nRights beyond the caller's: `internet`/)
  assert.equal((await lab.command(ws, 'Answer', { question: (await lab.state(ws)).question!.position }, { optionId: 'approve' })).accepted, true)
  assert.equal((await kinds(lab, delegateOf(text(await call)), 'delegation.started'))[0]!.content.agentType, 'scout')
  // An Agora holding no role knows none.
  const bare = await started(t, ['agora:delegate'])
  const refused = (await (await client(t, bare.url, bare.execution)).callTool({ name: 'spawn_agent', arguments: { instructions: 'a task', agent_type: 'scout' } })) as Text
  assert.deepEqual([refused.isError, text(refused)], [true, 'unknown_agent_type'])
})

test('D56 an effort, the call’s then a role’s, for a pool whose Sessions name it reasoning_effort: the delegate’s opening setting under that id, its Session set to it', async (t) => {
  const deep = new Map<string, Role>([['deep', { name: 'deep', summary: 'Thinks it through.', harness: 'mock', model: null, effort: 'high', persona: '# Deep\n\nYou think it through.' }]])
  const { lab, url, execution } = await started(t, ['agora:delegate'], { roles: deep }, { kube: (k) => (k.bridgeFactory = (publicKey, pod) => mockBridge(publicKey, pod, { effortId: 'reasoning_effort' })) })
  const c = await client(t, url, execution)
  // What the pool's last Session offered, the delegator's own here, is what the catalogue knows of it.
  await until('the pool’s settings known', async () => (await lab.workstreams.catalogue()).find((p) => p.name === 'mock-test')?.settings)
  for (const [args, value] of [[{ harness: 'mock', effort: 'low' }, 'low'], [{ agent_type: 'deep' }, 'high']] as const) {
    const delegate = delegateOf(text(await c.callTool({ name: 'spawn_agent', arguments: { instructions: 'a task', ...args } })))
    await lab.turn(delegate, 'done')
    const current = (await lab.state(delegate)).current!
    assert.deepEqual(current.body.settings, [{ id: 'reasoning_effort', value }])
    const setting = (current.settings as { id: string; currentValue: string }[]).find((x) => x.id === 'reasoning_effort')
    assert.equal(setting?.currentValue, value)
  }
})

test('M13 tools/list with roles held; with none; Agora’s own cards read; a card leaving its model to its pool: spawn_agent takes agent_type, one of the roles, each named with what it does; no agent_type; dev, judge, lead and sre, each with its harness and its persona; no model of its own', async (t) => {
  const { url, execution } = await started(t, ['agora:delegate'], { roles: ROLES })
  const spawn = (await (await client(t, url, execution)).listTools()).tools.find((tool) => tool.name === 'spawn_agent')!
  const properties = spawn.inputSchema.properties as Record<string, { enum?: string[]; description: string }>
  assert.deepEqual([Object.keys(properties), spawn.inputSchema.required], [['instructions', 'harness', 'model', 'effort', 'rights', 'agent_type'], ['instructions']])
  assert.deepEqual(properties.agent_type!.enum, ['scout', 'plain'])
  assert.match(properties.agent_type!.description, /Roles:\n- scout: Looks before anyone builds\.\n- plain: Leaves its settings to its pool\.$/)
  const bare = await started(t, ['agora:delegate'])
  const without = (await (await client(t, bare.url, bare.execution)).listTools()).tools.find((tool) => tool.name === 'spawn_agent')!
  assert.deepEqual(Object.keys(without.inputSchema.properties ?? {}), ['instructions', 'harness', 'model', 'effort', 'rights'])
  // The cards the server is given: the flows' own.
  const cards = loadRoles(join(import.meta.dirname, '..', '..', '..', 'apps', 'flows', 'roles'))
  assert.deepEqual([...cards.keys()], ['dev', 'judge', 'lead', 'sre'])
  for (const card of cards.values()) {
    assert.ok(['claude-code', 'codex', 'opencode'].includes(card.harness) && card.summary !== '' && card.persona.startsWith('# '), card.name)
    assert.ok(!card.persona.includes('\n---\n') && !/^---/.test(card.persona), `${card.name}: its front matter is not its persona`)
  }
  assert.deepEqual([cards.get('judge')!.harness, cards.get('judge')!.model, cards.get('judge')!.effort], ['codex', 'gpt-6.1-sol', 'xhigh'])  // A card that leaves its model to its pool, as the flows read it; one with no front matter is no card.
  assert.deepEqual(parseRole('---\nrole: reader\nsummary: Reads: and says so.\nharness: opencode\nmodel: default\n---\n\n# Reader\n\nYou read.\n'), {
    name: 'reader', summary: 'Reads: and says so.', harness: 'opencode', model: null, effort: null, persona: '# Reader\n\nYou read.',
  })
  assert.throws(() => parseRole('# Reader\n\nYou read.\n'), /front matter/)
  assert.throws(() => parseRole('---\nrole: reader\n---\n\n# Reader\n'), /its harness/)
})
