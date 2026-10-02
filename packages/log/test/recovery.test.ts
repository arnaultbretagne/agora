// docs/specs/log.md, "Dispatch and recovery", "Database ownership" and "An execution's memory": Agora
// stopped, killed, cut from PostgreSQL, and the claim against the record. Most cases run the real lab
// (apps/lab) as its own process, on FakeKube served over HTTP: a kill is a real kill.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ANCHOR_FORMAT, checksumOf } from '@agora/harness-bridge/anchor'
import { LogStore, object, type Entry, type Execution } from '../src/index.ts'
import { cluster, database, Lab, lines, opened, Server, sleep, terminate, until, type Db } from './support.ts'

interface Served {
  readonly db: Db
  readonly c: Awaited<ReturnType<typeof cluster>>
  readonly reader: LogStore
  readonly ws: string
  server: Server
}

/** The lab as a process on a database and a cluster of the test's own, with one Workstream. */
async function served(t: { after(fn: () => Promise<void>): void }, env: Record<string, string> = {}): Promise<Served> {
  const db = await database()
  const c = await cluster()
  const run: Served = { db, c, reader: new LogStore(db.urls), ws: randomUUID(), server: await Server.start({ db, api: c.api, keys: c.keys, env }) }
  c.kube.anchorUrl = run.server.anchorUrl
  t.after(async () => {
    await run.server.stop('SIGKILL')
    await c.close()
    await run.reader.close()
    await db.drop()
  })
  const created = await run.server.post('/api/workstreams', { id: run.ws, owner: randomUUID() })
  assert.equal(created.status, 200)
  return run
}

async function restart(run: Served, env: Record<string, string> = {}): Promise<void> {
  await run.server.stop('SIGKILL')
  run.server = await Server.start({ db: run.db, api: run.c.api, keys: run.c.keys, env })
  run.c.kube.anchorUrl = run.server.anchorUrl
}

const entries = (run: Served) => run.reader.entries(run.ws)

async function open(run: Served, body: Record<string, unknown> = {}): Promise<Execution> {
  const answer = await run.server.command(run.ws, 'Create', {}, { pool: 'mock-test', ...body })
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  const e = await until('Session open', async () => {
    const current = (await run.reader.state(run.ws)).current
    return current?.session && current.connection ? current : null
  })
  return { ...e }
}

/** A Write over HTTP; the process may die while answering, at a fault point. */
async function write(run: Served, e: Execution, text: string): Promise<void> {
  await run.server.command(run.ws, 'Write', { execution: e.id, session: e.session }, { prompt: [{ type: 'text', text }] }).catch(() => undefined)
}

const prompt = async (run: Served) => until('the prompt written', async () => lines(await entries(run), 'out', 'session/prompt').at(-1))
const sent = (run: Served, line: Entry) =>
  until('the prompt sent', async () => (await entries(run)).some((x) => x.kind === 'acp.sent' && x.content.requestPosition === line.position))
