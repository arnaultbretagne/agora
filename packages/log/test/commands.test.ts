// docs/specs/log.md, "Commands" and "A turn's states": admission, deduplication, Cancel and Stop.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { canonical, object, type Entry } from '../src/index.ts'
import { call, lines, opened, sleep, until } from './support.ts'

const texts = (entries: readonly Entry[]) =>
  lines(entries, 'in', 'session/update')
    .map((x) => object(object(object(x.content.params)?.update)?.content)?.text)
    .filter((text): text is string => typeof text === 'string')

test('L6 a Write whose line cannot be inserted is refused, writes nothing and sends nothing', async (t) => {
  const { db, lab, ws, e } = await opened(t)
  assert.ok((await lab.write(ws, 'first words')).accepted)
  await lab.turn(ws, 'done')
  // Simulated: a trigger refuses the insert of any session/prompt line.
  await db.admin.query(`CREATE FUNCTION refuse_prompt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'refused by the test'; END$$`)
  await db.admin.query(`CREATE TRIGGER refuse_prompt BEFORE INSERT ON entries FOR EACH ROW WHEN (NEW.method = 'session/prompt') EXECUTE FUNCTION refuse_prompt()`)
  const before = (await lab.entries(ws)).length
  const commands = Number((await db.admin.query('SELECT count(*) FROM commands WHERE workstream=$1', [ws])).rows[0].count)
  const refused = await call(lab.url, 'POST', `/api/workstreams/${ws}/commands`, {
    id: randomUUID(),
    kind: 'Write',
    target: { execution: e.id, session: e.session },
    body: { prompt: [{ type: 'text', text: 'refused words' }] },
  })
  assert.deepEqual([refused.status, refused.body], [503, { reason: 'unavailable' }])
  assert.equal((await lab.entries(ws)).length, before)
  assert.equal(Number((await db.admin.query('SELECT count(*) FROM commands WHERE workstream=$1', [ws])).rows[0].count), commands)
  await db.admin.query('DROP TRIGGER refuse_prompt ON entries')
  // What reached the agent: it recalls every prompt it was given.
  assert.ok((await lab.write(ws, '/recall')).accepted)
  await lab.turn(ws, 'done')
  const entries = await lab.entries(ws)
  assert.equal(entries.filter((x) => x.kind === 'acp.dispatching').length, entries.filter((x) => x.kind === 'acp' && x.direction === 'out').length)
  const recall = texts(entries).find((text) => text.startsWith('You told me')) ?? ''
  assert.ok(recall.includes('"first words"'))
  assert.ok(!recall.includes('refused words'))
})

test('L9 Write during a turn, then during an uncertain turn, is refused and writes nothing', async (t) => {
  const { db, lab, ws, e } = await opened(t, { relay: true })
  assert.ok((await lab.write(ws, '/silence 6')).accepted)
  await lab.turn(ws, 'in_progress')
  const commands = async () => Number((await db.admin.query('SELECT count(*) FROM commands WHERE workstream=$1', [ws])).rows[0].count)
  let before = [(await lab.entries(ws)).length, await commands()]
  assert.deepEqual(await lab.write(ws, 'too early'), { accepted: false, reason: 'turn_active' })
  assert.deepEqual([(await lab.entries(ws)).length, await commands()], before)
  // Real: the connection is cut under the bridge; the turn becomes uncertain.
  lab.cut()
  await lab.turn(ws, 'uncertain')
  await until('reconnected', async () => {
    const current = (await lab.state(ws)).current
    return current?.connection && lab.executions.connectionOf(e.id) === current.connection
  })
  before = [(await lab.entries(ws)).length, await commands()]
  assert.deepEqual(await lab.write(ws, 'still too early'), { accepted: false, reason: 'turn_uncertain' })
  assert.deepEqual([(await lab.entries(ws)).length, await commands()], before)
})

test('L10 a replayed command returns its first answer; another request under its id conflicts; one of two Writes is accepted', async (t) => {
  const { lab, ws, e } = await opened(t)
  const command = { id: randomUUID(), kind: 'Write' as const, target: { execution: e.id, session: e.session }, body: { prompt: [{ type: 'text', text: 'once' }] } }
  const first = await lab.workstreams.command(ws, command)
  assert.ok(first.accepted)
  const replay = await lab.workstreams.command(ws, structuredClone(command))
  assert.equal(canonical(replay), canonical(first))
  assert.equal((await lab.entries(ws)).filter((x) => x.kind === 'command' && x.command === command.id).length, 1)
  const conflict = await lab.workstreams.command(ws, { ...command, body: { prompt: [{ type: 'text', text: 'other' }] } })
  assert.deepEqual(conflict, { accepted: false, reason: 'command_conflict' })
  await lab.turn(ws, 'done')
  const both = await Promise.all([lab.write(ws, '/silence 1'), lab.write(ws, '/silence 1')])
  assert.equal(both.filter((a) => a.accepted).length, 1)
  assert.deepEqual(both.find((a) => !a.accepted), { accepted: false, reason: 'turn_active' })
  await lab.turn(ws, 'done')
  assert.equal(lines(await lab.entries(ws), 'out', 'session/prompt').length, 2)
})

