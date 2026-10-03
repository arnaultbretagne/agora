// docs/specs/log.md, "Views" and "The thread": deterministic folds, versions and rebuilds, and reads
// that never skip nor repeat a change.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { canonical, core, CoreProjection, decode, encode, fromFold, hash, identity, LogStore, object, project, Projections, ThreadClient, type Entry, type ProjectedObject } from '../src/index.ts'
import { call, database, expire, Lab, opened, readThread, sleep, until } from './support.ts'

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

// docs/specs/log.md, "The Workstream view", "Notices" and "HTTP": what the client reads of a Workstream.
const views = async (lab: Lab) => (await call(lab.url, 'GET', '/api/workstreams')).body.workstreams as Record<string, unknown>[]
/** The Workstream view through the entries, one at a time, as the projector folds them. */
function viewsOver(entries: readonly Entry[]): Record<string, unknown>[] {
  const projection = new CoreProjection()
  const seen: Record<string, unknown>[] = []
  for (const entry of entries) {
    projection.apply([entry])
    const view = projection.objects.get(entry.workstream)?.object as Record<string, unknown> | undefined
    if (view && view !== seen.at(-1)) seen.push(view)
  }
  return seen
}
const sessionInfo = (acpId: string, title: string) =>
  `/raw ${Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: acpId, update: { sessionUpdate: 'session_info_update', title } } })).toString('base64')}`

test('L42 Workstreams listed while one changes: every view, a new one first, then the one changed last', async (t) => {
  const { lab, ws } = await opened(t)
  const second = await lab.workstream()
  await lab.open(second)
  const fresh = await lab.workstream()
  assert.deepEqual((await views(lab)).map((v) => v.id), [fresh, second, ws])
  assert.equal((await views(lab))[0]!.state, 'none')
  assert.ok((await lab.write(ws, 'a change')).accepted)
  const listed = await views(lab)
  assert.deepEqual(listed.map((v) => v.id), [fresh, ws, second])
  assert.deepEqual(listed.map((v) => v.title), ['New workstream', 'a change', 'New workstream'])
})