const markers = async (run: Served, line: Entry) =>
  (await entries(run)).filter((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === line.position).length
const turnOf = async (run: Served, line: Entry) => [...(await run.reader.state(run.ws)).turns.values()].find((x) => x.requestPosition === line.position)!
const breakOf = (run: Served, connection: string) =>
  until('the break', async () => (await entries(run)).find((x) => x.kind === 'execution.break' && x.content.connection === connection))

test('L8 the ownership connection terminated: the process exits non-zero; on restart an unclean break, the turn uncertain, never resent', async (t) => {
  const run = await served(t)
  const e = await open(run)
  await write(run, e, '/silence 8')
  const line = await prompt(run)
  await sent(run, line)
  // Real: PostgreSQL terminates the ownership connection.
  assert.equal(await terminate(run.db, 'writer', 'owner'), 1)
  const exit = await run.server.exited
  assert.notEqual(exit.code, 0)
  assert.equal(exit.signal, null)
  t.diagnostic(`the lab exited with code ${String(exit.code)}`)
  await restart(run)
  const broken = await breakOf(run, e.connection!)
  assert.equal(broken.content.clean, false)
  assert.equal((await turnOf(run, line)).status, 'uncertain')
  const done = await until('the answer', async () => ((await turnOf(run, line)).status === 'done' ? true : null), 20_000)
  assert.ok(done)
  assert.equal(lines(await entries(run), 'out', 'session/prompt').length, 1)
  assert.equal(await markers(run, line), 1)
})

test('L17 Agora stopped cleanly (SIGTERM) during a dispatched turn: a clean break, the turn goes on, closed after restart', async (t) => {
  const run = await served(t)
  const e = await open(run)
  await write(run, e, '/silence 5')
  const line = await prompt(run)
  await sent(run, line)
  const exit = await run.server.stop('SIGTERM')
  assert.equal(exit.code, 0)
  const broken = await breakOf(run, e.connection!)
  assert.deepEqual([String(broken.content.code), broken.content.clean], ['1000', true])
  t.diagnostic(`exit ${String(exit.code)}; break code ${String(broken.content.code)}, clean`)
  assert.equal((await turnOf(run, line)).status, 'in_progress')
  await restart(run)
  await until('the answer', async () => ((await turnOf(run, line)).status === 'done' ? true : null), 20_000)
  const all = await entries(run)
  assert.equal(lines(all, 'out', 'initialize').length, 1)
  assert.equal(lines(all, 'out', 'session/prompt').length, 1)
  assert.equal(await markers(run, line), 1)
})

test('L18 Agora killed (SIGKILL) during a dispatched turn: on restart an unclean break, uncertain until its answer, never resent', async (t) => {
  const run = await served(t)
  const e = await open(run)
  await write(run, e, '/silence 6')
  const line = await prompt(run)
  await sent(run, line)
  await restart(run)
  const broken = await breakOf(run, e.connection!)
  assert.equal(broken.content.clean, false)
  assert.equal((await turnOf(run, line)).status, 'uncertain')
  await until('the answer', async () => ((await turnOf(run, line)).status === 'done' ? true : null), 20_000)
  t.diagnostic('killed with SIGKILL; unclean break written at restart; uncertain, then done')
  const all = await entries(run)
  assert.equal(lines(all, 'out', 'initialize').length, 1)
  assert.equal(lines(all, 'out', 'session/prompt').length, 1)
  assert.equal(await markers(run, line), 1)
})

test('L19 Agora dies before acp.dispatching: the line is dispatched once after restart', async (t) => {
  const run = await served(t, { AGORA_FAULT: 'before_marker:session/prompt' })
  const e = await open(run)
  await write(run, e, 'dispatched after the restart')
  assert.equal((await run.server.exited).signal, 'SIGKILL')
  const line = await prompt(run)
  assert.equal(await markers(run, line), 0)
  await restart(run)
  await until('the answer', async () => ((await turnOf(run, line)).status === 'done' ? true : null), 20_000)
  assert.equal(await markers(run, line), 1)
  assert.equal(lines(await entries(run), 'out', 'session/prompt').length, 1)
})

test('L19 Agora dies after acp.dispatching, before the write: uncertain and never resent', async (t) => {
  const run = await served(t, { AGORA_FAULT: 'after_marker:session/prompt' })
  const e = await open(run)
  await write(run, e, 'never written')
  assert.equal((await run.server.exited).signal, 'SIGKILL')
  const line = await prompt(run)
  await restart(run)
  await breakOf(run, e.connection!)
  assert.equal((await turnOf(run, line)).status, 'uncertain')
  await until('reconnected', async () => (await run.reader.state(run.ws)).current?.connection !== undefined)
  await sleep(3000)
  const all = await entries(run)
  assert.equal(await markers(run, line), 1)
  assert.equal(all.filter((x) => x.kind === 'acp.sent' && x.content.requestPosition === line.position).length, 0)
  assert.equal((await turnOf(run, line)).status, 'uncertain')
})

test('L19 Agora dies after the write, before acp.sent: uncertain and never resent', async (t) => {
  const run = await served(t, { AGORA_FAULT: 'after_write:session/prompt' })
  const e = await open(run)
  await write(run, e, '/silence 6')
  assert.equal((await run.server.exited).signal, 'SIGKILL')
  const line = await prompt(run)
  await restart(run)
  await breakOf(run, e.connection!)
  assert.equal((await turnOf(run, line)).status, 'uncertain')
  // The agent did read it: its answer closes the turn.
  await until('the answer', async () => ((await turnOf(run, line)).status === 'done' ? true : null), 20_000)
  const all = await entries(run)
  assert.equal(await markers(run, line), 1)
  assert.equal(all.filter((x) => x.kind === 'acp.sent' && x.content.requestPosition === line.position).length, 0)
  assert.equal(lines(all, 'out', 'session/prompt').length, 1)
})

const createOf = async (run: Served) => (await entries(run)).find((x) => x.kind === 'command' && x.content.kind === 'Create')!

test('L20 Agora dies after accepting a Create, before the claim: the claim is created once, as recorded', async (t) => {
  const run = await served(t, { AGORA_FAULT: 'before_claim' })
  await run.server.command(run.ws, 'Create', {}, { pool: 'mock-test' }).catch(() => undefined)
  assert.equal((await run.server.exited).signal, 'SIGKILL')
  const create = await createOf(run)
  assert.deepEqual(run.c.kube.created, [])
  await restart(run)
  const obtained = await until('execution.obtained', async () => (await entries(run)).find((x) => x.kind === 'execution.obtained'))
  const body = object(create.content.body)!
  const claim = run.c.kube.claims.get(String(create.content.claimName))!
  assert.deepEqual(run.c.kube.created, [create.content.claimName])
  assert.equal((claim.spec.lifecycle as { shutdownTime: string }).shutdownTime, body.deadline)
  assert.equal((claim.spec.warmPoolRef as { name: string }).name, 'mock-test')
  assert.equal(obtained.content.uid, claim.metadata.uid)
})

test('L20 Agora dies after the claim, before its UID: the UID is recorded, no second claim', async (t) => {
  const run = await served(t, { AGORA_FAULT: 'after_claim' })
  await run.server.command(run.ws, 'Create', {}, { pool: 'mock-test' }).catch(() => undefined)
  assert.equal((await run.server.exited).signal, 'SIGKILL')
  const create = await createOf(run)
  assert.deepEqual(run.c.kube.created, [create.content.claimName])
  assert.equal((await entries(run)).filter((x) => x.kind === 'execution.obtained').length, 0)
  await restart(run)
  const obtained = await until('execution.obtained', async () => (await entries(run)).find((x) => x.kind === 'execution.obtained'))
  assert.equal(obtained.content.uid, run.c.kube.claims.get(String(create.content.claimName))!.metadata.uid)
  await sleep(1500)
  assert.deepEqual(run.c.kube.created, [create.content.claimName])
})

test('L20 a recorded claim disappears: execution.ended, never recreated', async (t) => {
  const run = await served(t)
  const e = await open(run)
  // Simulated: the claim removed from the cluster by someone else (fake-kube).
  run.c.kube.deleteClaim(e.claimName)
  const ended = await until('execution.ended', async () => (await entries(run)).find((x) => x.kind === 'execution.ended'))
  assert.equal(ended.content.reason, 'claim_missing')
  await sleep(2500)
  assert.deepEqual(run.c.kube.created, [e.claimName])
  assert.equal(run.c.kube.claims.has(e.claimName), false)
})

test('L20 a claim with another UID: execution.lost (claim_conflict), the claim untouched', async (t) => {
  const run = await served(t)
  const e = await open(run)
  await run.server.stop('SIGKILL')
  // Simulated: the claim replaced under the same name (fake-kube).
  const claim = run.c.kube.claims.get(e.claimName)!
  claim.metadata.uid = randomUUID()
  const version = claim.metadata.resourceVersion
  const patches = run.c.kube.deadlines.length
  await restart(run)
  const lost = await until('execution.lost', async () => (await entries(run)).find((x) => x.kind === 'execution.lost'))
  assert.equal(lost.content.reason, 'claim_conflict')
  await sleep(2500)
  assert.equal(run.c.kube.claims.get(e.claimName)?.metadata.resourceVersion, version)
  assert.equal(run.c.kube.deadlines.length, patches)
  assert.deepEqual(run.c.kube.created, [e.claimName])
})

test('L21 a capture commit succeeds but its acknowledgement is lost: the retry finds it, one entry', async (t) => {
  const { lab, ws } = await opened(t, { pgRelay: true })
  // Real: the reply to the next capture's COMMIT is lost on the network.
  lab.pg!.arm('UNION ALL SELECT NULL AS position FROM diagnostics')
  assert.ok((await lab.write(ws, 'acknowledged once')).accepted)
  await lab.turn(ws, 'done')
  assert.equal(lab.pg!.dropped, 1)
  t.diagnostic('one COMMIT reply dropped on the network')
  const all = await lab.entries(ws)
  const received = all.filter((x) => x.receive_ordinal !== null)
  const identities = received.map((x) => `${x.connection!}:${x.receive_ordinal!}`)
  assert.equal(new Set(identities).size, identities.length)
  const chunks = lines(all, 'in', 'session/update').filter((x) => String(object(object(object(x.content.params)?.update)?.content)?.text).includes('acknowledged once'))
  assert.equal(chunks.length, 1)
  assert.ok(lab.logs.map((l) => JSON.parse(l) as Record<string, unknown>).some((l) => l.operation === 'capture' && l.outcome === 'blocked'))
})

test('L29 an anchor stored without its anchor.received gets one at the next start, before it is exposed', async (t) => {
  const run = await served(t, { AGORA_FAULT: 'after_anchor' })
  const e = await open(run)
  await write(run, e, 'kept in the anchor')
  await until('the answer', async () => ((await run.reader.state(run.ws)).turns.size && [...(await run.reader.state(run.ws)).turns.values()].every((x) => x.status === 'done')) || null)
  run.c.kube.expireAt(e.claimName, new Date())
  assert.equal((await run.server.exited).signal, 'SIGKILL')
  const [stored] = await run.reader.anchorList()
  assert.ok(stored)
  assert.equal((await entries(run)).filter((x) => x.kind === 'anchor.received').length, 0)
  await restart(run)
  const received = (await entries(run)).filter((x) => x.kind === 'anchor.received')
  assert.equal(received.length, 1)
  assert.equal(received[0]!.content.id, stored.id)
  const ended = await until('execution.ended', async () => (await entries(run)).find((x) => x.kind === 'execution.ended'))
  assert.ok(BigInt(received[0]!.position) < BigInt(ended.position))
  assert.equal(ended.content.anchor, stored.id)
  await restart(run)
  assert.equal((await entries(run)).filter((x) => x.kind === 'anchor.received').length, 1)
})

test('L30 the adapter dies: execution.lost, no dispatch or renewal, counted until its claim disappears', async (t) => {
  // A renewal step of 1 s: a renewal after the loss would show within the window below.
  const { lab, ws, e } = await opened(t, { workstreams: { maxActive: 1, renewSeconds: 1 } }, { limits: { leaseSeconds: 60 } })
  assert.ok((await lab.write(ws, '/crash')).accepted)
  const lost = await until('execution.lost', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.lost'))
  assert.equal(lost.content.reason, 'adapter_exited')
  const patches = lab.kube.deadlines.length
  assert.deepEqual(await lab.write(ws, 'after the loss'), { accepted: false, reason: 'execution_unavailable' })
  assert.deepEqual(await lab.command(ws, 'Create', {}, { pool: 'mock-test' }), { accepted: false, reason: 'execution_active' })
  const other = await lab.workstream()
  assert.deepEqual(await lab.command(other, 'Create', {}, { pool: 'mock-test' }), { accepted: false, reason: 'quota' })
  await sleep(1500)
  const after = (await lab.entries(ws)).filter((x) => BigInt(x.position) > BigInt(lost.position))
  assert.equal(after.filter((x) => x.kind === 'acp.dispatching').length, 0)
  assert.equal(lab.kube.deadlines.length, patches)
  lab.kube.expireAt(e.claimName, new Date())
  await until('execution.ended', async () => (await lab.entries(ws)).some((x) => x.kind === 'execution.ended'))
  await sleep(500)
  assert.equal((await lab.entries(ws)).filter((x) => x.kind === 'execution.ended').length, 1)
  const next = await lab.open(ws)
  assert.notEqual(next.id, e.id)
})

test('L31 the claim being deleted while its Pod lives, across a restart: admission closed, counted until it disappears', async (t) => {
  const context = await opened(t, { workstreams: { maxActive: 1 } })
  const { ws, e } = context
  const other = await context.lab.workstream()
  context.lab.kube.holdDeletion = true
  context.lab.kube.expireAt(e.claimName, new Date())
  await until('deletion started', () => context.lab.executions.claimOf(e.id)?.metadata.deletionTimestamp !== undefined)
  assert.deepEqual(await context.lab.write(ws, 'while ending'), { accepted: false, reason: 'execution_ending' })
  assert.deepEqual(await context.lab.command(ws, 'Create', {}, { pool: 'mock-test' }), { accepted: false, reason: 'execution_active' })
  assert.deepEqual(await context.lab.command(other, 'Create', {}, { pool: 'mock-test' }), { accepted: false, reason: 'quota' })
  context.lab = await context.lab.restart('clean')
  await sleep(1000)
  // No connection is opened to an ending claim.
  assert.deepEqual(await context.lab.write(ws, 'after the restart'), { accepted: false, reason: 'disconnected' })
  assert.deepEqual(await context.lab.command(ws, 'Create', {}, { pool: 'mock-test' }), { accepted: false, reason: 'execution_active' })
  assert.deepEqual(await context.lab.command(other, 'Create', {}, { pool: 'mock-test' }), { accepted: false, reason: 'quota' })
  assert.equal((await context.lab.entries(ws)).filter((x) => x.kind === 'execution.ended').length, 0)
  context.lab.kube.releaseDeletion()
  await until('execution.ended', async () => (await context.lab.entries(ws)).some((x) => x.kind === 'execution.ended'))
  const next = await context.lab.open(ws)
  assert.notEqual(next.id, e.id)
})

test('L32 a Pod pushes its anchor after a restart, with no connection open: stored, attributed, one anchor.received', async (t) => {
  const context = await opened(t, { receiver: true })
  const { ws, e } = context
  assert.ok((await context.lab.write(ws, 'pushed after a restart')).accepted)
  await context.lab.turn(ws, 'done')
  const pod = context.lab.executions.claimOf(e.id)!.status!.sandbox!.name!
  // Simulated: the Pod recreated under the same name, its token naming the old UID (fake-kube).
  context.lab.kube.podUids.set(pod, 'uid-recreated')
  const content = Buffer.from('{"forged":true}\n')
  const bundle = { format: ANCHOR_FORMAT, harness: 'mock', files: [{ path: 'forged.jsonl', checksum: checksumOf(content), content: content.toString('base64') }], stable: true }
  const forged = await fetch(context.lab.kube.anchorUrl, { method: 'POST', headers: { authorization: `Bearer pod:${pod}`, 'content-type': 'application/json' }, body: JSON.stringify(bundle) })
  assert.equal(forged.status, 409)
  assert.deepEqual(await context.lab.store.anchorList(), [])
  context.lab.kube.podUids.delete(pod)
  context.lab = await context.lab.restart('halt')
  context.lab.kube.expireAt(e.claimName, new Date())
  const received = await until('anchor.received', async () => (await context.lab.entries(ws)).find((x) => x.kind === 'anchor.received'))
  const [stored] = await context.lab.store.anchorList()
  assert.equal(received.content.id, stored!.id)
  assert.deepEqual([received.execution, received.session], [e.id, e.session])
  const row = await context.lab.store.writer.query('SELECT execution, session FROM anchors WHERE id=$1', [stored!.id])
  assert.deepEqual(row.rows[0], { execution: e.id, session: e.session })
  await until('execution.ended', async () => (await context.lab.entries(ws)).some((x) => x.kind === 'execution.ended'))
  assert.equal((await context.lab.entries(ws)).filter((x) => x.kind === 'anchor.received').length, 1)
})

test('L15 restore from an anchor: a new Session, the same ACP session id, and the agent recalls the history', async (t) => {
  const { lab, ws, e } = await opened(t, { receiver: true })
  assert.ok((await lab.write(ws, 'my name is Ada')).accepted)
  await lab.turn(ws, 'done')
  lab.kube.expireAt(e.claimName, new Date())
  const ended = await until('execution.ended', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.ended' && x.content.anchor))
  const anchor = String(ended.content.anchor)
  const restored = await lab.open(ws, { anchor })
  assert.notEqual(restored.id, e.id)
  assert.notEqual(restored.session, e.session)
  assert.equal(restored.acpId, e.acpId)
  const opening = (await lab.entries(ws)).findLast((x) => x.kind === 'session.opened')!
  assert.deepEqual([opening.session, opening.content.origin, opening.content.acpId], [restored.session, anchor, e.acpId])
  assert.ok((await lab.write(ws, '/recall')).accepted)
  await lab.turn(ws, 'done')
  const recall = lines(await lab.entries(ws), 'in', 'session/update')
    .map((x) => String(object(object(object(x.content.params)?.update)?.content)?.text))
    .findLast((text) => text.startsWith('You told me'))
  assert.ok(recall?.includes('"my name is Ada"'), recall)
})

test('L36 a storage outage lasting past the deadline: the interruption shown, no fresh lease', async (t) => {
  // A renewal step of 1 s: the turn is renewed every second until the outage.
  const { db, lab, ws, e } = await opened(t, { workstreams: { renewSeconds: 1 } }, { limits: { leaseSeconds: 60 } })
  const dispatched = lab.kube.deadlines.length
  assert.ok((await lab.write(ws, '/sleep 30')).accepted)
  const line = lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!
  await until('first chunk', async () => lines(await lab.entries(ws), 'in', 'session/update').length > 0)
  // Control: renewed during the turn, before the outage.
  await until('renewed during the turn', () => lab.kube.deadlines.length >= dispatched + 3, 10_000)
  const patches = lab.kube.deadlines.length
  // Real: PostgreSQL closes the database to new connections and ends Agora's open ones, but the
  // ownership connection.
  await db.connections(false)
  for (const role of ['writer', 'projector', 'anchors'] as const) await terminate(db, role, role === 'writer' ? 'others' : 'all')
  // While a received line waits for its commit, no command is admitted.
  await until('a capture blocked', () =>
    lab.logs.some((l) => {
      const line = JSON.parse(l) as Record<string, unknown>
      return line.operation === 'capture' && line.outcome === 'blocked'
    }),
  )
  const refused = await lab.workstreams.command(ws, { id: randomUUID(), kind: 'Write', target: { execution: e.id, session: e.session }, body: { prompt: [{ type: 'text', text: 'during the outage' }] } })
  assert.deepEqual(refused, { accepted: false, reason: 'unavailable' })
  // Simulated: the deadline brought to now by the cluster (fake-kube); it passes during the outage.
  lab.kube.expireAt(e.claimName, new Date(Date.now() + 1500))
  await until('the claim gone', () => !lab.kube.claims.has(e.claimName), 20_000)
  await sleep(1000)
  await db.connections(true)
  const ended = await until('execution.ended', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.ended'), 20_000)
  const broken = await until('the break', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.break' && x.content.connection === e.connection))
  assert.equal(broken.content.clean, false)
  assert.equal(ended.content.reason, 'claim_missing')
  assert.equal([...(await lab.state(ws)).turns.values()].find((x) => x.requestPosition === line.position)?.status, 'failed')
  assert.equal(lab.kube.deadlines.length, patches)
  assert.equal(lab.ownershipLost, 0)
  t.diagnostic(`${String(patches - dispatched)} deadline PATCH(es) before the outage, none after; a Write refused during it`)
  await until('projected', async () => {
    const notices = (await lab.workstreams.projections.objects(ws)).filter((o) => o.kind === 'notice').map((o) => object(o.object)?.type)
    return notices.includes('execution.break') && notices.includes('execution.ended')
  })
  // Once storage is back, the Workstream admits commands again.
  assert.ok((await lab.command(ws, 'Create', {}, { pool: 'mock-test' })).accepted)
})

test('L38 the bridge restarts inside its Pod during a turn: execution.lost (instance_changed), nothing more dispatched or renewed', async (t) => {
  const { lab, ws, e } = await opened(t, { workstreams: { renewSeconds: 1 } }, { limits: { leaseSeconds: 60 } })
  assert.ok((await lab.write(ws, '/sleep 20')).accepted)
  const line = lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!
  await until('first chunk', async () => lines(await lab.entries(ws), 'in', 'session/update').length > 0)
  // Real: the Pod's bridge replaced by a new process, with a new instance, under the same name.
  const pod = lab.executions.claimOf(e.id)!.status!.sandbox!.name!
  await lab.kube.replacePod(pod)
  const lost = await until('execution.lost', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.lost'))
  assert.equal(lost.content.reason, 'instance_changed')
  const patches = lab.kube.deadlines.length
  assert.equal([...(await lab.state(ws)).turns.values()].find((x) => x.requestPosition === line.position)?.status, 'failed')
  assert.deepEqual(await lab.write(ws, 'after the loss'), { accepted: false, reason: 'execution_unavailable' })
  await sleep(2500)
  const after = (await lab.entries(ws)).filter((x) => BigInt(x.position) > BigInt(lost.position))
  assert.equal(after.filter((x) => x.kind === 'acp.dispatching' || x.kind === 'execution.connected').length, 0)
  assert.equal(lab.kube.deadlines.length, patches)
})

test('L39 a second server on the same database exits at start, writing nothing; the first goes on', async (t) => {
  const run = await served(t)
  const e = await open(run)
  const before = (await entries(run)).length
  // Real: another lab process, same database, same cluster.
  await assert.rejects(Server.start({ db: run.db, api: run.c.api, keys: run.c.keys }), /lab exited/)
  assert.equal((await entries(run)).length, before)
  await write(run, e, 'still served')
  const line = await prompt(run)
  await until('the answer', async () => ((await turnOf(run, line)).status === 'done' ? true : null))
})
