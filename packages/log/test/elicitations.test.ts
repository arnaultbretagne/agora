// Elicitations (docs/specs/log.md, "Requests"): a form an agent asks with `elicitation/create` is a request as a
// permission is — pending in its view and its row, answered once, by whoever answers first, or by Agora: `cancel`
// with its turn's Cancel, `decline` for a form it does not show. Real bridges and the mock agent, whose `/question` and
// `/form` send what claude-agent-acp 0.106.0 and codex-acp 2.6.0 send (packages/mock-agent/src/forms.ts).
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { core, object, type Entry, type ListRow } from '../src/index.ts'
import { declinedBy, contentRefusal, fieldsOf, patternRefusal } from '../src/forms.ts'
import { database, expire, FakeKube, Lab, lines, until } from './support.ts'

type T = { after(fn: () => Promise<void>): void }

async function bench(t: T) {
  const db = await database()
  const keys = generateKeyPairSync('ed25519')
  const kube = new FakeKube(keys.publicKey)
  const lab = await Lab.start({ db, kube, keys })
  t.after(async () => {
    await lab.close()
    await kube.closeAll()
    await db.drop()
  })
  return lab
}

const viewOf = async (lab: Lab, ws: string) => (await lab.workstreams.projections.objects(ws)).find((o) => o.kind === 'workstream')?.object
const rowOf = (lab: Lab, ws: string) => lab.workstreams.projections.row(ws, null) as Promise<(ListRow & { request?: string }) | null>
const elicitations = async (lab: Lab, ws: string) => (await lab.workstreams.projections.objects(ws)).filter((o) => o.kind === 'element' && o.object.type === 'elicitation').map((o) => o.object)
/** The form its agent asks next, once the log holds it. */
const asked = (lab: Lab, ws: string, after = '0') =>
  until('an elicitation', async () => (await lab.entries(ws)).find((x) => x.method === 'elicitation/create' && x.direction === 'in' && BigInt(x.position) > BigInt(after)))
/** What went back to it: the answers written for that request. */
const answersTo = async (lab: Lab, ws: string, request: Entry) => lines(await lab.entries(ws), 'out').filter((x) => x.request_position === request.position).map((x) => x.content.result ?? x.content.error)
const respond = (lab: Lab, ws: string, request: Entry, body: Record<string, unknown>) =>
  lab.command(ws, 'RespondElicitation', { execution: request.execution, session: request.session, requestPosition: request.position }, { requestId: request.rpc_id, ...body })
/** What the mock agent says of the answer it got, as its last message. */
const said = async (lab: Lab, ws: string) => {
  await lab.workstreams.projections.run(ws)
  return (await lab.workstreams.projections.objects(ws)).filter((o) => o.object.type === 'agent_message_chunk').map((o) => String(o.object.text)).at(-1)
}
const settled = (lab: Lab, ws: string, request: string | null) =>
  until(`its view ${request === null ? 'free' : `waiting on ${request}`}`, async () => {
    const [view, row] = [await viewOf(lab, ws), await rowOf(lab, ws)]
    return (view?.request ?? null) === request && (row?.request ?? null) === request ? { view, row } : null
  })

test('L160 Agora’s initialize declares form elicitation, and no url', async (t) => {
  const lab = await bench(t)
  const ws = await lab.workstream()
  await lab.open(ws)
  const [initialize] = lines(await lab.entries(ws), 'out', 'initialize')
  assert.deepEqual(object(object(initialize!.content.params)?.clientCapabilities)?.elicitation, { form: {} })
})

test('L161 Claude Code’s AskUserQuestion as a form, pending, then accepted: an elicitation element pending on its tool call; its view’s and row’s request; a message meanwhile refused; accepted with what fits: one answer, its content; the agent given it; answered, no request', async (t) => {
  const lab = await bench(t)
  const ws = await lab.workstream()
  await lab.open(ws)
  assert.ok((await lab.write(ws, '/question')).accepted)
  const form = await asked(lab, ws)
  assert.equal(object(form.content.params)?.toolCallId !== undefined, true)
  await settled(lab, ws, form.position)
  const [pending] = await until('its element', async () => ((await elicitations(lab, ws)).length > 0 ? elicitations(lab, ws) : null))
  assert.deepEqual([pending?.status, pending?.requestPosition, object(pending?.params)?.message], ['pending', form.position, 'Which database should the service use?'])
  assert.equal(pending?.declined, undefined)
  // A message meanwhile is refused, as while a permission is pending.
  const e = (await lab.state(ws)).current!
  assert.deepEqual(await lab.command(ws, 'Write', { execution: e.id, session: e.session }, { prompt: [{ type: 'text', text: 'meanwhile' }], mayWait: true }), { accepted: false, reason: 'permission_pending' })
  const content = { question_0: 'SQLite', question_0_custom: 'for the tests only' }
  assert.ok((await respond(lab, ws, form, { action: 'accept', content })).accepted)
  await until('its answer said', async () => (await said(lab, ws))?.startsWith('Elicitation:'))
  assert.deepEqual(await answersTo(lab, ws, form), [{ action: 'accept', content }])
  assert.equal(await said(lab, ws), `Elicitation: accept ${JSON.stringify(content)}.`)
  await settled(lab, ws, null)
  const [answered] = await elicitations(lab, ws)
  assert.deepEqual([answered?.status, answered?.answer], ['answered', { action: 'accept', content }])
})

