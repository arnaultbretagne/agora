// Native sub-agents (docs/specs/log.md, "Native sub-agents"): the sub-agents a harness starts of its own, each a
// read-only sub-stream of the Workstream that announced it. Real bridges and the mock agent, whose `/sub` reports its
// sub-agents as an adapter implementing ACP's "Subagent Sessions" does: announced on the parent's stream, speaking
// under a session id of their own.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { childWorkstream, core, CoreProjection, fold, hash, lastMessageOf, MAX_SUBAGENT_DEPTH, MAX_SUBAGENTS, object, read, type Entry, type ListRow } from '../src/index.ts'
import { exchangesOf } from '../src/catch-up.ts'
import { base64, database, expire, FakeKube, Lab, lines, sleep, until } from './support.ts'

type T = { after(fn: () => Promise<void>): void }

async function started(t: T) {
  const db = await database()
  const keys = generateKeyPairSync('ed25519')
  const kube = new FakeKube(keys.publicKey)
  const lab = await Lab.start({ db, kube, keys })
  t.after(async () => {
    await lab.close()
    await kube.closeAll()
    await db.drop()
  })
  const ws = await lab.workstream()
  const execution = await lab.open(ws)
  return { lab, db, ws, execution }
}

const sub = (options: Record<string, unknown> = {}) => `/sub ${JSON.stringify(options)}`
/** A thread's objects, each with the kind of object it is: a tool's own `kind` is ACP's. */
const objectsOf = async (lab: Lab, ws: string) => (await lab.workstreams.projections.objects(ws)).map((o) => ({ ...o.object, object: o.kind }) as Record<string, unknown>)
const inOrder = (found: Record<string, unknown>[], by = 'firstPosition') => found.sort((a, b) => (BigInt(String(a[by])) < BigInt(String(b[by])) ? -1 : 1))
const elements = async (lab: Lab, ws: string, type: string) => inOrder((await objectsOf(lab, ws)).filter((o) => o.object === 'element' && o.type === type))
const turnsOf = async (lab: Lab, ws: string) => inOrder((await objectsOf(lab, ws)).filter((o) => o.object === 'turn'), 'requestPosition')
const viewOf = async (lab: Lab, ws: string) => (await objectsOf(lab, ws)).find((o) => o.object === 'workstream')
const rowOf = (lab: Lab, ws: string) => lab.workstreams.projections.row(ws, null) as Promise<(ListRow & { subagent?: string }) | null>
/** What a row counts under it, as plain numbers: the log reads them losslessly. */
const below = async (lab: Lab, ws: string) => {
  const row = await rowOf(lab, ws)
  return row ? { count: Number(row.below.count), live: Number(row.below.live), waiting: Number(row.below.waiting) } : null
}
const textsOf = (found: Record<string, unknown>[]) => found.map((e) => String(e.text ?? ''))
const textOf = (found: Record<string, unknown>[]) => textsOf(found).join('')
/** The native sub-streams a Workstream hosts, as the table says them, in the order they were announced. */
const hosted = async (lab: Lab, ws: string) => {
  const rows = (await lab.store.writer.query('SELECT id, parent, depth, host FROM workstreams WHERE host=$1', [ws])).rows as { id: string; parent: string; depth: number; host: string }[]
  const announced = lines(await lab.entries(ws), 'in', 'session/update')
    .map((e) => object(object(e.content.params)?.update))
    .filter((u) => u?.sessionUpdate === 'subagent_update')
    .map((u) => childWorkstream(ws, String(u!.sessionId)))
  return rows.sort((a, b) => announced.indexOf(a.id) - announced.indexOf(b.id))
}
/** The ACP session id a sub-stream speaks under. */
const acpOf = async (lab: Lab, ws: string, child: string) =>
  [...new Set(lines(await lab.entries(ws), 'in', 'session/update').map((e) => String(object(object(e.content.params)?.update)?.sessionId ?? '')))].find((id) => id !== '' && childWorkstream(ws, id) === child)!
/** A sub-stream once its view says one of these states. */
const subagent = (lab: Lab, child: string, states: string[], timeoutMs = 15_000) =>
  until(`a sub-agent ${states.join('|')}`, async () => {
    const view = await viewOf(lab, child)
    return view && states.includes(String(view.subagent)) ? view : null
  }, timeoutMs)
/** The projection brought up to the log: `lab.state` reads the log's fold, which runs ahead of the projector. */
const projected = (lab: Lab, ws: string) => lab.workstreams.projections.run(ws)
const oneHosted = (lab: Lab, ws: string, count = 1) => until(`${String(count)} sub-stream(s)`, async () => ((await hosted(lab, ws)).length === count ? hosted(lab, ws) : null))

