// docs/specs/log.md, "Views" and "The thread": deterministic folds, versions and rebuilds, and reads
// that never skip nor repeat a change.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { canonical, core, CoreProjection, decode, encode, fromFold, hash, identity, LogStore, object, project, Projections, ThreadClient, type Entry, type ProjectedObject } from '../src/index.ts'
import { call, database, opened, readThread, sleep, until } from './support.ts'

test('L22 the real claude-code transcript, folded incrementally and through a rebuild, gives the recorded hash', async (t) => {
  const fixture = decode(await readFile(new URL('fixtures/claude-code.json', import.meta.url), 'utf8')) as {
    harness: string
    workstream: string
    entries: Entry[]
    projectionHash: string
  }
  assert.equal(fixture.harness, 'claude-code')
  assert.ok(fixture.entries.some((e) => object(object(e.content.params)?.update)?.sessionUpdate === 'tool_call'))
  // In memory: one entry at a time, then all at once.
  const incremental = new CoreProjection()
  for (const entry of fixture.entries) incremental.apply([entry])
  const sorted = (objects: Iterable<ProjectedObject>) => [...objects].sort((a, b) => a.id.localeCompare(b.id))
  assert.equal(hash(sorted(incremental.objects.values())), fixture.projectionHash)
  assert.equal(hash(project(fixture.entries)), fixture.projectionHash)
  // In PostgreSQL, through the projector login: projected after each entry, then rebuilt.
  const db = await database()
  const store = new LogStore(db.urls)
  t.after(async () => {
    await store.close()
    await db.drop()
  })
  await store.create(fixture.workstream, randomUUID())
  const projections = new Projections(store)
  for (const e of fixture.entries) {
    // Replaying a recorded history, its times included: written by the provisioning login.
    await db.admin.query(
      `INSERT INTO entries(workstream,position,time,kind,execution,session,content,direction,rpc_kind,method,correlated_method,request_position,rpc_id,command,connection,receive_ordinal)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`,
      [e.workstream, e.position, e.time, e.kind, e.execution, e.session, encode(e.content), e.direction, e.rpc_kind, e.method, e.correlated_method, e.request_position, e.rpc_id === null ? null : encode(e.rpc_id), e.command, e.connection, e.receive_ordinal],
    )
    await db.admin.query('UPDATE workstreams SET last_position=$2 WHERE id=$1', [e.workstream, e.position])
    await projections.run(fixture.workstream)
  }
  const stored = await projections.objects(fixture.workstream)
  assert.equal(hash(stored), fixture.projectionHash)
  await projections.run(fixture.workstream, core, true)
  const rebuilt = await projections.objects(fixture.workstream)
  assert.deepEqual(rebuilt.map((o) => o.id), stored.map((o) => o.id))
  assert.equal(hash(rebuilt), fixture.projectionHash)
})

