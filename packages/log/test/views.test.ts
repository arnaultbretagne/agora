// docs/specs/log.md, "Views" and "The thread": deterministic folds, versions and rebuilds, and reads
// that never skip nor repeat a change.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { canonical, core, CoreProjection, decode, encode, fromFold, hash, identity, LogStore, object, project, Projections, ThreadClient, type Entry, type ProjectedObject } from '../src/index.ts'
import { call, database, expire, Lab, opened, readThread, sleep, until, view } from './support.ts'

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
  const high = async () => (await lab.store.projector.query('SELECT last_position,reset_position FROM threads WHERE workstream=$1', [ws])).rows[0]
  const last = BigInt((await high()).last_position)
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
  // Positions go on: the reset takes the next one, then every object one after it.
  const now = await high()
  assert.equal(BigInt(now.reset_position), last + 1n)
  assert.equal(BigInt(now.last_position), last + 1n + BigInt(after.length))
  const read = await readThread(lab.url, ws, String(last))
  assert.deepEqual(read.snapshot.map((r) => [r.operation, BigInt(r.position)]), [['reset', last + 1n], ...after.map((_, i) => ['upsert', last + 2n + BigInt(i)])])
  assert.deepEqual(read.snapshot.slice(1).map((r) => r.id).sort(), ids(after).sort())
  t.diagnostic(`reset at ${String(last + 1n)}, ${String(after.length)} objects after it, the last at ${String(now.last_position)}`)
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
  // Live rows carry each object at its last change: strictly after H, strictly increasing.
  const positions = read.live.map((r) => BigInt(r.position))
  assert.ok(positions.length > 0)
  assert.ok(positions[0]! > BigInt(read.end!))
  assert.ok(positions.every((p, i) => i === 0 || p > positions[i - 1]!), positions.join(','))
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

test('L42 Workstreams of one owner listed while one changes: none without an entry, the one changed last first', async (t) => {
  const db = await database()
  const lab = await Lab.start({ db })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const owner = randomUUID()
  const first = await lab.workstream(owner)
  await lab.open(first)
  const second = await lab.workstream(owner)
  await lab.open(second)
  const fresh = await lab.workstream(owner)
  const listed = async () => (await call(lab.url, 'GET', `/api/workstreams/page?owner=${owner}`)).body.rows as { id: string; title: string }[]
  assert.deepEqual((await listed()).map((r) => r.id), [second, first])
  assert.ok((await lab.write(first, 'a change')).accepted)
  const changed = await until('the change listed first', async () => {
    const rows = await listed()
    return rows[0]?.id === first ? rows : null
  })
  assert.deepEqual(
    changed.map((r) => [r.id, r.title]),
    [
      [first, 'a change'],
      [second, 'New workstream'],
    ],
  )
  assert.ok(!changed.some((r) => r.id === fresh))
})