test('L128 Agora’s initialize: clientCapabilities holds subagents, an empty object, beside fs and terminal', async (t) => {
  const { lab, ws } = await started(t)
  const [initialize] = lines(await lab.entries(ws), 'out', 'initialize')
  assert.deepEqual(object(initialize!.content.params)?.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false, subagents: {} })
})

test('L129 an agent announcing a sub-agent during its turn, then its task, a text, a tool and idle under its own session id: a sub-stream, one level deeper, native; one turn done in its thread; a subagent element in its host’s, none of its text or tool', async (t) => {
  const { lab, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1 }))).accepted)
  const host = await lab.turn(ws, 'done', 20_000)
  const [row] = await oneHosted(lab, ws)
  const acp = await acpOf(lab, ws, row!.id)
  assert.deepEqual([row!.id, row!.parent, row!.depth, row!.host], [childWorkstream(ws, acp), ws, 1, ws])
  await projected(lab, ws)
  const view = await subagent(lab, row!.id, ['idle'])
  assert.deepEqual([view.state, view.subagent, view.title, view.harness, object(view.native)?.host, view.execution], ['native', 'idle', 'Count the files', 'mock', ws, null])
  // Its thread: one turn, opened by its task, with its text and its tool.
  const turns = await turnsOf(lab, row!.id)
  assert.deepEqual(turns.map((turn) => turn.status), ['done'])
  const [task] = await elements(lab, row!.id, 'user')
  assert.deepEqual([task?.from, task?.as, task?.turn, (task?.content as { text: string }[])[0]?.text], [ws, 'parent', turns[0]!.id, 'Count the files, and say how many.'])
  assert.deepEqual(textsOf(await elements(lab, row!.id, 'agent_message_chunk')), ['Working on: Count the files.', 'Done: 7 files.'])
  assert.deepEqual((await elements(lab, row!.id, 'tool')).map((tool) => [tool.title, tool.status, tool.turn]), [['ls -1 | wc -l', 'completed', turns[0]!.id]])
  // Its host's thread: its line at the announcement, and nothing it said or did.
  const [line] = await elements(lab, ws, 'subagent')
  assert.deepEqual([line?.workstream, line?.title, line?.description, line?.state, line?.cancel, line?.turn], [row!.id, 'Count the files', 'general-purpose', 'idle', true, host.id])
  assert.equal(textOf(await elements(lab, ws, 'agent_message_chunk')), 'Sub-agents done.')
  assert.deepEqual(await elements(lab, ws, 'tool'), [])
  assert.deepEqual((await turnsOf(lab, ws)).map((turn) => turn.status), ['done'])
  // Nothing of it among its host's generic elements either.
  assert.deepEqual((await elements(lab, ws, 'acp')).filter((e) => JSON.stringify(e.line).includes(acp)), [])
})

test('L130 a sub-agent’s config_option_update, available_commands_update, usage_update and session_info_update: its host’s settings, commands, usage and title unchanged; the sub-stream’s title the one it gave', async (t) => {
  const { lab, db, ws } = await started(t)
  const before = (await viewOf(lab, ws))!
  assert.ok((await lab.write(ws, sub({ n: 1, settings: true }))).accepted)
  await lab.turn(ws, 'done', 20_000)
  const [row] = await oneHosted(lab, ws)
  await projected(lab, ws)
  const view = await subagent(lab, row!.id, ['idle'])
  assert.equal(view.title, 'Count the files, as it names itself')
  const after = (await viewOf(lab, ws))!
  assert.deepEqual([after.settings, after.commands, after.usage], [before.settings, before.commands, before.usage])
  assert.ok(!JSON.stringify(after).includes('sub-model') && !JSON.stringify(after).includes('sub-only') && !JSON.stringify(after).includes('4242'))
  assert.equal(after.title, sub({ n: 1, settings: true }).slice(0, 80))
  // Captured, not refused: they are in the log, and no diagnostic names them.
  const kinds = lines(await lab.entries(ws), 'in', 'session/update').map((e) => String(object(object(e.content.params)?.update)?.sessionUpdate))
  for (const kind of ['config_option_update', 'available_commands_update', 'usage_update', 'session_info_update']) assert.ok(kinds.includes(kind), kind)
  assert.equal(Number((await db.admin.query('SELECT count(*) FROM diagnostics WHERE workstream=$1', [ws])).rows[0].count), 0)
  // Positive control: its own lines of those kinds do change its view (settings.test.ts, L49).
})

