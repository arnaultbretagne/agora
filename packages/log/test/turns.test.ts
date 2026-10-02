// docs/specs/log.md, "Dispatch and recovery" and "Backpressure and shutdown": a turn across invalid
// answers, cut and closed connections, a blocked capture, duplicated answers and a silent agent.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { mintBridgeToken } from '@agora/harness-bridge/token'
import { Collector, keys, mockBridge } from '@agora/testkit'
import { object, type Entry } from '../src/index.ts'
import { base64, database, FakeKube, hold, Lab, lines, opened, sleep, until, waiting } from './support.ts'

const texts = (entries: readonly Entry[]) =>
  lines(entries, 'in', 'session/update')
    .map((x) => object(object(object(x.content.params)?.update)?.content)?.text)
    .filter((text): text is string => typeof text === 'string')

const reconnected = (lab: Lab, ws: string, execution: string) =>
  until('reconnected', async () => {
    const current = (await lab.state(ws)).current
    return current?.connection && lab.executions.connectionOf(execution) === current.connection
  })

test('L4 an invalid answer to the pending prompt fails it in one transaction, uncertain until the valid answer', async (t) => {
  const { db, lab, ws } = await opened(t)
  const written = await lab.write(ws, '/invalid-then-valid')
  assert.ok(written.accepted)
  const prompt = lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!
  const failed = await until('request.failed', async () => (await lab.entries(ws)).find((x) => x.kind === 'request.failed' && x.content.requestPosition === prompt.position))
  assert.equal(failed.content.reason, 'invalid_body')
  // One transaction: both rows carry the same inserting transaction id (read by the provisioning login).
  const diagnostic = await db.admin.query('SELECT reason, xmin::text AS xmin FROM diagnostics WHERE id=$1', [failed.content.diagnostic])
  assert.equal(diagnostic.rows[0]?.reason, 'invalid_body')
  const entry = await db.admin.query('SELECT xmin::text AS xmin FROM entries WHERE workstream=$1 AND position=$2', [ws, failed.position])
  assert.equal(entry.rows[0].xmin, diagnostic.rows[0].xmin)
  const turn = [...(await lab.state(ws)).turns.values()].find((x) => x.requestPosition === prompt.position)!
  assert.equal(turn.status, 'uncertain')
  assert.deepEqual(await lab.write(ws, 'meanwhile'), { accepted: false, reason: 'turn_uncertain' })
  const done = await lab.turn(ws, 'done')
  assert.deepEqual([done.id, done.stopReason], [turn.id, 'end_turn'])
  assert.equal(lines(await lab.entries(ws), 'in', 'session/prompt').length, 1)
})

test('L7 a capture connection terminated during a turn: the line is retried, committed once, in order', async (t) => {
  const { db, lab, ws } = await opened(t)
  assert.ok((await lab.write(ws, '/sleep 3')).accepted)
  const prompt = lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!
  await until('prompt sent', async () => (await lab.entries(ws)).some((x) => x.kind === 'acp.sent' && x.content.requestPosition === prompt.position))
  const release = await hold(db, ws)
  let pids: number[] = []
  try {
    pids = await until('a capture waiting', () => waiting(db, 'writer').then((p) => p.length > 0 && p))
    // Real: the backend of the waiting capture is terminated.
    await db.admin.query('SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid', [pids])
  } finally {
    await release()
  }
  const turn = await lab.turn(ws, 'done', 20_000)
  assert.equal(turn.stopReason, 'end_turn')
  const received = lines(await lab.entries(ws), 'in').filter((x) => BigInt(x.position) > BigInt(prompt.position))
  assert.deepEqual(texts(received), ['… second 1/3\n', '… second 2/3\n', '… second 3/3\n', 'Slept 3 s.'])
  const ordinals = received.map((x) => BigInt(x.receive_ordinal!))
  assert.deepEqual(ordinals, ordinals.map((_, i) => ordinals[0]! + BigInt(i)))
  const blocked = lab.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.operation === 'capture' && l.outcome === 'blocked')
  assert.ok(blocked.length > 0)
  t.diagnostic(`${String(pids.length)} backend(s) terminated; the capture blocked ${String(blocked.length)} time(s), then ${String(received.length)} lines committed once, ordinals ${String(ordinals[0])}–${String(ordinals.at(-1))}`)
})