test('L12 Cancel on an uncertain turn still running sends one session/cancel and the turn ends cancelled', async (t) => {
  const { lab, ws, e } = await opened(t, { relay: true })
  assert.ok((await lab.write(ws, '/sleep 20')).accepted)
  await until('first chunk', async () => texts(await lab.entries(ws)).some((text) => text.includes('second 1/20')))
  lab.cut()
  const turn = await lab.turn(ws, 'uncertain')
  await until('reconnected', async () => {
    const current = (await lab.state(ws)).current
    return current?.connection && lab.executions.connectionOf(e.id) === current.connection
  })
  const cancel = await lab.command(ws, 'Cancel', { execution: e.id, turn: turn.id })
  assert.ok(cancel.accepted)
  const ended = await lab.turn(ws, 'cancelled')
  assert.equal(ended.id, turn.id)
  const entries = await lab.entries(ws)
  const cancels = lines(entries, 'out', 'session/cancel')
  assert.equal(cancels.length, 1)
  assert.equal(cancels[0]!.command, cancel.command)
  assert.equal(entries.filter((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === cancels[0]!.position).length, 1)
  assert.equal(entries.filter((x) => x.kind === 'acp.sent' && x.content.requestPosition === cancels[0]!.position).length, 1)
  assert.ok((await lab.write(ws, 'after the cancel')).accepted)
})

test('L13 a Cancel whose turn ended before its dispatch fails as stopped and sends nothing', async (t) => {
  let release: (() => void) | null = null
  let held: Promise<void> | null = null
  const { lab, ws, e } = await opened(t, {
    workstreams: {
      // Simulated: the dispatcher held at its fault point before the Cancel's marker.
      fault: async (point, detail) => {
        if (point === 'before_marker' && detail.method === 'session/cancel' && held) await held
      },
    },
  })
  assert.ok((await lab.write(ws, '/silence 1')).accepted)
  const turn = await lab.turn(ws, 'in_progress')
  held = new Promise<void>((resolve) => (release = resolve))
  const accepted = lab.command(ws, 'Cancel', { execution: e.id, turn: turn.id })
  const cancelLine = await until('the Cancel written', async () => lines(await lab.entries(ws), 'out', 'session/cancel')[0])
  await until('the answer committed', async () => lines(await lab.entries(ws), 'in', 'session/prompt').length === 1)
  release!()
  assert.ok((await accepted).accepted)
  const failed = await until('request.failed', async () => (await lab.entries(ws)).find((x) => x.kind === 'request.failed' && x.content.requestPosition === cancelLine.position))
  assert.equal(failed.content.reason, 'stopped')
  const entries = await lab.entries(ws)
  assert.equal(entries.filter((x) => ['acp.dispatching', 'acp.sent'].includes(x.kind) && x.content.requestPosition === cancelLine.position).length, 0)
  assert.equal((await lab.state(ws)).turns.get(turn.id)?.status, 'done')
  // The next turn is not cancelled by a late session/cancel.
  assert.ok((await lab.write(ws, '/sleep 2')).accepted)
  const next = await lab.turn(ws, ['done', 'cancelled'])
  assert.deepEqual([next.status, next.stopReason], ['done', 'end_turn'])
})

const renewing = { workstreams: { renewSeconds: 1 } }
const shortLease = { limits: { leaseSeconds: 60 } }

test('L14 control: without Stop, the deadline is renewed during a turn', async (t) => {
  const { lab, ws, e } = await opened(t, renewing, shortLease)
  const before = lab.kube.deadlines.filter((d) => d.name === e.claimName).length
  assert.ok((await lab.write(ws, '/sleep 4')).accepted)
  await lab.turn(ws, 'done', 20_000)
  // The dispatch, at least two renewals during the turn, and the end of the turn.
  assert.ok(lab.kube.deadlines.filter((d) => d.name === e.claimName).length - before >= 4)
})

test('L14 Stop between turns: no dispatch and no renewal afterwards, even after a restart', async (t) => {
  const context = await opened(t, renewing, shortLease)
  const { ws, e } = context
  const lab = () => context.lab
  assert.ok((await lab().write(ws, 'before the stop')).accepted)
  await lab().turn(ws, 'done')
  const stop = await lab().command(ws, 'Stop', { execution: e.id })
  assert.ok(stop.accepted)
  const patches = lab().kube.deadlines.length
  assert.deepEqual(await lab().write(ws, 'after the stop'), { accepted: false, reason: 'stopped' })
  await sleep(1500)
  context.lab = await lab().restart('clean')
  await sleep(1500)
  assert.deepEqual(await lab().write(ws, 'after the restart'), { accepted: false, reason: 'stopped' })
  const entries = await lab().entries(ws)
  assert.equal(entries.filter((x) => x.kind === 'acp.dispatching' && BigInt(x.position) > BigInt(stop.position)).length, 0)
  assert.equal(lab().kube.deadlines.length, patches)
})

test('L14 Stop during a turn: only its session/cancel is dispatched, and no renewal afterwards', async (t) => {
  const { lab, ws, e } = await opened(t, renewing, shortLease)
  assert.ok((await lab.write(ws, '/sleep 10')).accepted)
  await until('first chunk', async () => texts(await lab.entries(ws)).some((text) => text.includes('second 1/10')))
  const stop = await lab.command(ws, 'Stop', { execution: e.id })
  assert.ok(stop.accepted)
  const patches = lab.kube.deadlines.length
  await lab.turn(ws, 'cancelled')
  await sleep(2500)
  const after = (await lab.entries(ws)).filter((x) => BigInt(x.position) > BigInt(stop.position))
  const cancel = lines(after, 'out', 'session/cancel')
  assert.equal(cancel.length, 1)
  assert.equal(cancel[0]!.command, stop.command)
  assert.deepEqual(
    after.filter((x) => x.kind === 'acp.dispatching').map((x) => x.content.requestPosition),
    [cancel[0]!.position],
  )
  assert.equal(lab.kube.deadlines.length, patches)
})

test('L16 session/set_config_option between turns keeps the same Session', async (t) => {
  const { lab, ws, e } = await opened(t)
  const before = (await lab.entries(ws)).length
  const requestId = await lab.workstreams.control(ws, e.id, 'session/set_config_option', { configId: 'model', value: 'lab-model' })
  const answer = await until('its answer', async () => (await lab.entries(ws)).find((x) => x.kind === 'acp' && x.direction === 'in' && x.rpc_id === requestId))
  assert.equal(answer.session, e.session)
  assert.ok((await lab.write(ws, 'after the option')).accepted)
  const turn = await lab.turn(ws, 'done')
  assert.equal(turn.session, e.session)
  const after = (await lab.entries(ws)).slice(before)
  assert.equal(after.filter((x) => x.kind === 'session.opened' || x.kind === 'session.ended').length, 0)
  assert.ok(lines(after, 'out').every((x) => x.session === e.session))
  assert.equal((await lab.state(ws)).current?.session, e.session)
})

test('L37 a permission answered once; a pending one answered cancelled once the Cancel is sent', async (t) => {
  const { lab, ws, e } = await opened(t)
  const pending = (after: string) =>
    until('a pending permission', async () => [...(await lab.state(ws)).permissions.values()].find((x) => BigInt(x.position) > BigInt(after)))
  const respond = (request: Entry) =>
    lab.workstreams.command(ws, {
      id: randomUUID(),
      kind: 'RespondPermission',
      target: { execution: e.id, session: e.session, requestPosition: request.position },
      body: { requestId: request.rpc_id, outcome: { outcome: 'selected', optionId: 'allow-once' } },
    })
  assert.ok((await lab.write(ws, '/permission')).accepted)
  const first = await pending('0')
  assert.ok((await respond(first)).accepted)
  await lab.turn(ws, 'done')
  assert.ok(texts(await lab.entries(ws)).includes('Permission: allow-once.'))
  const answers = (request: Entry) => async () => lines(await lab.entries(ws), 'out').filter((x) => x.request_position === request.position)
  assert.equal((await answers(first)()).length, 1)
  assert.deepEqual(await respond(first), { accepted: false, reason: 'stale_permission' })
  assert.ok((await lab.write(ws, '/permission')).accepted)
  const second = await pending(first.position)
  const turn = await lab.turn(ws, 'in_progress')
  const cancel = await lab.command(ws, 'Cancel', { execution: e.id, turn: turn.id })
  assert.ok(cancel.accepted)
  assert.equal((await lab.turn(ws, 'cancelled')).id, turn.id)
  const entries = await lab.entries(ws)
  const cancelLine = lines(entries, 'out', 'session/cancel').find((x) => x.command === cancel.command)!
  const [answer] = await until('the cancelled answer', async () => {
    const found = await answers(second)()
    return found.length > 0 && found
  })
  assert.equal(object(object(answer!.content.result)?.outcome)?.outcome, 'cancelled')
  assert.ok(BigInt(answer!.position) > BigInt(cancelLine.position))
  for (const line of [cancelLine, answer!])
    await until('sent', async () => (await lab.entries(ws)).some((x) => x.kind === 'acp.sent' && x.content.requestPosition === line.position))
  assert.equal((await answers(second)()).length, 1)
})