test('L131 a sub-agent announcing one of its own; two announced in one turn: the second’s parent the first’s sub-stream, two levels down; the host’s row counting each under it, those working among its live ones', async (t) => {
  const { lab, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 3, count: 2, nested: true }))).accepted)
  const working = await until('two working under the host', async () => {
    const under = await below(lab, ws)
    return under && under.live >= 2 ? under : null
  })
  assert.ok(working.count >= 2)
  await lab.turn(ws, 'done', 30_000)
  const rows = await oneHosted(lab, ws, 4)
  await projected(lab, ws)
  const top = rows.filter((r) => r.parent === ws)
  const lower = rows.filter((r) => r.parent !== ws)
  assert.deepEqual([top.length, lower.length], [2, 2])
  assert.deepEqual(lower.map((r) => [top.some((p) => p.id === r.parent), r.depth, r.host]), [[true, 2, ws], [true, 2, ws]])
  // Each one's line in its parent's thread: two in the host's, one in each first-level sub-stream's.
  assert.equal((await elements(lab, ws, 'subagent')).length, 2)
  for (const parent of top) assert.deepEqual((await elements(lab, parent.id, 'subagent')).map((line) => lower.some((r) => r.id === line.workstream)), [true])
  const done = await until('none live under the host', async () => {
    const under = await below(lab, ws)
    return under && under.live === 0 ? under : null
  })
  assert.deepEqual(done, { count: 4, live: 0, waiting: 0 })
  assert.equal((await below(lab, top[0]!.id))?.count, 1)
})

test('L132 a sub-agent asking a permission; Respond to a permission addressed to the sub-stream, then to its host: waiting, counted among those waiting; native, nothing sent; the answer on its host’s execution, then working', async (t) => {
  const { lab, ws, execution } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1, permission: true }))).accepted)
  const [row] = await oneHosted(lab, ws)
  await subagent(lab, row!.id, ['waiting'])
  const [permission] = await until('its permission', async () => {
    const found = await elements(lab, row!.id, 'permission')
    return found.length > 0 ? found : null
  })
  assert.deepEqual([permission!.status, permission!.execution], ['pending', execution.id])
  assert.deepEqual(await elements(lab, ws, 'permission'), [], 'not in its host’s thread')
  assert.equal((await rowOf(lab, row!.id))?.subagent, 'waiting')
  await until('its host counts it waiting', async () => (await below(lab, ws))?.waiting === 1)
  const target = { execution: execution.id, session: permission!.session, requestPosition: permission!.requestPosition }
  const body = { requestId: permission!.requestId, outcome: { outcome: 'selected', optionId: 'allow-once' } }
  const answers = async () => (await lab.entries(ws)).filter((e) => e.kind === 'acp' && e.direction === 'out' && e.correlated_method === 'session/request_permission').length
  assert.deepEqual(await lab.command(row!.id, 'RespondPermission', target, body), { accepted: false, reason: 'native' })
  assert.equal(await answers(), 0)
  assert.ok((await lab.command(ws, 'RespondPermission', target, body)).accepted)
  await subagent(lab, row!.id, ['working', 'idle'])
  assert.equal(await answers(), 1)
  await lab.turn(ws, 'done', 20_000)
  await subagent(lab, row!.id, ['idle'])
  assert.equal((await elements(lab, row!.id, 'permission'))[0]?.status, 'answered')
  await until('nothing waits under its host', async () => (await below(lab, ws))?.waiting === 0)
})

test('L133 Cancel on a sub-stream’s turn in progress, cancel advertised; with none advertised; on a turn already ended: one session/cancel naming its ACP session, its turn cancelled, the host’s going on; stale_turn, no line; stale_turn', async (t) => {
  const { lab, ws, execution } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 20 }))).accepted)
  const [row] = await oneHosted(lab, ws)
  await subagent(lab, row!.id, ['working'])
  const turn = (await turnsOf(lab, row!.id))[0]!
  const cancels = async () => lines(await lab.entries(ws), 'out', 'session/cancel').map((e) => object(e.content.params)?.sessionId)
  assert.ok((await lab.command(ws, 'Cancel', { execution: execution.id, turn: turn.id })).accepted)
  const view = await subagent(lab, row!.id, ['cancelled'])
  assert.equal(view.subagent, 'cancelled')
  assert.deepEqual(await cancels(), [await acpOf(lab, ws, row!.id)])
  assert.deepEqual((await turnsOf(lab, row!.id)).map((x) => x.status), ['cancelled'])
  // Its host's turn went on to its own end, and holds nothing back.
  const host = await lab.turn(ws, 'done', 20_000)
  assert.equal(host.status, 'done')
  assert.equal((await lab.state(ws)).held, false)
  await projected(lab, ws)
  // A turn already ended.
  assert.deepEqual(await lab.command(ws, 'Cancel', { execution: execution.id, turn: turn.id }), { accepted: false, reason: 'stale_turn' })
  // None advertised.
  assert.ok((await lab.write(ws, sub({ n: 3, cancel: false }))).accepted)
  const rows = await oneHosted(lab, ws, 2)
  await subagent(lab, rows[1]!.id, ['working'])
  assert.equal(object((await viewOf(lab, rows[1]!.id))?.native)?.cancel, false)
  assert.deepEqual(await lab.command(ws, 'Cancel', { execution: execution.id, turn: (await turnsOf(lab, rows[1]!.id))[0]!.id }), { accepted: false, reason: 'stale_turn' })
  assert.equal((await cancels()).length, 1, 'no line')
  await lab.turn(ws, 'done', 20_000)
})

