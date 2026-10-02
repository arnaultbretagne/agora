// The cases of docs/specs/executions.md decided by the log: creation and the deadline's moves.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { canonical } from '../src/index.ts'
import { database, Lab, lines, opened, sleep } from './support.ts'

test('E3 Create replayed with the same command id: the first answer, one execution, a single claim', async (t) => {
  const db = await database()
  const lab = await Lab.start({ db })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const ws = await lab.workstream()
  const command = { id: randomUUID(), kind: 'Create' as const, target: {}, body: { pool: 'mock-test' } }
  const first = await lab.workstreams.command(ws, command)
  assert.ok(first.accepted)
  const again = await lab.workstreams.command(ws, structuredClone(command))
  assert.equal(canonical(again), canonical(first))
  await sleep(500)
  assert.equal((await lab.state(ws)).executions.size, 1)
  assert.equal(lab.kube.created.length, 1)
})

test('E4 a pool not in the catalogue, then the quota reached: refused with the reason', async (t) => {
  const db = await database()
  const lab = await Lab.start({ db, workstreams: { maxActive: 1 } })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const ws = await lab.workstream()
  assert.deepEqual(await lab.command(ws, 'Create', {}, { pool: 'no-such-pool' }), { accepted: false, reason: 'unknown_pool' })
  assert.ok((await lab.command(ws, 'Create', {}, { pool: 'mock-test' })).accepted)
  const other = await lab.workstream()
  assert.deepEqual(await lab.command(other, 'Create', {}, { pool: 'mock-test' }), { accepted: false, reason: 'quota' })
  assert.equal((await lab.entries(other)).length, 0)
})

const atLeast = <T extends { at: number }>(patches: T[], from: number) => patches.filter((p) => p.at >= from)

test('E12 the deadline moves forward at each renewal step during a turn', async (t) => {
  // The renewal step set to 1 s instead of a minute.
  const { lab, ws, e } = await opened(t, { workstreams: { renewSeconds: 1 } }, { limits: { leaseSeconds: 60, turnCapSeconds: 3600 } })
  const start = Date.now()
  assert.ok((await lab.write(ws, '/sleep 4')).accepted)
  await lab.turn(ws, 'done', 20_000)
  const during = atLeast(lab.kube.deadlines.filter((d) => d.name === e.claimName), start)
  // The dispatch, at least two steps, the end of the turn.
  assert.ok(during.length >= 4, String(during.length))
  const times = during.map((d) => Date.parse(d.shutdownTime))
  assert.deepEqual(times, [...times].sort((a, b) => a - b))
  assert.ok(new Set(times).size === times.length)
})

test('E12 the deadline never goes beyond turn start + maximum duration', async (t) => {
  const { lab, ws, e } = await opened(t, { workstreams: { renewSeconds: 1 } }, { limits: { leaseSeconds: 60, turnCapSeconds: 30 } })
  const start = Date.now()
  assert.ok((await lab.write(ws, '/sleep 3')).accepted)
  const prompt = lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!
  const cap = Date.parse(prompt.time) + 30_000
  await lab.turn(ws, 'done', 20_000)
  const answered = lines(await lab.entries(ws), 'in', 'session/prompt').at(-1)!
  const during = atLeast(lab.kube.deadlines.filter((d) => d.name === e.claimName), start).filter((d) => d.at < Date.parse(answered.time))
  assert.ok(during.length >= 1)
  assert.ok(during.every((d) => Date.parse(d.shutdownTime) <= cap))
  assert.equal(Date.parse(during[0]!.shutdownTime), cap)
})

test('E13 at the end of a turn the deadline is now + lease, then no more renewal', async (t) => {
  const { lab, ws, e } = await opened(t, { workstreams: { renewSeconds: 1 } }, { limits: { leaseSeconds: 60 } })
  assert.ok((await lab.write(ws, 'a short turn')).accepted)
  await lab.turn(ws, 'done')
  const answered = lines(await lab.entries(ws), 'in', 'session/prompt').at(-1)!
  await sleep(500)
  const patches = lab.kube.deadlines.filter((d) => d.name === e.claimName)
  const last = patches.at(-1)!
  assert.ok(Math.abs(Date.parse(last.shutdownTime) - (Date.parse(answered.time) + 60_000)) < 2000)
  await sleep(2500)
  assert.equal(lab.kube.deadlines.filter((d) => d.name === e.claimName).length, patches.length)
})