test('L43 a Workstream through Create, a Session, a break, Stop and its end: the view\'s state, fields and title', async (t) => {
  const db = await database()
  const lab = await Lab.start({ db, relay: true, receiver: true })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const ws = await lab.workstream()
  assert.equal((await views(lab)).find((v) => v.id === ws)?.state, 'none')
  const e = await lab.open(ws)
  assert.ok((await lab.write(ws, 'Fix the login page\nwith a second line')).accepted)
  await lab.turn(ws, 'done')
  const breaks = (await lab.entries(ws)).filter((x) => x.kind === 'execution.break').length
  lab.cut()
  await until('reconnected', async () => {
    const entries = await lab.entries(ws)
    const broken = entries.filter((x) => x.kind === 'execution.break')
    return broken.length > breaks && entries.findLast((x) => x.kind.startsWith('execution.'))?.kind === 'execution.connected'
  })
  const acpId = String((await lab.entries(ws)).find((x) => x.kind === 'session.opened')!.content.acpId)
  assert.ok((await lab.write(ws, sessionInfo(acpId, 'The agent names it'))).accepted)
  await lab.turn(ws, 'done')
  assert.ok((await lab.command(ws, 'Stop', { execution: e.id })).accepted)
  await expire(lab.kube, e.claimName)
  const ended = await until('execution.ended', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.ended'))
  const seen = viewsOver(await lab.entries(ws))
  const states = seen.map((v) => v.state).filter((s, i, all) => i === 0 || s !== all[i - 1])
  assert.deepEqual(states, ['starting', 'ready', 'interrupted', 'ready', 'stopped', 'ended'])
  assert.deepEqual(
    [...new Set(seen.map((v) => v.title))],
    ['New workstream', 'Fix the login page', 'The agent names it'],
  )
  const last = (await views(lab)).find((v) => v.id === ws)!
  assert.deepEqual(
    [last.state, last.pool, last.harness, last.execution, last.session, last.anchor, last.title],
    ['ended', 'mock-test', 'mock', e.id, null, ended.content.anchor, 'The agent names it'],
  )
  assert.equal(typeof ended.content.anchor, 'string')
})

test('L44 a Session opened new, then restored from an anchor, then ended: its notices', async (t) => {
  const db = await database()
  const lab = await Lab.start({ db, receiver: true })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const ws = await lab.workstream()
  const e = await lab.open(ws)
  assert.ok((await lab.write(ws, 'mirabelle')).accepted)
  await lab.turn(ws, 'done')
  await expire(lab.kube, e.claimName)
  const ended = await until('execution.ended', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.ended'))
  const anchor = String(ended.content.anchor)
  const restored = await lab.open(ws, { anchor })
  await lab.command(ws, 'Stop', { execution: restored.id })
  await expire(lab.kube, restored.claimName)
  await until('the second end', async () => (await lab.entries(ws)).filter((x) => x.kind === 'execution.ended').length === 2)
  const notices = project(await lab.entries(ws))
    .filter((o) => o.kind === 'notice')
    .map((o) => o.object as Record<string, unknown>)
    .sort((a, b) => Number(BigInt(String(a.firstPosition)) - BigInt(String(b.firstPosition))))
  const opened = notices.filter((n) => n.type === 'session.opened')
  assert.deepEqual(opened.map((n) => [n.origin, n.harness]), [['new', 'mock'], [anchor, 'mock']])
  const endedSessions = notices.filter((n) => n.type === 'session.ended')
  assert.equal(endedSessions.length, 2)
  assert.ok(endedSessions.every((n) => typeof n.reason === 'string' && n.reason !== ''))
  assert.ok(BigInt(String(endedSessions[0]!.firstPosition)) < BigInt(String(opened[1]!.firstPosition)))
})

test('L45 a Workstream created through the proxy: owned by the identity it passes, whatever the body says; refused to another', async (t) => {
  const db = await database()
  const lab = await Lab.start({ db })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const create = (id: string, email: string, owner?: string) =>
    fetch(`${lab.url}/api/workstreams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-email': email },
      body: JSON.stringify(owner === undefined ? { id } : { id, owner }),
    }).then((r) => r.status)
  const ws = randomUUID()
  assert.equal(await create(ws, 'operator@example.org', randomUUID()), 200)
  const { rows } = await db.admin.query('SELECT owner FROM workstreams WHERE id=$1', [ws])
  assert.equal(rows[0].owner, identity('owner', 'operator@example.org'))
  assert.equal(await create(ws, 'operator@example.org'), 200)
  assert.equal(await create(ws, 'someone@example.org'), 409)
})

test('L46 Agora started after its core projector changed version: a Workstream no longer followed is rebuilt too', async (t) => {
  const context = await opened(t)
  const { db, ws, e } = context
  assert.ok((await context.lab.write(ws, 'before the upgrade')).accepted)
  await context.lab.turn(ws, 'done')
  await context.lab.command(ws, 'Stop', { execution: e.id })
  await expire(context.lab.kube, e.claimName)
  await until('ended and projected', async () => (await views(context.lab)).find((v) => v.id === ws)?.state === 'ended')
  // As an older version of the projector left it.
  await db.admin.query("UPDATE checkpoints SET version='0' WHERE workstream=$1 AND projector='core'", [ws])
  await db.admin.query(`UPDATE objects SET object='{"title":"Workstream"}'::jsonb WHERE workstream=$1 AND projector='core' AND kind='workstream'`, [ws])
  context.lab = await context.lab.restart('clean')
  const view = await until('rebuilt', async () => (await views(context.lab)).find((v) => v.id === ws && v.state === 'ended'), 10_000)
  assert.equal(view.title, 'before the upgrade')
  const { rows } = await db.admin.query("SELECT version FROM checkpoints WHERE workstream=$1 AND projector='core'", [ws])
  assert.equal(rows[0].version, core.version)
})