test('L134 a sub-agent idle, then running again, then idle; one answering idle with stopReason error: two turns in its thread, each done; a turn failed, with the error’s message', async (t) => {
  const { lab, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1, again: true }))).accepted)
  await lab.turn(ws, 'done', 20_000)
  const [first] = await oneHosted(lab, ws)
  await until('its two turns', async () => (await turnsOf(lab, first!.id)).length === 2 && (await viewOf(lab, first!.id))?.subagent === 'idle')
  assert.deepEqual((await turnsOf(lab, first!.id)).map((turn) => turn.status), ['done', 'done'])
  // What it said in its second turn is that turn's.
  const second = (await turnsOf(lab, first!.id))[1]!
  assert.ok((await elements(lab, first!.id, 'agent_message_chunk')).some((e) => e.turn === second.id && String(e.text).includes('One more look.')))
  assert.ok((await lab.write(ws, sub({ n: 1, error: true }))).accepted)
  await lab.turn(ws, 'done', 20_000)
  const rows = await oneHosted(lab, ws, 2)
  await projected(lab, ws)
  const view = await subagent(lab, rows[1]!.id, ['failed'])
  assert.equal(view.subagent, 'failed')
  const [failed] = await turnsOf(lab, rows[1]!.id)
  assert.deepEqual([failed!.status, failed!.failure, failed!.stopReason], ['failed', 'the sub-agent failed', 'error'])
})

test('L135 a sub-agent running as its host’s execution ends; one never saying idle: each turn failed, each sub-stream failed; none counted live under the host', async (t) => {
  const { lab, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1, silent: true }))).accepted)
  await lab.turn(ws, 'done', 20_000)
  assert.ok((await lab.write(ws, sub({ n: 60, background: true }))).accepted)
  await until('the second turn done', async () => (await lab.state(ws)).turns.size === 2 && (await lab.state(ws)).active === null, 20_000)
  const rows = await oneHosted(lab, ws, 2)
  for (const row of rows) await subagent(lab, row.id, ['working'])
  await until('two live under the host', async () => (await below(lab, ws))?.live === 2)
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the host ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  await projected(lab, ws)
  for (const row of rows) {
    const view = await subagent(lab, row.id, ['failed'])
    assert.equal(view.subagent, 'failed')
    assert.deepEqual((await turnsOf(lab, row.id)).map((turn) => turn.status), ['failed'])
  }
  await until('none live under the host', async () => (await below(lab, ws))?.live === 0)
  assert.deepEqual((await elements(lab, ws, 'subagent')).map((line) => line.state), ['failed', 'failed'])
})

test('L136 a message waiting while a sub-agent of the Session has a turn in progress, its agent taking messages into a turn; then the sub-agent idle: no steering line while it works; one once it is idle', async (t) => {
  const { lab, ws, execution } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 3, after: 6 }))).accepted)
  const [row] = await oneHosted(lab, ws)
  await subagent(lab, row!.id, ['working'])
  const steerings = async () => lines(await lab.entries(ws), 'out', '_session/steering').filter((e) => e.rpc_kind === 'request').length
  const e = (await lab.state(ws)).current!
  assert.ok((await lab.command(ws, 'Write', { execution: execution.id, session: e.session }, { prompt: [{ type: 'text', text: 'while it works' }], mayWait: true })).accepted)
  await sleep(1_500)
  assert.equal((await viewOf(lab, row!.id))?.subagent, 'working')
  assert.equal(await steerings(), 0, 'held while the sub-agent works')
  assert.equal((await lab.state(ws)).waiting.length, 1)
  await subagent(lab, row!.id, ['idle'])
  await until('its steering line', async () => (await steerings()) === 1, 10_000)
  assert.equal((await lab.state(ws)).active?.status, 'in_progress', 'the same turn')
  await lab.turn(ws, 'done', 20_000)
  assert.equal((await lab.state(ws)).turns.size, 1)
})