test('L162 RespondElicitation: an option the form does not offer, a field it does not have, a text for a list, a required field left out, an action it does not take; a permission’s Respond on it; then declined, then answered again: invalid_elicitation_content each time, nothing written; stale_permission; one decline; stale_elicitation', async (t) => {
  const lab = await bench(t)
  const ws = await lab.workstream()
  await lab.open(ws)
  assert.ok((await lab.write(ws, '/form several')).accepted)
  const form = await asked(lab, ws)
  const refused = { accepted: false, reason: 'invalid_elicitation_content' }
  for (const body of [
    { action: 'accept', content: { environment: 'Moon', branch: 'main' } },
    { action: 'accept', content: { environment: 'Staging', branch: 'main', region: 'eu' } },
    { action: 'accept', content: { environment: ['Staging'], branch: 'main' } },
    { action: 'accept', content: { environment: 'Staging' } },
    { action: 'cancel' },
    { action: 'decline', content: { environment: 'Staging' } },
  ])
    assert.deepEqual(await respond(lab, ws, form, body), refused, JSON.stringify(body))
  const e = (await lab.state(ws)).current!
  assert.deepEqual(
    await lab.command(ws, 'RespondPermission', { execution: e.id, session: form.session, requestPosition: form.position }, { requestId: form.rpc_id, outcome: { outcome: 'selected', optionId: 'Staging' } }),
    { accepted: false, reason: 'stale_permission' },
  )
  assert.deepEqual(await answersTo(lab, ws, form), [], 'nothing written')
  assert.ok((await respond(lab, ws, form, { action: 'decline' })).accepted)
  await lab.turn(ws, 'done')
  assert.deepEqual(await respond(lab, ws, form, { action: 'accept', content: { environment: 'Staging', branch: 'main' } }), { accepted: false, reason: 'stale_elicitation' })
  assert.deepEqual(await answersTo(lab, ws, form), [{ action: 'decline' }])
  assert.equal(await said(lab, ws), 'Elicitation: decline.')
})