test('L11 the bridge closes the connection during a turn: unclean break, uncertain, closed by its answer', async (t) => {
  const { lab, ws, e } = await opened(t)
  const connection = e.connection
  assert.ok((await lab.write(ws, '/silence 3')).accepted)
  const prompt = lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!
  await until('prompt sent', async () => (await lab.entries(ws)).some((x) => x.kind === 'acp.sent' && x.content.requestPosition === prompt.position))
  // Real: another client with a valid token makes the bridge close Agora's connection.
  const pod = lab.executions.claimOf(e.id)!.status!.sandbox!.name!
  const other = new Collector(`ws://${lab.kube.bridges.get(pod)!.url}/acp`, { authorization: `Bearer ${mintBridgeToken(lab.keys.privateKey, pod)}` })
  await other.opened()
  const broken = await until('the break', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.break' && x.content.connection === connection))
  other.socket.close()
  assert.deepEqual([String(broken.content.code), broken.content.clean], ['4000', false])
  const turn = [...(await lab.state(ws)).turns.values()].find((x) => x.requestPosition === prompt.position)!
  assert.equal(turn.status, 'uncertain')
  await reconnected(lab, ws, e.id)
  const done = await lab.turn(ws, 'done')
  assert.equal(done.id, turn.id)
  const entries = await lab.entries(ws)
  assert.equal(lines(entries, 'out', 'session/prompt').length, 1)
  assert.equal(entries.filter((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === prompt.position).length, 1)
})

test('L33 the same final answer twice: both captured, the first applies once', async (t) => {
  const { lab, ws, e } = await opened(t)
  const before = lab.kube.deadlines.filter((d) => d.name === e.claimName).length
  assert.ok((await lab.write(ws, '/answer-twice')).accepted)
  const prompt = lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!
  const answers = await until('two answers', async () => {
    const found = (await lab.entries(ws)).filter((x) => x.kind === 'acp' && x.direction === 'in' && x.request_position === prompt.position)
    return found.length === 2 && found
  })
  assert.equal(answers[0]!.content.id, answers[1]!.content.id)
  await sleep(500)
  const turn = [...(await lab.state(ws)).turns.values()].find((x) => x.requestPosition === prompt.position)!
  assert.deepEqual([turn.status, turn.stopReason], ['done', 'end_turn'])
  // The dispatch and one end-of-turn lease: the second answer grants none.
  assert.equal(lab.kube.deadlines.filter((d) => d.name === e.claimName).length - before, 2)
})

test('L33 the same opening answer twice, then after the end of the execution: captured, no Session reopened', async (t) => {
  const { lab, ws, e } = await opened(t)
  const opening = lines(await lab.entries(ws), 'out', 'session/new')[0]!
  const duplicate = `{"jsonrpc":"2.0","id":${JSON.stringify(opening.rpc_id)},"result":{"sessionId":"duplicate-session"}}`
  await lab.write(ws, `/raw ${base64(duplicate)}`)
  await lab.turn(ws, 'done')
  const again = (await lab.entries(ws)).filter((x) => x.kind === 'acp' && x.direction === 'in' && x.request_position === opening.position)
  assert.equal(again.length, 2)
  assert.equal(object(again[1]!.content.result)?.sessionId, 'duplicate-session')
  assert.equal((await lab.state(ws)).current?.session, e.session)
  // The execution ends: the deadline passes and the claim disappears.
  lab.kube.expireAt(e.claimName, new Date())
  await until('execution.ended', async () => (await lab.entries(ws)).some((x) => x.kind === 'execution.ended'))
  // Simulated: the same answer handed over once more, after the end (synthetic-event).
  const late = await lab.store.incoming(ws, e.id, e.connection!, '1000000', duplicate)
  assert.equal(late.handled, true)
  const entries = await lab.entries(ws)
  assert.equal(entries.filter((x) => x.kind === 'acp' && x.direction === 'in' && x.request_position === opening.position).length, 3)
  assert.equal(entries.filter((x) => x.kind === 'session.opened').length, 1)
  assert.equal(entries.filter((x) => x.kind === 'session.opened' || x.kind === 'session.ended').at(-1)?.kind, 'session.ended')
})

test('L34 initialize unanswered: response_timeout, startup_failed, and no second initialize', async (t) => {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  kube.bridgeFactory = (publicKey, pod) => mockBridge(publicKey, pod, { initializeDelayMs: 30_000 })
  const db = await database()
  const lab = await Lab.start({ db, kube, keys: pair, workstreams: { responseTimeoutMs: 1000 } })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const ws = await lab.workstream()
  assert.ok((await lab.command(ws, 'Create', {}, { pool: 'mock-test' })).accepted)
  const failed = await until('execution.failed', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.failed'))
  const entries = await lab.entries(ws)
  const initialize = lines(entries, 'out', 'initialize')
  assert.equal(initialize.length, 1)
  const timeout = entries.find((x) => x.kind === 'request.failed' && x.content.requestPosition === initialize[0]!.position)
  assert.equal(timeout?.content.reason, 'response_timeout')
  assert.deepEqual([failed.content.reason, failed.content.requestPosition], ['startup_failed', initialize[0]!.position])
  assert.ok(BigInt(timeout!.position) < BigInt(failed.position))
  await sleep(1500)
  const pod = [...kube.bridges.keys()][0]!
  const received = readFileSync(join(kube.bridges.get(pod)!.home, '.mock-agent', 'initialize-requests'), 'utf8').trim().split('\n')
  assert.deepEqual(received, [String(initialize[0]!.rpc_id)])
  assert.equal(lines(await lab.entries(ws), 'out', 'initialize').length, 1)
  t.diagnostic(`request.failed (${String(timeout!.content.reason)}) then execution.failed (${String(failed.content.reason)}); the agent received ${String(received.length)} initialize`)
})

test('L35 a line waiting for its commit: nothing more is read, then every line is captured once, in order', async (t) => {
  const { db, lab, ws, e } = await opened(t)
  const size = 512
  const start = (await lab.entries(ws)).length
  assert.ok((await lab.write(ws, `/big ${String(size)}`)).accepted)
  await until('the first line', async () => texts((await lab.entries(ws)).slice(start)).length > 0, 15_000)
  // Real: the next commit waits on a lock the test holds in PostgreSQL.
  const release = await hold(db, ws)
  let frozen = 0
  const pending: number[] = []
  try {
    await until('a capture waiting', () => waiting(db, 'writer').then((p) => p.length > 0))
    frozen = (await lab.entries(ws)).length
    for (let i = 0; i < 20; i++) {
      pending.push(lab.executions.views().find((v) => v.execution === e.id)!.pending)
      await sleep(50)
    }
    assert.equal((await lab.entries(ws)).length, frozen)
  } finally {
    await release()
  }
  // What waits: the line being committed and what came with it in one read of the socket (64 KiB);
  // the other lines, about 512 KiB, stay with the bridge.
  assert.ok(pending.every((bytes) => bytes > 0 && bytes <= 64 * 1024 + 2048), `pending: ${pending.join(',')}`)
  assert.ok(texts((await lab.entries(ws)).slice(start, frozen)).length < size)
  await lab.turn(ws, 'done', 60_000)
  const received = lines((await lab.entries(ws)).slice(start), 'in', 'session/update')
  const indexes = texts(received).map((text) => Number(text.slice(0, 5)))
  assert.deepEqual(indexes, Array.from({ length: size }, (_, i) => i))
  t.diagnostic(`while held: ${String(Math.min(...pending))}–${String(Math.max(...pending))} bytes waiting; then ${String(size)} lines captured once, in order`)
  const ordinals = received.map((x) => BigInt(x.receive_ordinal!))
  assert.deepEqual(ordinals, ordinals.map((_, i) => ordinals[0]! + BigInt(i)))
})