test('L137 a Write, a Configure, a Create and a Stop addressed to a native sub-stream: native each time, nothing written', async (t) => {
  const { lab, ws, execution } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1 }))).accepted)
  await lab.turn(ws, 'done', 20_000)
  const [row] = await oneHosted(lab, ws)
  await projected(lab, ws)
  const e = (await lab.state(ws)).current!
  const refused = { accepted: false, reason: 'native' }
  assert.deepEqual(await lab.command(row!.id, 'Write', { execution: execution.id, session: e.session }, { prompt: [{ type: 'text', text: 'to a sub-agent' }] }), refused)
  assert.deepEqual(await lab.command(row!.id, 'Configure', { execution: execution.id, session: e.session }, { configId: 'model', value: 'mock-large' }), refused)
  assert.deepEqual(await lab.command(row!.id, 'Create', {}, { pool: 'mock-test' }), refused)
  assert.deepEqual(await lab.command(row!.id, 'Stop', { execution: execution.id }), refused)
  assert.equal((await lab.entries(row!.id)).length, 0)
  assert.equal(Number((await lab.store.writer.query('SELECT count(*) FROM commands WHERE workstream=$1', [row!.id])).rows[0].count), 0)
  // Positive control: the same Write addressed to its host is accepted.
  assert.ok((await lab.write(ws, 'to its host')).accepted)
})

test('L139 a rebuild of a host with native sub-streams, their objects gone; then a fresh fold going on from its checkpoint: the same sub-streams, identities and rows as the incremental run gave', async (t) => {
  const { lab, db, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1, count: 2, nested: true }))).accepted)
  await lab.turn(ws, 'done', 30_000)
  const rows = await oneHosted(lab, ws, 4)
  await projected(lab, ws)
  for (const row of rows) await subagent(lab, row.id, ['idle'])
  await until('none live under the host', async () => (await below(lab, ws))?.live === 0)
  const snapshot = async () => {
    const out: Record<string, unknown> = {}
    for (const id of [ws, ...rows.map((r) => r.id)]) {
      out[id] = (await lab.workstreams.projections.objects(id)).map((o) => [o.kind, o.id, hash(o.object), o.first_position, o.last_position])
      out[`row:${id}`] = await rowOf(lab, id)
    }
    return out
  }
  const before = await snapshot()
  // With the sub-streams' objects gone: a rebuild produces them, it does not merely leave them.
  await db.admin.query('DELETE FROM objects WHERE workstream = ANY($1::uuid[])', [rows.map((r) => r.id)])
  assert.equal((await lab.workstreams.projections.objects(rows[0]!.id)).length, 0)
  await lab.workstreams.projections.run(ws, core, true)
  assert.deepEqual(await snapshot(), before)
  // Positive control: every thread held objects to compare.
  for (const row of rows) assert.ok((before[row.id] as unknown[]).length >= 4)
  // A fresh process folds up to its checkpoint, then goes on: what follows equals a rebuild of the whole.
  lab.workstreams.projections.forget(ws)
  assert.ok((await lab.write(ws, sub({ n: 1, again: true }))).accepted)
  await until('its second turn done', async () => (await lab.state(ws)).turns.size === 2 && (await lab.state(ws)).active === null, 30_000)
  const all = await oneHosted(lab, ws, 5)
  await projected(lab, ws)
  await subagent(lab, all[4]!.id, ['idle'])
  const whole = async () => Object.fromEntries(await Promise.all([ws, ...all.map((r) => r.id)].map(async (id) => [id, (await lab.workstreams.projections.objects(id)).map((o) => [o.kind, o.id, hash(o.object), o.first_position, o.last_position])])))
  const incremental = await whole()
  await lab.workstreams.projections.run(ws, core, true)
  assert.deepEqual(await whole(), incremental)
})

test('L140 a tool_call_update with a content item of type session: valid; its tool element holds it', async (t) => {
  const { lab, db, ws } = await started(t)
  const acp = (await lab.state(ws)).current!.acpId
  const line = (update: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: acp, update } })
  const link = { type: 'session', sessionId: 'a-sub-agent' }
  assert.ok((await lab.write(ws, `/raw ${base64(line({ sessionUpdate: 'tool_call', toolCallId: 'spawn-1', title: 'Agent', kind: 'other', status: 'in_progress' }), line({ sessionUpdate: 'tool_call_update', toolCallId: 'spawn-1', status: 'completed', content: [link] }))}`)).accepted)
  await lab.turn(ws, 'done', 20_000)
  assert.equal(Number((await db.admin.query('SELECT count(*) FROM diagnostics WHERE workstream=$1', [ws])).rows[0].count), 0)
  const [tool] = await until('its tool', async () => {
    const found = await elements(lab, ws, 'tool')
    return found.length > 0 && found[0]!.status === 'completed' ? found : null
  })
  assert.deepEqual(tool!.content, [link])
  // Positive control: a content item of a type nobody knows is still refused.
  assert.ok((await lab.write(ws, `/raw ${base64(line({ sessionUpdate: 'tool_call_update', toolCallId: 'spawn-1', status: 'completed', content: [{ type: 'nonsense' }] }))}`)).accepted)
  await until('its diagnostic', async () => Number((await db.admin.query("SELECT count(*) FROM diagnostics WHERE workstream=$1 AND reason='invalid_body'", [ws])).rows[0].count) === 1, 20_000)
})