test('L163 a form pending when its turn is cancelled; another when its execution ends: Agora answers the first cancel, once; the second projected cancelled, no answer written — no peer left to read one —; neither pending after', async (t) => {
  const lab = await bench(t)
  const ws = await lab.workstream()
  const e = await lab.open(ws)
  assert.ok((await lab.write(ws, '/question several')).accepted)
  const one = await asked(lab, ws)
  await settled(lab, ws, one.position)
  const turn = await lab.turn(ws, 'in_progress')
  assert.ok((await lab.command(ws, 'Cancel', { execution: e.id, turn: turn.id })).accepted)
  await lab.turn(ws, 'cancelled')
  await settled(lab, ws, null)
  assert.deepEqual(await answersTo(lab, ws, one), [{ action: 'cancel' }])
  assert.deepEqual((await elicitations(lab, ws)).find((x) => x.requestPosition === one.position)?.answer, { action: 'cancel' })
  assert.ok((await lab.write(ws, '/form')).accepted)
  const two = await asked(lab, ws, one.position)
  await settled(lab, ws, two.position)
  await expire(lab.kube, e.claimName)
  await until('its execution ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  await settled(lab, ws, null)
  assert.deepEqual(await answersTo(lab, ws, two), [])
  assert.equal((await elicitations(lab, ws)).find((x) => x.requestPosition === two.position)?.status, 'cancelled')
})

test('L164 Codex’s form with a secret field: declined by Agora at once, one answer; its element says why; never the view’s request; a Respond to it stale; and which forms Agora declines', async (t) => {
  const lab = await bench(t)
  const ws = await lab.workstream()
  await lab.open(ws)
  assert.ok((await lab.write(ws, '/form secret')).accepted)
  const form = await asked(lab, ws)
  await lab.turn(ws, 'done')
  assert.deepEqual(await answersTo(lab, ws, form), [{ action: 'decline' }])
  assert.equal(await said(lab, ws), 'Elicitation: decline.')
  const [element] = await elicitations(lab, ws)
  assert.deepEqual([element?.declined, element?.status, element?.answer], ['secret', 'answered', { action: 'decline' }])
  assert.equal((await viewOf(lab, ws))?.request, undefined)
  assert.deepEqual(await respond(lab, ws, form, { action: 'accept', content: { token: 'x' } }), { accepted: false, reason: 'stale_elicitation' })
  // Which: not a form; an async question; a secret field; a plain form.
  const field = { type: 'string', title: 'Q' }
  assert.equal(declinedBy({ mode: 'url', url: 'https://example.org', elicitationId: 'e' }), 'mode')
  assert.equal(declinedBy({ mode: 'form', requestedSchema: { type: 'object', properties: { q: field } }, _meta: { codex: { delivery: 'async' } } }), 'async')
  assert.equal(declinedBy({ mode: 'form', requestedSchema: { type: 'object', properties: { q: { ...field, _meta: { codex: { isSecret: true } } } } } }), 'secret')
  assert.equal(declinedBy({ mode: 'form', requestedSchema: { type: 'object', properties: { q: field } } }), null)
})

test('L165 a form its agent withdraws (`$/cancel_request`), as Codex past its autoResolutionMs: one answer, cancel; pending no more, no request; a Write accepted after its turn', async (t) => {
  const lab = await bench(t)
  const ws = await lab.workstream()
  await lab.open(ws)
  assert.ok((await lab.write(ws, '/form auto')).accepted)
  const form = await asked(lab, ws)
  await settled(lab, ws, form.position)
  await lab.turn(ws, 'done')
  await until('its answer', async () => (await answersTo(lab, ws, form)).length > 0)
  await settled(lab, ws, null)
  assert.deepEqual(await answersTo(lab, ws, form), [{ action: 'cancel' }])
  assert.equal((await lab.state(ws)).permissions.size, 0)
  assert.deepEqual((await elicitations(lab, ws))[0]?.answer, { action: 'cancel' })
  assert.ok((await lab.write(ws, 'after it')).accepted)
})

test('L168 Agora started once its core projector changed version, a form pending, its connection closed before and not open again, its objects as the version before left them — the form an `acp` line, no request —: rebuilt at start, no new connection: its `elicitation` element pending, its view’s and its row’s request; its checkpoint at the new version', async (t) => {
  const db = await database()
  const keys = generateKeyPairSync('ed25519')
  const kube = new FakeKube(keys.publicKey)
  let lab = await Lab.start({ db, kube, keys })
  t.after(async () => {
    await lab.close()
    await kube.closeAll()
    await db.drop()
  })
  const ws = await lab.workstream()
  await lab.open(ws)
  assert.ok((await lab.write(ws, '/question several')).accepted)
  const form = await asked(lab, ws)
  await settled(lab, ws, form.position)
  // Stopped cleanly, everything projected; then as version 10 left it: the form no element of its own, no request.
  await lab.workstreams.stop()
  await lab.workstreams.projections.run(ws)
  const connected = (await lab.entries(ws)).filter((x) => x.kind === 'execution.connected').length
  await db.admin.query("UPDATE checkpoints SET version='10' WHERE projector='core' AND workstream=$1", [ws])
  await db.admin.query("UPDATE objects SET object=jsonb_build_object('type','acp','line',object->'params'), type='acp' WHERE workstream=$1 AND kind='element' AND object->>'type'='elicitation'", [ws])
  await db.admin.query("UPDATE objects SET object=object - 'request' WHERE workstream=$1 AND kind='workstream'", [ws])
  await db.admin.query(`UPDATE listings SET "row"="row" - 'request' WHERE workstream=$1`, [ws])
  lab = await lab.restart('halt', { executions: { bridgeAddress: () => '127.0.0.1:9' } })
  const view = await until('rebuilt', async () => {
    const found = await viewOf(lab, ws)
    return found?.request !== undefined ? found : null
  }, 10_000)
  assert.equal(view.request, form.position)
  assert.equal((await rowOf(lab, ws))?.request, form.position)
  const [element] = await elicitations(lab, ws)
  assert.deepEqual([element?.status, element?.requestPosition], ['pending', form.position])
  const { rows } = await db.admin.query("SELECT version FROM checkpoints WHERE projector='core' AND workstream=$1", [ws])
  assert.equal(rows[0].version, core.version)
  assert.equal((await lab.entries(ws)).filter((x) => x.kind === 'execution.connected').length, connected, 'no new connection')
})

test('L166 a form’s fields, in order, and what fits them: a number within its bounds, a yes/no, options, a list of options, required fields', () => {
  const params = {
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: {
        replicas: { type: 'integer', minimum: 1, maximum: 5 },
        canary: { type: 'boolean' },
        db: { type: 'string', oneOf: [{ const: 'pg', title: 'PostgreSQL' }] },
        checks: { type: 'array', items: { anyOf: [{ const: 'lint', title: 'Lint' }, { const: 'test', title: 'Tests' }] } },
      },
      required: ['replicas'],
    },
  }
  assert.deepEqual(fieldsOf(params).map((f) => [f.key, f.type, f.required, f.options?.map((o) => o.value) ?? null]), [
    // The required first, then the others by name: the log keeps no member order.
    ['replicas', 'integer', true, null],
    ['canary', 'boolean', false, null],
    ['checks', 'array', false, ['lint', 'test']],
    ['db', 'string', false, ['pg']],
  ])
  assert.equal(contentRefusal(params, { replicas: 3, canary: true, db: 'pg', checks: ['lint', 'test'] }), null)
  assert.equal(contentRefusal(params, { replicas: 6 }), 'replicas: out of bounds')
  assert.equal(contentRefusal(params, { replicas: 2.5 }), 'replicas: not an integer')
  assert.equal(contentRefusal(params, { replicas: 1, canary: 'yes' }), 'canary: not true or false')
  assert.equal(contentRefusal(params, { replicas: 1, db: 'mysql' }), 'db: "mysql" is not one of its options')
  assert.equal(contentRefusal(params, { replicas: 1, checks: ['lint', 'deploy'] }), 'checks: "deploy" is not one of its options')
  assert.equal(contentRefusal(params, { canary: false }), 'replicas: required')
  assert.equal(contentRefusal(params, []), 'not an object')
})