test('L43 a Workstream through Create, a Session, a break, Stop and its end: the view\'s state, fields and title', async (t) => {
  const db = await database()
  const lab = await Lab.start({ db, relay: true, receiver: true })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const ws = await lab.workstream()
  assert.equal(await view(lab.url, ws), undefined, 'no view before the first entry')
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
  const last = (await view(lab.url, ws))!
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

test('L56 Workstreams listed by identity: each sees its own; without one, the owner given', async (t) => {
  const db = await database()
  const lab = await Lab.start({ db })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const create = (id: string, headers: Record<string, string>, body: Record<string, string> = {}) =>
    fetch(`${lab.url}/api/workstreams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ id, ...body }),
    }).then((r) => r.status)
  const list = (headers: Record<string, string>, query = '') =>
    fetch(`${lab.url}/api/workstreams/page${query}`, { headers }).then(async (r) =>
      r.status === 200 ? ((await r.json()) as { rows: { id: string }[] }).rows.map((v) => v.id).sort() : [r.status, ((await r.json()) as { reason: string }).reason],
    )
  const a = 'operator@example.org',
    b = 'someone@example.org'
  const [a1, a2, b1, other] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  const elsewhere = randomUUID()
  assert.equal(await create(a1, { 'x-forwarded-email': a }), 200)
  assert.equal(await create(a2, { 'x-forwarded-email': a }, { owner: randomUUID() }), 200)
  assert.equal(await create(b1, { 'x-forwarded-email': b }), 200)
  assert.equal(await create(other, {}, { owner: elsewhere }), 200)
  // Listed once they have an entry: a question each.
  const ask = { title: 'Listed', text: '', options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { optionId: 'b', name: 'B', kind: 'reject_once' }] }
  for (const id of [a1, a2, b1, other]) assert.ok((await lab.command(id, 'Ask', {}, ask)).accepted)
  assert.deepEqual(await list({ 'x-forwarded-email': a }), [a1, a2].sort())
  assert.deepEqual(await list({ 'x-forwarded-email': b }), [b1])
  assert.deepEqual(await list({ 'x-forwarded-email': 'nobody@example.org' }), [])
  assert.deepEqual(await list({}, `?owner=${elsewhere}`), [other])
  assert.deepEqual(await list({}), [400, 'invalid_identifier'])
})

test('L46 Agora started after its core projector changed version: a Workstream no longer followed is rebuilt too', async (t) => {
  const context = await opened(t)
  const { db, ws, e } = context
  assert.ok((await context.lab.write(ws, 'before the upgrade')).accepted)
  await context.lab.turn(ws, 'done')
  await context.lab.command(ws, 'Stop', { execution: e.id })
  await expire(context.lab.kube, e.claimName)
  await until('ended and projected', async () => (await view(context.lab.url, ws))?.state === 'ended')
  // As an older version of the projector left it.
  await db.admin.query("UPDATE checkpoints SET version='0' WHERE workstream=$1 AND projector='core'", [ws])
  await db.admin.query(`UPDATE objects SET object='{"title":"Workstream"}'::jsonb WHERE workstream=$1 AND projector='core' AND kind='workstream'`, [ws])
  context.lab = await context.lab.restart('clean')
  const rebuilt = await until('rebuilt', async () => {
    const v = await view(context.lab.url, ws)
    return v?.state === 'ended' ? v : undefined
  }, 10_000)
  assert.equal(rebuilt.title, 'before the upgrade')
  const { rows } = await db.admin.query("SELECT version FROM checkpoints WHERE workstream=$1 AND projector='core'", [ws])
  assert.equal(rows[0].version, core.version)
})

/** The thread's last position once the projector has written everything: it holds still. */
async function settled(lab: Lab, ws: string): Promise<string> {
  let last = ''
  await until('projection settled', async () => {
    const before = (await lab.store.projector.query('SELECT last_position FROM threads WHERE workstream=$1', [ws])).rows[0]?.last_position as string
    await sleep(300)
    last = (await lab.store.projector.query('SELECT last_position FROM threads WHERE workstream=$1', [ws])).rows[0]?.last_position as string
    return before === last
  })
  return last
}
/** Writes, then waits for that turn to be done. */
async function answered(lab: Lab, ws: string, text: string): Promise<void> {
  const count = (await lab.state(ws)).turns.size
  assert.ok((await lab.write(ws, text)).accepted)
  await until('the turn done', async () => {
    const turns = [...(await lab.state(ws)).turns.values()]
    return turns.length === count + 1 && turns.at(-1)!.status === 'done'
  })
}

test('L95 an element changed several times, the thread read from before its first change: one row, its last state, at its last change', async (t) => {
  const { lab, ws } = await opened(t)
  const before = await settled(lab, ws)
  await answered(lab, ws, '/sleep 3')
  const end = await settled(lab, ws)
  const read = await readThread(lab.url, ws, before)
  assert.equal(read.end, end)
  const texts = (await lab.workstreams.projections.objects(ws)).filter((o) => o.kind === 'element' && object(o.object)?.type === 'agent_message_chunk')
  assert.equal(texts.length, 1)
  const text = texts[0]!
  assert.match(String(object(text.object)?.text), /second 1\/3[\s\S]*second 3\/3[\s\S]*Slept 3 s\./)
  const rows = read.snapshot.filter((r) => r.id === text.id)
  assert.equal(rows.length, 1)
  assert.equal(canonical(rows[0]!.object), canonical(text.object))
  const position = (await lab.store.projector.query('SELECT position FROM objects WHERE workstream=$1 AND id=$2', [ws, text.id])).rows[0].position as string
  assert.equal(rows[0]!.position, position)
  // Each object once, in position order, after the cursor; the thread's last position counts every change.
  const ids = read.snapshot.map((r) => r.id)
  assert.equal(new Set(ids).size, ids.length)
  const positions = read.snapshot.map((r) => BigInt(r.position))
  assert.ok(positions.every((p, i) => p > BigInt(before) && p <= BigInt(end) && (i === 0 || p > positions[i - 1]!)), positions.join(','))
  const changes = BigInt(end) - BigInt(before)
  assert.ok(changes > BigInt(read.snapshot.length), `${String(changes)} changes, ${String(read.snapshot.length)} rows`)
  t.diagnostic(`${String(changes)} changes after ${before}, ${String(read.snapshot.length)} rows read, the text once at ${position}`)
})

test('L96 a fold drops an object without a version change: reset at the next position, then the complete state after it', async (t) => {
  const { lab, ws } = await opened(t)
  await answered(lab, ws, 'something to project')
  let drop = Number.POSITIVE_INFINITY
  const extra = fromFold('extra', '1', (entries) =>
    (entries.length === 0 ? [] : entries.length < drop ? ['kept', 'dropped'] : ['kept']).map((name) => ({
      kind: 'element' as const,
      id: identity(ws, 'extra', name),
      object: { type: 'extra', name },
      first_position: entries[0]!.position,
      last_position: entries[0]!.position,
    })),
  )
  const projections = new Projections(lab.store, [core, extra])
  await projections.run(ws, extra)
  const kept = identity(ws, 'extra', 'kept'),
    dropped = identity(ws, 'extra', 'dropped')
  assert.equal((await projections.objects(ws)).filter((o) => o.id === kept || o.id === dropped).length, 2)
  drop = Number((await lab.store.writer.query('SELECT last_position FROM workstreams WHERE id=$1', [ws])).rows[0].last_position) + 1
  await answered(lab, ws, 'one more entry')
  const last = BigInt(await settled(lab, ws))
  await projections.run(ws, extra)
  const stored = await projections.objects(ws)
  assert.ok(stored.some((o) => o.id === kept))
  assert.ok(!stored.some((o) => o.id === dropped))
  const high = (await lab.store.projector.query('SELECT last_position,reset_position FROM threads WHERE workstream=$1', [ws])).rows[0]
  assert.equal(BigInt(high.reset_position), last + 1n)
  assert.equal(BigInt(high.last_position), last + 1n + BigInt(stored.length))
  const read = await readThread(lab.url, ws, String(last))
  assert.deepEqual(read.snapshot.map((r) => [r.operation, BigInt(r.position)]), [['reset', last + 1n], ...stored.map((_, i) => ['upsert', last + 2n + BigInt(i)])])
  assert.deepEqual(read.snapshot.slice(1).map((r) => r.id).sort(), stored.map((o) => o.id).sort())
  t.diagnostic(`reset at ${String(last + 1n)}, ${String(stored.length)} objects after it, ${dropped} gone`)
})