test('L141 lines naming a session id never announced; an agent announcing nothing: elements of the host’s turn, as before; no sub-stream', async (t) => {
  const { lab, ws } = await started(t)
  const stray = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'never-announced', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'from nowhere' } } } })
  // A `subagent_update` on a session Agora does not know announces nothing either.
  const orphan = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'never-announced', update: { sessionUpdate: 'subagent_update', sessionId: 'its-child', title: 'Nobody’s' } } })
  assert.ok((await lab.write(ws, `/raw ${base64(stray, orphan)}`)).accepted)
  const turn = await lab.turn(ws, 'done', 20_000)
  await until('its text projected', async () => textOf(await elements(lab, ws, 'agent_message_chunk')).includes('from nowhere'))
  assert.ok((await elements(lab, ws, 'agent_message_chunk')).every((e) => e.turn === turn.id))
  assert.ok((await elements(lab, ws, 'acp')).some((e) => JSON.stringify(e.line).includes('its-child')), 'kept as a generic element of its host')
  assert.ok((await lab.write(ws, '/sleep 1')).accepted)
  await until('its second turn done', async () => (await lab.state(ws)).turns.size === 2 && (await lab.state(ws)).active === null, 20_000)
  assert.deepEqual(await hosted(lab, ws), [])
  assert.deepEqual(await elements(lab, ws, 'subagent'), [])
})

test('S15 a native sub-stream’s transcript, read; one with no task: its task under a parent header, then its text and its tools; no first header', async (t) => {
  const { lab, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1 }))).accepted)
  await lab.turn(ws, 'done', 20_000)
  const [row] = await oneHosted(lab, ws)
  await projected(lab, ws)
  await subagent(lab, row!.id, ['idle'])
  const transcript = async (id: string) => (await read(lab.store.projector, id, 1, 100)).lines.map((l) => [l.kind, l.text])
  const own = await transcript(row!.id)
  assert.match(String(own[0]![1]), /^## 1 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · parent$/)
  assert.deepEqual(own.slice(1), [
    ['user', 'Count the files, and say how many.'],
    ['header', '## 1 · agent'],
    ['agent', 'Working on: Count the files.'],
    ['tool', '[tool: ls -1 | wc -l]'],
    ['agent', 'Done: 7 files.'],
  ])
  // Its host's transcript holds none of it.
  assert.ok(!(await transcript(ws)).some(([, text]) => /Count the files\.|7 files|wc -l/.test(String(text))))
  // No task reported, as Codex: its turn opens on the agent's header.
  assert.ok((await lab.write(ws, sub({ n: 1, task: false }))).accepted)
  await until('its second turn done', async () => (await lab.state(ws)).turns.size === 2 && (await lab.state(ws)).active === null, 20_000)
  const rows = await oneHosted(lab, ws, 2)
  await projected(lab, ws)
  await subagent(lab, rows[1]!.id, ['idle'])
  assert.deepEqual((await transcript(rows[1]!.id))[0], ['header', '## 1 · agent'])
})

test('L133 a sub-agent cancelled, a permission of its own pending beside another’s; then its host’s turn cancelled: cancelled answered to that sub-agent’s alone; none of its sub-agents’ on the host’s Cancel', async (t) => {
  const { lab, ws, execution } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 30, count: 2, permission: true }))).accepted)
  const rows = await oneHosted(lab, ws, 2)
  for (const row of rows) await subagent(lab, row.id, ['waiting'])
  const pending = async (child: string) => (await elements(lab, child, 'permission'))[0]
  await until('both permissions', async () => (await pending(rows[0]!.id)) !== undefined && (await pending(rows[1]!.id)) !== undefined)
  assert.ok((await lab.command(ws, 'Cancel', { execution: execution.id, turn: (await turnsOf(lab, rows[0]!.id))[0]!.id })).accepted)
  await subagent(lab, rows[0]!.id, ['cancelled'])
  await until('its permission answered', async () => (await pending(rows[0]!.id))?.status === 'answered')
  assert.match(JSON.stringify((await pending(rows[0]!.id))?.answer), /cancelled/)
  assert.equal((await pending(rows[1]!.id))?.status, 'pending', 'the other’s untouched')
  // The host's own turn cancelled: its Session's permissions, none of its sub-agents'.
  const turn = (await lab.state(ws)).active!
  assert.ok((await lab.command(ws, 'Cancel', { execution: execution.id, turn: turn.id })).accepted)
  await lab.turn(ws, 'cancelled', 20_000)
  await sleep(800)
  await projected(lab, ws)
  assert.equal((await pending(rows[1]!.id))?.status, 'pending')
  assert.equal((await viewOf(lab, rows[1]!.id))?.subagent, 'waiting')
})