// The person answering in the delegate's thread uses the same command (docs/specs/assistant-ui.md, "Answering"):
// covered by the client's cases. A Respond naming who answers is Agora's alone to keep, as for a permission.
test('L167 a RespondElicitation whose body names a `from`: Agora’s, kept and on the elicitation answered; the person’s, left out', async (t) => {
  const lab = await bench(t)
  const ws = await lab.workstream()
  await lab.open(ws)
  const from = { workstream: randomUUID(), as: 'delegator' }
  assert.ok((await lab.write(ws, '/form text')).accepted)
  const one = await asked(lab, ws)
  const answer = (request: Entry, origin: 'person' | 'agora') =>
    lab.workstreams.command(
      ws,
      { id: randomUUID(), kind: 'RespondElicitation', target: { execution: request.execution, session: request.session, requestPosition: request.position }, body: { requestId: request.rpc_id, action: 'accept', content: { branch: 'main' }, from } },
      origin,
    )
  assert.ok((await answer(one, 'agora')).accepted)
  await lab.turn(ws, 'done')
  assert.ok((await lab.write(ws, '/form text')).accepted)
  const two = await asked(lab, ws, one.position)
  assert.ok((await answer(two, 'person')).accepted)
  await lab.turn(ws, 'done')
  const responds = (await lab.entries(ws)).filter((x) => x.kind === 'command' && x.content.kind === 'RespondElicitation')
  assert.deepEqual(responds.map((x) => object(x.content.body)?.from), [from, undefined])
  await lab.workstreams.projections.run(ws)
  const answered = (await elicitations(lab, ws)).sort((a, b) => Number(a.requestPosition) - Number(b.requestPosition))
  assert.deepEqual(answered.map((x) => [x.from, x.as]), [[from.workstream, 'delegator'], [undefined, undefined]])
})