test('L23 a projector version change drops its object, resets, and keeps the other projector and the positions', async (t) => {
  const { lab, ws } = await opened(t)
  assert.ok((await lab.write(ws, 'something to project')).accepted)
  await lab.turn(ws, 'done')
  const extra = (version: string, names: string[]) =>
    fromFold('extra', version, (entries) =>
      (entries.length === 0 ? [] : names).map((name) => ({
        kind: 'element' as const,
        id: identity(ws, 'extra', name),
        object: { type: 'extra', name, version },
        first_position: entries[0]!.position,
        last_position: entries.at(-1)!.position,
      })),
    )
  const first = new Projections(lab.store, [core, extra('1', ['kept', 'dropped'])])
  await first.run(ws, extra('1', ['kept', 'dropped']))
  await lab.workstreams.projections.run(ws)
  const before = await first.objects(ws)
  const thread = async () => (await lab.store.projector.query('SELECT position,operation FROM thread WHERE workstream=$1 ORDER BY position', [ws])).rows
  const rowsBefore = await thread()
  const last = BigInt(rowsBefore.at(-1)!.position)
  const second = new Projections(lab.store, [core, extra('2', ['kept'])])
  await second.run(ws, extra('2', ['kept']))
  const after = await second.objects(ws)
  const ids = (objects: ProjectedObject[]) => objects.map((o) => o.id)
  assert.ok(ids(before).includes(identity(ws, 'extra', 'dropped')))
  assert.deepEqual(ids(after), ids(before).filter((id) => id !== identity(ws, 'extra', 'dropped')))
  const coreBefore = before.filter((o) => object(o.object)?.type !== 'extra'),
    coreAfter = after.filter((o) => object(o.object)?.type !== 'extra')
  assert.equal(hash(coreAfter), hash(coreBefore))
  assert.equal(object(after.find((o) => o.id === identity(ws, 'extra', 'kept'))!.object)?.version, '2')
  const rowsAfter = await thread()
  // Nothing truncated: the earlier rows stay, then reset and the complete state follow.
  assert.deepEqual(rowsAfter.slice(0, rowsBefore.length), rowsBefore)
  const appended = rowsAfter.slice(rowsBefore.length)
  assert.deepEqual(appended.map((r) => BigInt(r.position)), appended.map((_, i) => last + 1n + BigInt(i)))
  assert.equal(appended[0]!.operation, 'reset')
  assert.deepEqual(appended.slice(1).map((r) => r.operation), after.map(() => 'upsert'))
  const read = await readThread(lab.url, ws, String(last))
  assert.equal(read.snapshot[0]?.operation, 'reset')
  assert.deepEqual(read.snapshot.slice(1).map((r) => r.id).sort(), ids(after).sort())
})

test('L24 the thread read while updates commit, cut before snapshot-end, then read again: nothing skipped, nothing twice', async (t) => {
  const { lab, ws } = await opened(t)
  assert.ok((await lab.write(ws, '/sleep 4')).accepted)
  await sleep(1200)
  const client = new ThreadClient()
  const cut = await readThread(lab.url, ws, client.cursor, { cut: 2 })
  assert.equal(cut.end, null)
  for (const row of cut.snapshot) client.apply(row)
  assert.equal(client.cursor, '0')
  const read = await readThread(lab.url, ws, client.cursor, {
    more: (live) => !live.some((r) => r.kind === 'turn' && object(r.object)?.status === 'done'),
    timeoutMs: 20_000,
  })
  for (const row of read.snapshot) client.apply(row)
  client.snapshotEnd(read.end!)
  for (const row of read.live) client.live(row)
  const positions = read.live.map((r) => BigInt(r.position))
  assert.ok(positions.length > 0)
  assert.deepEqual(positions, positions.map((_, i) => BigInt(read.end!) + 1n + BigInt(i)))
  // Once everything is projected, a read from the cursor brings the client to the stored state.
  await lab.turn(ws, 'done')
  await until('projection settled', async () => {
    const before = (await lab.store.projector.query('SELECT last_position FROM threads WHERE workstream=$1', [ws])).rows[0].last_position
    await sleep(300)
    const after = (await lab.store.projector.query('SELECT last_position FROM threads WHERE workstream=$1', [ws])).rows[0].last_position
    return before === after
  })
  const rest = await readThread(lab.url, ws, client.cursor)
  for (const row of rest.snapshot) client.apply(row)
  client.snapshotEnd(rest.end!)
  const stored = await lab.workstreams.projections.objects(ws)
  assert.deepEqual([...client.objects.keys()].sort(), stored.map((o) => o.id).sort())
  for (const o of stored) assert.equal(canonical(client.objects.get(o.id)), canonical(o.object))
  const negative = await call(lab.url, 'GET', `/api/workstreams/${ws}/thread?after=-1`)
  assert.deepEqual([negative.status, negative.body.reason], [400, 'invalid_cursor'])
  const beyond = await call(lab.url, 'GET', `/api/workstreams/${ws}/thread?after=${String(BigInt(rest.end!) + 1n)}`)
  assert.deepEqual([beyond.status, beyond.body.reason], [400, 'future_cursor'])
})