test('L143 a sub-agent idle with a permission of its own left pending: answered cancelled by Agora; its host takes a message again', async (t) => {
  const { lab, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1, permission: true, giveUp: 2 }))).accepted)
  const [row] = await oneHosted(lab, ws)
  await subagent(lab, row!.id, ['waiting'])
  assert.equal((await lab.state(ws)).permissions.size, 1)
  await lab.turn(ws, 'done', 20_000)
  await until('no permission pending in its host', async () => (await lab.state(ws)).permissions.size === 0)
  await projected(lab, ws)
  const [permission] = await elements(lab, row!.id, 'permission')
  assert.equal(permission!.status, 'answered')
  assert.match(JSON.stringify(permission!.answer), /cancelled/)
  assert.equal((await viewOf(lab, row!.id))?.subagent, 'cancelled')
  // Its host is held by nothing: a message goes.
  assert.ok((await lab.write(ws, 'after it gave up')).accepted)
  await until('its second turn done', async () => (await lab.state(ws)).turns.size === 2 && (await lab.state(ws)).active === null, 20_000)
})

test('L144 an agent speaking, announcing a sub-agent, then speaking again: its line between its two texts', async (t) => {
  const { lab, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1, preface: true }))).accepted)
  await lab.turn(ws, 'done', 20_000)
  await projected(lab, ws)
  const own = inOrder((await objectsOf(lab, ws)).filter((o) => o.object === 'element' && ['agent_message_chunk', 'subagent'].includes(String(o.type))))
  assert.deepEqual(own.map((e) => (e.type === 'subagent' ? 'line' : e.text)), ['Starting sub-agents.', 'line', 'Sub-agents done.'])
})

test('L145 a sub-agent at work again under its session id in a later execution: the same sub-stream, a turn of that execution, cancelled through it; ended with it', async (t) => {
  const { lab, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1, id: 'sub-kept' }))).accepted)
  await lab.turn(ws, 'done', 20_000)
  const [row] = await oneHosted(lab, ws)
  await projected(lab, ws)
  await subagent(lab, row!.id, ['idle'])
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the first execution ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  const second = await lab.open(ws)
  assert.ok((await lab.write(ws, sub({ n: 30, id: 'sub-kept' }))).accepted)
  await until('its second turn in progress', async () => (await turnsOf(lab, row!.id)).length === 2 && (await viewOf(lab, row!.id))?.subagent === 'working', 20_000)
  assert.equal((await hosted(lab, ws)).length, 1, 'the same sub-stream')
  const again = (await turnsOf(lab, row!.id))[1]!
  assert.equal(again.execution, second.id)
  // Its host holds messages for it, and its Cancel goes through that execution.
  assert.ok((await lab.command(ws, 'Cancel', { execution: second.id, turn: again.id })).accepted)
  await subagent(lab, row!.id, ['cancelled'])
  await lab.turn(ws, 'done', 20_000)
})

test('L146 more sub-agents announced than a Workstream hosts; a chain deeper than it goes: no sub-stream beyond the bounds, and none of their lines in the host’s thread', async (t) => {
  const { lab, ws } = await started(t)
  const acp = (await lab.state(ws)).current!.acpId!
  const update = (sessionId: string, value: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } })
  const announce = (on: string, id: string) => update(on, { sessionUpdate: 'subagent_update', sessionId: id, title: id, state: { state: 'idle', stopReason: 'end_turn' } })
  const chain = Array.from({ length: MAX_SUBAGENT_DEPTH + 2 }, (_, i) => `deep-${String(i + 1)}`)
  const deepest = chain.at(-1)!
  assert.ok((await lab.write(ws, `/raw ${base64(...chain.map((id, i) => announce(i === 0 ? acp : chain[i - 1]!, id)), update(deepest, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'from too deep' } }))}`)).accepted)
  await lab.turn(ws, 'done', 20_000)
  await projected(lab, ws)
  assert.deepEqual((await hosted(lab, ws)).map((r) => r.depth).sort(), Array.from({ length: MAX_SUBAGENT_DEPTH }, (_, i) => i + 1))
  assert.ok(!JSON.stringify(await objectsOf(lab, ws)).includes('from too deep'), 'not its host’s words either')
  const flat = Array.from({ length: MAX_SUBAGENTS + 2 }, (_, i) => `flat-${String(i + 1)}`)
  assert.ok((await lab.write(ws, `/raw ${base64(...flat.map((id) => announce(acp, id)))}`)).accepted)
  await until('its second turn done', async () => (await lab.state(ws)).turns.size === 2 && (await lab.state(ws)).active === null, 30_000)
  await projected(lab, ws)
  assert.equal((await hosted(lab, ws)).length, MAX_SUBAGENTS)
  assert.equal(Number((await below(lab, ws))?.count), MAX_SUBAGENTS)
})