test('L169 a text against its schema: its length in code points, its format, its pattern; a pattern that runs away, cut in a worker, the server’s thread free meanwhile; one that is no regular expression', async () => {
  const params = {
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: {
        emoji: { type: 'string', maxLength: 1 },
        word: { type: 'string', minLength: 2, maxLength: 3 },
        email: { type: 'string', format: 'email' },
        site: { type: 'string', format: 'uri' },
        day: { type: 'string', format: 'date' },
        at: { type: 'string', format: 'date-time' },
        ticket: { type: 'string', pattern: '^[A-Z]+-[0-9]+$' },
      },
    },
  }
  // Code points, not UTF-16 units: one emoji is one.
  assert.equal(contentRefusal(params, { emoji: '😀' }), null)
  assert.equal(contentRefusal(params, { emoji: '😀😀' }), 'emoji: its length is out of bounds')
  assert.equal(contentRefusal(params, { word: '😀😀' }), null)
  assert.equal(contentRefusal(params, { word: 'abcd' }), 'word: its length is out of bounds')
  assert.equal(contentRefusal(params, { email: 'person@example.org', site: 'https://example.org/a', day: '2026-11-16', at: '2026-11-16T10:00:00Z' }), null)
  assert.equal(contentRefusal(params, { email: 'not-an-email' }), 'email: not an email')
  assert.equal(contentRefusal(params, { site: 'nowhere' }), 'site: not a uri')
  assert.equal(contentRefusal(params, { day: '16/11/2026' }), 'day: not a date')
  assert.equal(contentRefusal(params, { at: '2026-11-16' }), 'at: not a date-time')
  assert.equal(await patternRefusal(params, { ticket: 'PROJ-123' }), null)
  assert.equal(await patternRefusal(params, { ticket: 'oops' }), 'ticket: does not match its pattern')
  assert.equal(await patternRefusal(params, { email: 'x' }), null, 'no pattern, no worker')
  // A pattern that runs away: refused once its time is out, the server's own timers firing all along.
  const runaway = { mode: 'form', requestedSchema: { type: 'object', properties: { x: { type: 'string', pattern: '^(a+)+$' } } } }
  let ticks = 0
  const timer = setInterval(() => ticks++, 50)
  const started = Date.now()
  const answer = await patternRefusal(runaway, { x: `${'a'.repeat(40)}!` })
  clearInterval(timer)
  assert.equal(answer, 'x: its pattern could not be checked in time')
  assert.ok(Date.now() - started < 3_000, 'cut in time')
  assert.ok(ticks >= 10, `the server's thread free meanwhile: ${String(ticks)} ticks`)
  const broken = { mode: 'form', requestedSchema: { type: 'object', properties: { x: { type: 'string', pattern: '(' } } } }
  assert.equal(await patternRefusal(broken, { x: 'a' }), 'x: its pattern is no regular expression')
})

test('L170 Respond to an elicitation on an MCP server’s form of a pattern and an email: a text not matching, an email that is none: invalid_elicitation_content, nothing written; then fitting: one answer', async (t) => {
  const lab = await bench(t)
  const ws = await lab.workstream()
  await lab.open(ws)
  assert.ok((await lab.write(ws, '/question ticket')).accepted)
  const form = await asked(lab, ws)
  const refused = { accepted: false, reason: 'invalid_elicitation_content' }
  assert.deepEqual(await respond(lab, ws, form, { action: 'accept', content: { ticket: 'oops' } }), refused)
  assert.deepEqual(await respond(lab, ws, form, { action: 'accept', content: { ticket: 'PROJ-1', email: 'not-an-email' } }), refused)
  assert.deepEqual(await answersTo(lab, ws, form), [], 'nothing written')
  assert.ok((await respond(lab, ws, form, { action: 'accept', content: { ticket: 'PROJ-1', email: 'person@example.org' } })).accepted)
  await until('its answer said', async () => (await said(lab, ws))?.startsWith('Elicitation:'))
  assert.deepEqual(await answersTo(lab, ws, form), [{ action: 'accept', content: { email: 'person@example.org', ticket: 'PROJ-1' } }])
})

test('L171 a form its agent withdraws, Agora’s cancel answer’s write failing once, its connection to PostgreSQL cut before its COMMIT: the answer written and sent once, at the next run; the form pending no more; its turn going on to its end', async (t) => {
  const db = await database()
  const keys = generateKeyPairSync('ed25519')
  const kube = new FakeKube(keys.publicKey)
  const lab = await Lab.start({ db, kube, keys, pgRelay: true })
  t.after(async () => {
    await lab.close()
    await kube.closeAll()
    await db.drop()
  })
  const ws = await lab.workstream()
  await lab.open(ws)
  // The first transaction writing Agora's `cancel` answer is rolled back.
  lab.pg!.failCommit('"action":"cancel"')
  assert.ok((await lab.write(ws, '/form auto')).accepted)
  const form = await asked(lab, ws)
  await lab.turn(ws, 'done', 20_000)
  await until('its answer', async () => (await answersTo(lab, ws, form)).length > 0, 20_000)
  assert.equal(lab.pg!.failed, 1, 'the first write failed')
  const entries = await lab.entries(ws)
  const answers = lines(entries, 'out').filter((x) => x.request_position === form.position)
  assert.deepEqual(answers.map((x) => x.content.result), [{ action: 'cancel' }])
  await until('sent', async () => (await lab.entries(ws)).filter((x) => x.kind === 'acp.sent' && x.content.requestPosition === answers[0]!.position).length === 1)
  await settled(lab, ws, null)
  assert.equal((await lab.state(ws)).permissions.size, 0)
})