test('L147 a native sub-stream given as the parent of a new Workstream: unknown_parent', async (t) => {
  const { lab, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1 }))).accepted)
  await lab.turn(ws, 'done', 20_000)
  const [row] = await oneHosted(lab, ws)
  await assert.rejects(lab.store.create(randomUUID(), null, row!.id), /unknown_parent/)
  // Positive control: its host can be one.
  await lab.store.create(randomUUID(), null, ws)
})

test('L148 a sub-agent’s lines among its host’s, read from the log: none of them in the host’s exchange for a catch-up, nor in a delegate’s last message', async (t) => {
  const { lab, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1 }))).accepted)
  const turn = await lab.turn(ws, 'done', 20_000)
  const entries = await lab.entries(ws)
  const children = new Set((await lab.state(ws)).children.keys())
  assert.equal(children.size, 1)
  const [exchange] = exchangesOf(entries, [turn.requestPosition], children)
  assert.equal(exchange!.agent, 'Sub-agents done.')
  assert.equal(lastMessageOf(entries, turn, undefined, children), 'Sub-agents done.')
  // Positive control: read without knowing them, its words and its tool are taken for the host's.
  assert.match(exchangesOf(entries, [turn.requestPosition])[0]!.agent, /Working on: Count the files\.[\s\S]*ls -1 \| wc -l/)
  assert.equal(lastMessageOf(entries, turn, undefined, new Set()), 'Done: 7 files.Sub-agents done.')
})

test('L138 a later execution’s session/load replaying a sub-agent’s announcement and lines: the same sub-stream, no turn added, no object in its thread', async (t) => {
  const { lab, ws } = await started(t)
  assert.ok((await lab.write(ws, sub({ n: 1 }))).accepted)
  await lab.turn(ws, 'done', 20_000)
  const real = [...(await lab.entries(ws))]
  const child = [...(await lab.state(ws)).children.values()][0]!
  // Simulated: the entries a restore by `session/load` would add — its Create, its request, then the lines the adapter
  // replays before its answer, written with no Session, as the capture writes them.
  let position = BigInt(real.at(-1)!.position)
  const next = () => String(++position)
  const create = real.find((e) => e.kind === 'command' && e.content.kind === 'Create')!
  const second = randomUUID()
  const acp = (await lab.state(ws)).current!.acpId!
  const base: Entry = { ...create, kind: 'acp', execution: second, session: null, command: null, direction: 'in', rpc_kind: 'notification', method: 'session/update', correlated_method: null, request_position: null, rpc_id: null, connection: null, receive_ordinal: null, files: null, content: {} }
  const replayed: Entry[] = [
    { ...create, position: next(), execution: second, content: { ...create.content, execution: second, claimName: `claim-${second}` } },
    { ...base, position: next(), direction: 'out', rpc_kind: 'request', method: 'session/load', rpc_id: `agora-${second}-load`, content: { jsonrpc: '2.0', id: `agora-${second}-load`, method: 'session/load', params: { sessionId: acp, cwd: '/', mcpServers: [] } } },
    ...real
      .filter((e) => e.kind === 'acp' && e.direction === 'in' && e.method === 'session/update' && JSON.stringify(e.content).includes(child.acpId))
      .map((e) => ({ ...base, position: next(), content: e.content })),
  ]
  assert.ok(replayed.length > 4)
  const before = fold(real)
  const after = fold([...real, ...replayed])
  assert.deepEqual([...after.children.keys()], [...before.children.keys()])
  const [same] = [...after.children.values()]
  assert.deepEqual([same!.workstream, same!.execution, same!.turns.map((x) => [x.id, x.status])], [child.workstream, child.execution, child.turns.map((x) => [x.id, x.status])])
  const projection = new CoreProjection()
  projection.apply(real)
  const own = () => [...projection.objects.values()].filter((o) => o.workstream === child.workstream).map((o) => [o.id, hash(o.object)])
  const objects = own()
  const changed = projection.apply(replayed)
  assert.deepEqual(own(), objects)
  assert.ok(![...changed].some((id) => projection.objects.get(id)?.workstream === child.workstream))
  // Positive control: the same lines with a Session open are a sub-agent at work again.
  const live = replayed.slice(2).map((e) => ({ ...e, execution: before.current!.id, session: before.current!.session }))
  assert.equal(fold([...real, ...live]).children.get(child.acpId)!.turns.length, 2)
})
