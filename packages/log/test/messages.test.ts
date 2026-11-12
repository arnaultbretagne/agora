// docs/specs/log.md, "Messages during a turn": a message written during a turn waits in the log, then goes into the
// running turn when the agent can take it there, as the next turn otherwise. Real bridges, the mock agent.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { keys, mockBridge } from '@agora/testkit'
import { catchUpText, exchangesOf } from '../src/catch-up.ts'
import { object, type Entry } from '../src/index.ts'
import { database, expire, FakeKube, Lab, lines, opened, sleep, until, type LabOptions } from './support.ts'

/** An agent that does not say `_meta.steering.supported`, as opencode. */
const noSteering = () => {
  const own = keys()
  const kube = new FakeKube(own.publicKey)
  kube.bridgeFactory = (publicKey, pod) => mockBridge(publicKey, pod, { noSteering: true })
  return { kube, keys: own }
}

const text = (t: string) => [{ type: 'text', text: t }]
/** A Write that may wait, as the client sends one. */
const say = async (lab: Lab, ws: string, words: string, blocks: unknown[] = text(words)) => {
  const e = (await lab.state(ws)).current!
  return lab.command(ws, 'Write', { execution: e.id, session: e.session }, { prompt: blocks, mayWait: true })
}
const steerings = (entries: readonly Entry[]) => lines(entries, 'out', '_session/steering')
const prompts = (entries: readonly Entry[]) => lines(entries, 'out', 'session/prompt')
const promptText = (x: Entry) => {
  const blocks = object(x.content.params)?.prompt
  return (Array.isArray(blocks) ? blocks : []).map((b) => object(b)).filter((b) => b?.type === 'text').map((b) => String(b!.text))
}
const objectsOf = (lab: Lab, ws: string) => lab.workstreams.projections.objects(ws)
const elements = async (lab: Lab, ws: string, type: string) => (await objectsOf(lab, ws)).filter((o) => o.kind === 'element' && o.object.type === type)
/** The element of a Write that waited, as projected. */
const waitingOf = async (lab: Lab, ws: string, position: string) => (await elements(lab, ws, 'waiting')).find((o) => o.object.position === position)?.object
const projected = (lab: Lab, ws: string, position: string, status: string) =>
  until(`the element ${status}`, async () => (await waitingOf(lab, ws, position))?.status === status)
/** The last prompt has reached the bridge. */
const running = (lab: Lab, ws: string) =>
  until('the prompt sent', async () => {
    const entries = await lab.entries(ws)
    const prompt = prompts(entries).at(-1)
    return prompt && entries.some((x) => x.kind === 'acp.sent' && x.content.requestPosition === prompt.position)
  })
const firstChunk = (lab: Lab, ws: string) => until('a first chunk', async () => (await elements(lab, ws, 'agent_message_chunk')).length > 0)
const toolOpen = (lab: Lab, ws: string) => until('the tool line', async () => (await lab.state(ws)).tools.size === 1)
const allDone = (lab: Lab, ws: string, count: number, timeoutMs = 15_000) =>
  until(`${String(count)} turns done`, async () => {
    const turns = [...(await lab.state(ws)).turns.values()]
    return turns.length === count && turns.every((x) => x.status === 'done') && turns
  }, timeoutMs)
/** Nothing left to go: no message waiting, no turn running. */
const drained = (lab: Lab, ws: string, timeoutMs = 15_000) =>
  until('nothing left to go', async () => {
    const state = await lab.state(ws)
    return state.waiting.length === 0 && state.active === null && state.steering === null
  }, timeoutMs)
const byPosition = <T extends { object: Record<string, unknown> }>(rows: readonly T[]) =>
  [...rows].sort((a, b) => (BigInt(String(a.object.firstPosition)) < BigInt(String(b.object.firstPosition)) ? -1 : 1))

test('L105 a Write that may wait, during a turn, to an agent that offers no steering: no line, then a turn of its own', async (t) => {
  const { lab, ws } = await opened(t, noSteering())
  assert.ok((await lab.write(ws, '/sleep 2')).accepted)
  await running(lab, ws)
  const answer = await say(lab, ws, 'after the turn')
  assert.ok(answer.accepted)
  assert.equal(answer.waiting, true)
  let entries = await lab.entries(ws)
  assert.equal(prompts(entries).length, 1)
  assert.equal(steerings(entries).length, 0)
  await projected(lab, ws, answer.position, 'waiting')
  assert.deepEqual((await waitingOf(lab, ws, answer.position))?.content, text('after the turn'))
  // The turn answered: a turn of its own, the element sent, without its blocks.
  const turns = await allDone(lab, ws, 2)
  entries = await lab.entries(ws)
  const prompt = prompts(entries).at(-1)!
  assert.deepEqual(promptText(prompt), ['after the turn'])
  assert.equal(prompt.command, answer.command)
  const firstAnswer = entries.find((x) => x.direction === 'in' && x.request_position === prompts(entries)[0]!.position)!
  assert.ok(BigInt(firstAnswer.position) < BigInt(prompt.position))
  await projected(lab, ws, answer.position, 'sent')
  assert.equal(Object.hasOwn((await waitingOf(lab, ws, answer.position))!, 'content'), false)
  const users = await until('its user element', async () => {
    const found = (await elements(lab, ws, 'user')).filter((u) => u.object.turn === turns.at(-1)!.id)
    return found.length === 1 && found
  })
  assert.deepEqual(users[0]!.object.content, text('after the turn'))
  assert.equal(users[0]!.object.steered, undefined)
  assert.equal(steerings(await lab.entries(ws)).length, 0)
})

test('L106 behind a cancelled turn, a Write without mayWait is refused; with nothing to wait behind, one that may wait has its line', async (t) => {
  const { lab, ws } = await opened(t, noSteering())
  assert.ok((await lab.write(ws, '/silence 30')).accepted)
  await running(lab, ws)
  const waits = await say(lab, ws, 'held')
  assert.ok(waits.accepted)
  const turn = await lab.turn(ws, 'in_progress')
  const e = (await lab.state(ws)).current!
  assert.ok((await lab.command(ws, 'Cancel', { execution: e.id, turn: turn.id })).accepted)
  await lab.turn(ws, 'cancelled')
  const before = (await lab.entries(ws)).length
  assert.deepEqual(await lab.write(ws, 'plain'), { accepted: false, reason: 'turn_active' })
  assert.equal((await lab.entries(ws)).length, before)
  // Nothing behind: the message retracted, a Write that may wait has its line with it.
  assert.ok((await lab.command(ws, 'Retract', { message: waits.position })).accepted)
  const free = await say(lab, ws, 'free')
  assert.ok(free.accepted)
  assert.equal(free.waiting, undefined)
  assert.deepEqual(promptText(prompts(await lab.entries(ws)).at(-1)!), ['free'])
})

test('L107 three messages waiting, the second retracted; then a Retract of one sent, of an unknown position', async (t) => {
  const { lab, ws } = await opened(t, noSteering())
  assert.ok((await lab.write(ws, '/sleep 2')).accepted)
  await running(lab, ws)
  const [first, second, third] = [await say(lab, ws, 'one'), await say(lab, ws, 'two'), await say(lab, ws, 'three')]
  assert.ok(first.accepted && second.accepted && third.accepted)
  assert.ok((await lab.command(ws, 'Retract', { message: second.position })).accepted)
  await projected(lab, ws, second.position, 'retracted')
  assert.equal(Object.hasOwn((await waitingOf(lab, ws, second.position))!, 'content'), false)
  await allDone(lab, ws, 3)
  const entries = await lab.entries(ws)
  const turns = prompts(entries)
  assert.deepEqual(turns.slice(1).map((x) => promptText(x)), [['one'], ['three']])
  // One turn each: the third's goes once the first's is answered.
  const answered = entries.find((x) => x.direction === 'in' && x.request_position === turns[1]!.position)!
  assert.ok(BigInt(answered.position) < BigInt(turns[2]!.position))
  assert.deepEqual(await lab.command(ws, 'Retract', { message: first.position }), { accepted: false, reason: 'stale_message' })
  assert.deepEqual(await lab.command(ws, 'Retract', { message: '999999' }), { accepted: false, reason: 'stale_message' })
})

test('L108 a message into the running turn: one steering line, injected, a user element between two texts, one answer', async (t) => {
  const { lab, ws } = await opened(t)
  assert.ok((await lab.write(ws, '/sleep 3')).accepted)
  await running(lab, ws)
  await firstChunk(lab, ws)
  const answer = await say(lab, ws, 'also this')
  assert.ok(answer.accepted)
  assert.equal(answer.waiting, true)
  const line = await until('its line', async () => steerings(await lab.entries(ws)).at(0))
  const params = object(line.content.params)!
  assert.deepEqual(params.prompt, text('also this'))
  assert.deepEqual(params._meta, { steering: { idleBehavior: 'promptRequired' } })
  assert.equal(line.command, answer.command)
  await projected(lab, ws, answer.position, 'sent')
  const turn = await lab.turn(ws, 'done')
  const entries = await lab.entries(ws)
  assert.equal(prompts(entries).length, 1)
  assert.equal(steerings(entries).length, 1)
  assert.equal(entries.filter((x) => x.direction === 'in' && x.request_position === prompts(entries)[0]!.position).length, 1)
  const objects = await until('every element', async () => {
    const all = await objectsOf(lab, ws)
    return all.some((o) => o.kind === 'element' && String(o.object.text ?? '').includes('Slept')) && all
  })
  const own = byPosition(objects.filter((o) => o.kind === 'element' && o.object.turn === turn.id))
  assert.deepEqual(own.map((o) => o.object.type), ['user', 'agent_message_chunk', 'user', 'agent_message_chunk'])
  assert.equal(own[2]!.object.steered, true)
  assert.deepEqual(own[2]!.object.content, text('also this'))
  assert.equal(own[0]!.object.steered, undefined)
  assert.doesNotMatch(String(own[1]!.object.text), /Heard/)
  assert.match(String(own[3]!.object.text), /Heard: also this/)
  assert.equal(objects.filter((o) => o.kind === 'element' && o.object.type === 'acp' && /steering|injected/.test(JSON.stringify(o.object))).length, 0)
  assert.equal((await lab.state(ws)).waiting.length, 0)
})

test('L109 two messages in a row: the second steering line once the first is answered, both injected, in order', async (t) => {
  const { lab, ws } = await opened(t)
  // Each answered 2.5 s after it comes: time to see the second wait for the first's answer.
  assert.ok((await lab.write(ws, '/steering late 7')).accepted)
  await running(lab, ws)
  const one = await say(lab, ws, 'one')
  assert.ok(one.accepted)
  await until('the first line', async () => steerings(await lab.entries(ws)).at(0))
  const two = await say(lab, ws, 'two')
  assert.ok(two.accepted)
  await sleep(500)
  assert.equal(steerings(await lab.entries(ws)).length, 1)
  await lab.turn(ws, 'done', 20_000)
  const entries = await lab.entries(ws)
  const sent = steerings(entries)
  assert.equal(sent.length, 2)
  assert.equal(prompts(entries).length, 1)
  const answer = entries.find((x) => x.direction === 'in' && x.request_position === sent[0]!.position)!
  assert.ok(BigInt(answer.position) < BigInt(sent[1]!.position))
  assert.deepEqual(sent.map((x) => promptText(x)[0]), ['one', 'two'])
  assert.deepEqual(entries.filter((x) => x.direction === 'in' && x.correlated_method === '_session/steering').map((x) => object(x.content.result)?.outcome), ['injected', 'injected'])
})

test('L110 a message while a tool is open: no steering line until it closes completed, likewise failed', async (t) => {
  for (const ending of ['completed', 'failed']) {
    const { lab, ws } = await opened(t)
    assert.ok((await lab.write(ws, `/tool-open 2 ${ending}`)).accepted)
    await running(lab, ws)
    await toolOpen(lab, ws)
    const status = async (wanted: string) => lines(await lab.entries(ws), 'in', 'session/update').find((x) => object(object(x.content.params)?.update)?.status === wanted)
    // `pending`: nothing goes.
    const answer = await say(lab, ws, 'after the tool')
    assert.ok(answer.accepted)
    assert.equal(steerings(await lab.entries(ws)).length, 0)
    // `in_progress`: nothing goes.
    await until('in progress', () => status('in_progress'))
    await sleep(500)
    assert.equal(steerings(await lab.entries(ws)).length, 0)
    // Closed: its line, before anything else the agent says.
    const end = await until('the tool closing', () => status(ending))
    const line = await until('its line', async () => steerings(await lab.entries(ws)).at(0))
    assert.ok(BigInt(line.position) > BigInt(end.position))
    const between = (await lab.entries(ws)).filter((x) => x.kind === 'acp' && x.direction === 'in' && BigInt(x.position) > BigInt(end.position) && BigInt(x.position) < BigInt(line.position))
    assert.deepEqual(between, [])
    await lab.turn(ws, 'done')
    assert.equal(prompts(await lab.entries(ws)).length, 1)
    await projected(lab, ws, answer.position, 'sent')
  }
})

test('L111 answered promptRequired, failed, or with an error: still waiting, no second line in that turn, its own turn after', async (t) => {
  for (const refusal of ['promptRequired', 'failed', 'error']) {
    const { lab, ws } = await opened(t)
    assert.ok((await lab.write(ws, `/steering ${refusal} 2`)).accepted)
    await running(lab, ws)
    const one = await say(lab, ws, 'first')
    assert.ok(one.accepted)
    const line = await until('its line', async () => steerings(await lab.entries(ws)).at(0))
    await until('its answer', async () => (await lab.entries(ws)).some((x) => x.direction === 'in' && x.request_position === line.position))
    assert.equal((await lab.state(ws)).waiting.length, 1)
    await projected(lab, ws, one.position, 'waiting')
    assert.equal((await objectsOf(lab, ws)).filter((o) => o.kind === 'element' && o.object.steered === true).length, 0)
    // Each line the agent says would give it another try: none in that turn.
    await sleep(300)
    assert.equal(steerings(await lab.entries(ws)).length, 1)
    await allDone(lab, ws, 2)
    const entries = await lab.entries(ws)
    assert.deepEqual(prompts(entries).slice(1).map((x) => promptText(x)), [['first']])
    assert.equal(steerings(entries).length, 1)
  }
})

test('L112 a steering line never answered: request.failed after the timeout, the execution going on, the message next', async (t) => {
  const { lab, ws } = await opened(t, { workstreams: { responseTimeoutMs: 1500 } })
  assert.ok((await lab.write(ws, '/steering silent 4')).accepted)
  await running(lab, ws)
  const answer = await say(lab, ws, 'unanswered')
  assert.ok(answer.accepted)
  const line = await until('its line', async () => steerings(await lab.entries(ws)).at(0))
  assert.deepEqual(await lab.command(ws, 'Retract', { message: answer.position }), { accepted: false, reason: 'stale_message' })
  const failed = await until('the timeout', async () => (await lab.entries(ws)).find((x) => x.kind === 'request.failed' && x.content.requestPosition === line.position), 5000)
  assert.equal(failed.content.reason, 'response_timeout')
  const state = await lab.state(ws)
  assert.equal(state.current?.failed, undefined)
  assert.equal(state.waiting.length, 1)
  assert.equal(prompts(await lab.entries(ws)).length, 1)
  // Its turn answered: a turn of its own.
  await allDone(lab, ws, 2)
  assert.deepEqual(promptText(prompts(await lab.entries(ws)).at(-1)!), ['unanswered'])
})

test('L113 a Cancel with a message behind an open tool: no line after it, the message held; the next Write goes behind it', async (t) => {
  const { lab, ws } = await opened(t)
  assert.ok((await lab.write(ws, '/tool-open 30')).accepted)
  await running(lab, ws)
  await toolOpen(lab, ws)
  const held = await say(lab, ws, 'held')
  assert.ok(held.accepted)
  const turn = await lab.turn(ws, 'in_progress')
  const e = (await lab.state(ws)).current!
  assert.ok((await lab.command(ws, 'Cancel', { execution: e.id, turn: turn.id })).accepted)
  await lab.turn(ws, 'cancelled')
  await sleep(500)
  let entries = await lab.entries(ws)
  assert.equal(steerings(entries).length, 0)
  assert.equal(prompts(entries).length, 1)
  assert.equal((await lab.state(ws)).waiting.length, 1)
  await projected(lab, ws, held.position, 'waiting')
  const next = await say(lab, ws, 'next')
  assert.ok(next.accepted)
  assert.equal(next.waiting, true)
  await until('both turns', async () => prompts(await lab.entries(ws)).length === 3)
  entries = await lab.entries(ws)
  assert.deepEqual(prompts(entries).slice(1).map((x) => promptText(x)), [['held'], ['next']])
  // Not into the cancelled turn: the next may try the turn of the one before it.
  assert.ok(steerings(entries).every((x) => BigInt(x.position) > BigInt(prompts(entries)[1]!.position)))
})

test('L114 a message behind an open tool, a permission asked, the tool closing: no line while it is pending; its steering line once answered', async (t) => {
  const { lab, ws } = await opened(t)
  assert.ok((await lab.write(ws, '/tool-permission')).accepted)
  await running(lab, ws)
  await toolOpen(lab, ws)
  const answer = await say(lab, ws, 'behind the permission')
  assert.ok(answer.accepted)
  const permission = await until('the permission', async () => [...(await lab.state(ws)).permissions.values()][0])
  await until('the tool closed', async () => (await lab.state(ws)).tools.size === 0)
  await sleep(500)
  assert.equal(steerings(await lab.entries(ws)).length, 0)
  const e = (await lab.state(ws)).current!
  assert.ok(
    (await lab.command(ws, 'RespondPermission', { execution: e.id, session: e.session, requestPosition: permission.position }, { requestId: permission.rpc_id, outcome: { outcome: 'selected', optionId: 'allow-once' } })).accepted,
  )
  const line = await until('its line', async () => steerings(await lab.entries(ws)).at(0))
  assert.deepEqual(promptText(line), ['behind the permission'])
  await lab.turn(ws, 'done')
  assert.equal(prompts(await lab.entries(ws)).length, 1)
})

test('L114 a message behind an open tool, a question asked, the tool closing: no line while it is pending; its steering line once answered', async (t) => {
  const { lab, ws } = await opened(t)
  assert.ok((await lab.write(ws, '/tool-open 1 completed 4')).accepted)
  await running(lab, ws)
  await toolOpen(lab, ws)
  const answer = await say(lab, ws, 'behind the question')
  assert.ok(answer.accepted)
  const asked = await lab.command(ws, 'Ask', {}, { title: 'Which?', text: 'Which one?', options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { optionId: 'b', name: 'B', kind: 'reject_once' }] })
  assert.ok(asked.accepted)
  await until('the tool closed', async () => (await lab.state(ws)).tools.size === 0)
  await sleep(500)
  assert.equal(steerings(await lab.entries(ws)).length, 0)
  assert.ok((await lab.command(ws, 'Answer', { question: asked.position }, { optionId: 'a' })).accepted)
  const line = await until('its line', async () => steerings(await lab.entries(ws)).at(0))
  assert.deepEqual(promptText(line), ['behind the question'])
  await lab.turn(ws, 'done')
  assert.equal(prompts(await lab.entries(ws)).length, 1)
})

test('L115 a command, an image, then plain text behind them: no steering line; their turns in order, the command read as one, the catch-up left out', async (t) => {
  const { lab, ws, e } = await opened(t)
  assert.ok((await lab.write(ws, 'an exchange to catch up')).accepted)
  await lab.turn(ws, 'done')
  // The Pod ends without its anchor (no anchor receiver here): the next execution owes the catch-up.
  await expire(lab.kube, e.claimName)
  await until('ended', async () => (await lab.state(ws)).current?.ended)
  await lab.open(ws)
  assert.ok((await lab.write(ws, '/sleep 2')).accepted)
  await running(lab, ws)
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', uri: 'a.png' }
  const command = await say(lab, ws, '/recall')
  const pictured = await say(lab, ws, 'look', [{ type: 'text', text: 'look' }, image])
  const plain = await say(lab, ws, 'plain')
  assert.ok(command.accepted && pictured.accepted && plain.accepted)
  await drained(lab, ws, 20_000)
  const entries = await lab.entries(ws)
  const last = prompts(entries).filter((x) => BigInt(x.position) > BigInt(prompts(entries)[1]!.position))
  // The plain one, as much a message for a running turn as any, waited behind them: no steering line before the second's turn.
  assert.ok(steerings(entries).every((x) => BigInt(x.position) > BigInt(last[1]!.position)))
  // The command alone: read as one, the catch-up left for the next.
  assert.deepEqual(promptText(last[0]!), ['/recall'])
  const answered = lines(entries, 'in', 'session/update').map((x) => object(object(object(x.content.params)?.update)?.content)?.text)
  assert.ok(answered.some((said) => typeof said === 'string' && said.startsWith('You told me')))
  // Then the catch-up, ahead of the message and its image; none after.
  const blocks = object(last[1]!.content.params)?.prompt as Record<string, unknown>[]
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'text', 'image'])
  assert.match(String(blocks[0]!.text), /an exchange to catch up/)
  // Then the plain one: into that turn if it still runs, as its own otherwise; no catch-up.
  const plainLines = [...steerings(entries), ...prompts(entries)].filter((x) => promptText(x).includes('plain'))
  assert.ok(plainLines.length > 0)
  assert.ok(plainLines.every((x) => promptText(x).length === 1 && BigInt(x.position) > BigInt(last[1]!.position)))
})

test('L116 Agora killed with a message waiting: sent once after the restart, as its own turn', async (t) => {
  const context = await opened(t, noSteering())
  assert.ok((await context.lab.write(context.ws, '/silence 3')).accepted)
  await running(context.lab, context.ws)
  const answer = await say(context.lab, context.ws, 'across the restart')
  assert.ok(answer.accepted)
  context.lab = await context.lab.restart('halt')
  const { lab, ws } = context
  await allDone(lab, ws, 2, 20_000)
  const entries = await lab.entries(ws)
  assert.equal(prompts(entries).length, 2)
  const prompt = prompts(entries).at(-1)!
  assert.deepEqual(promptText(prompt), ['across the restart'])
  assert.equal(entries.filter((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === prompt.position).length, 1)
})

test('L116 Agora killed with its steering line dispatched and unanswered: never resent, its answer applied', async (t) => {
  const context = await opened(t)
  assert.ok((await context.lab.write(context.ws, '/steering late 6')).accepted)
  await running(context.lab, context.ws)
  const answer = await say(context.lab, context.ws, 'in flight')
  assert.ok(answer.accepted)
  const line = await until('its line sent', async () => {
    const entries = await context.lab.entries(context.ws)
    const found = steerings(entries).at(0)
    return found && entries.some((x) => x.kind === 'acp.sent' && x.content.requestPosition === found.position) && found
  })
  context.lab = await context.lab.restart('halt')
  const { lab, ws } = context
  await until('its answer', async () => (await lab.entries(ws)).some((x) => x.direction === 'in' && x.request_position === line.position), 20_000)
  await projected(lab, ws, answer.position, 'sent')
  await until('the turn over', async () => (await lab.state(ws)).active === null, 20_000)
  const entries = await lab.entries(ws)
  assert.equal(steerings(entries).length, 1)
  assert.equal(prompts(entries).length, 1)
  assert.equal(entries.filter((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === line.position).length, 1)
  assert.equal((await lab.state(ws)).waiting.length, 0)
})

test('L116 Agora killed between its steering line\'s marker and its write: never resent; failed after the timeout; then its own turn', async (t) => {
  let died = () => {}
  const dying = new Promise<void>((resolve) => (died = resolve))
  const context = await opened(t, {
    workstreams: {
      responseTimeoutMs: 1500,
      // Through the fault point the dispatcher declares: held there, as dead, its write never comes.
      fault: (point, detail) => {
        if (point !== 'after_marker' || detail.method !== '_session/steering') return
        died()
        return new Promise<void>(() => {})
      },
    },
  })
  assert.ok((await context.lab.write(context.ws, '/sleep 3')).accepted)
  await running(context.lab, context.ws)
  // Its answer never comes, as to a request whose server died.
  void say(context.lab, context.ws, 'never written')
  await dying
  context.lab = await context.lab.restart('halt', { workstreams: { responseTimeoutMs: 1500 } })
  const { lab, ws } = context
  const line = steerings(await lab.entries(ws))[0]!
  const failed = await until('the timeout', async () => (await lab.entries(ws)).find((x) => x.kind === 'request.failed' && x.content.requestPosition === line.position), 10_000)
  assert.equal(failed.content.reason, 'response_timeout')
  await until('its turn', async () => prompts(await lab.entries(ws)).length === 2, 20_000)
  const entries = await lab.entries(ws)
  assert.deepEqual(promptText(prompts(entries).at(-1)!), ['never written'])
  assert.equal(steerings(entries).length, 1)
  assert.equal(entries.filter((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === line.position).length, 1)
  assert.equal(entries.filter((x) => x.kind === 'acp.sent' && x.content.requestPosition === line.position).length, 0)
})

test('L117 the execution lost with a message waiting: it keeps waiting, then goes in the next execution, with the catch-up', async (t) => {
  const { lab, ws, e } = await opened(t, noSteering())
  assert.ok((await lab.write(ws, 'a first exchange')).accepted)
  await lab.turn(ws, 'done')
  assert.ok((await lab.write(ws, '/die 2')).accepted)
  await running(lab, ws)
  const answer = await say(lab, ws, 'through its end')
  assert.ok(answer.accepted)
  await until('lost', async () => (await lab.state(ws)).current?.lost)
  await expire(lab.kube, e.claimName)
  await until('ended', async () => (await lab.state(ws)).current?.ended)
  assert.equal((await lab.state(ws)).waiting.length, 1)
  assert.equal(prompts(await lab.entries(ws)).length, 2)
  // A Create and no Write: once its Session is open and settled, the message goes.
  assert.ok((await lab.command(ws, 'Create', {}, { pool: 'mock-test' })).accepted)
  const line = await until('its prompt', async () => prompts(await lab.entries(ws)).at(2), 20_000)
  const words = promptText(line)
  assert.equal(words.at(-1), 'through its end')
  assert.equal(words.length, 2)
  assert.match(words[0]!, /a first exchange/)
  await lab.turn(ws, 'done')
  await projected(lab, ws, answer.position, 'sent')
})

test('L118 Stop during a turn with a message waiting: no line after the Stop; it goes in the next execution', async (t) => {
  const { lab, ws, e } = await opened(t, noSteering())
  assert.ok((await lab.write(ws, '/silence 30')).accepted)
  await running(lab, ws)
  const answer = await say(lab, ws, 'after the stop')
  assert.ok(answer.accepted)
  assert.ok((await lab.command(ws, 'Stop', { execution: e.id })).accepted)
  await lab.turn(ws, 'cancelled')
  await sleep(500)
  assert.equal(prompts(await lab.entries(ws)).length, 1)
  assert.equal((await lab.state(ws)).waiting.length, 1)
  await expire(lab.kube, e.claimName)
  await until('ended', async () => (await lab.state(ws)).current?.ended)
  // The next execution, then the person's next message: the first goes first.
  await lab.open(ws)
  await sleep(300)
  assert.equal(prompts(await lab.entries(ws)).length, 1)
  assert.ok((await say(lab, ws, 'and this')).accepted)
  await drained(lab, ws, 20_000)
  const after = prompts(await lab.entries(ws)).slice(1)
  assert.equal(promptText(after[0]!).at(-1), 'after the stop')
  assert.ok([...after, ...steerings(await lab.entries(ws))].some((x) => promptText(x).at(-1) === 'and this'))
})

test('L118 Stop during a turn the agent ends all the same, a message waiting: no line for it after the Stop', async (t) => {
  const { lab, ws, e } = await opened(t, noSteering())
  assert.ok((await lab.write(ws, '/stubborn 2')).accepted)
  await running(lab, ws)
  assert.ok((await say(lab, ws, 'after the stop')).accepted)
  assert.ok((await lab.command(ws, 'Stop', { execution: e.id })).accepted)
  await lab.turn(ws, 'done')
  await sleep(500)
  assert.equal(prompts(await lab.entries(ws)).length, 1)
  assert.equal((await lab.state(ws)).waiting.length, 1)
})

test('L119 a catch-up over a turn with a message sent into it: in its place, marked as the user\'s', async (t) => {
  const { lab, ws } = await opened(t)
  assert.ok((await lab.write(ws, '/sleep 2')).accepted)
  await running(lab, ws)
  await firstChunk(lab, ws)
  assert.ok((await say(lab, ws, 'also this')).accepted)
  await lab.turn(ws, 'done')
  const entries = await lab.entries(ws)
  const [exchange] = exchangesOf(entries, [prompts(entries)[0]!.position])
  assert.equal(exchange!.user, '/sleep 2')
  const said = exchange!.agent.indexOf('[the user, during this turn: also this]')
  assert.ok(said > 0, exchange!.agent)
  assert.ok(exchange!.agent.indexOf('second 1/2') < said, 'after what the agent said before')
  assert.ok(exchange!.agent.indexOf('Slept') > said, 'before what it said next')
  assert.ok(catchUpText([exchange!], false).text.includes('[the user, during this turn: also this]'))
})

test('L120 the agent speaks and calls a tool after its turn\'s answer: elements of that turn, in its exchange; a Write accepted as usual', async (t) => {
  const { lab, ws } = await opened(t)
  assert.ok((await lab.write(ws, '/late')).accepted)
  const turn = await lab.turn(ws, 'done')
  const objects = await until('what it says after', async () => {
    const all = await objectsOf(lab, ws)
    return all.some((o) => o.kind === 'element' && o.object.type === 'tool') && all.some((o) => o.object.text === 'Said after the answer.') && all
  })
  const own = byPosition(objects.filter((o) => o.kind === 'element' && o.object.turn === turn.id))
  assert.deepEqual(own.map((o) => o.object.type), ['user', 'agent_message_chunk', 'tool', 'agent_message_chunk'])
  assert.equal(objects.find((o) => o.kind === 'turn' && o.id === turn.id)?.object.status, 'done')
  const entries = await lab.entries(ws)
  const [exchange] = exchangesOf(entries, [prompts(entries)[0]!.position])
  assert.match(exchange!.agent, /Said after the answer\./)
  assert.ok((await lab.write(ws, 'next')).accepted)
  await lab.turn(ws, 'done')
})

test('L123 a Write that may wait whose prompt is not valid ACP, or beyond the line\'s maximum: refused, nothing written, the turn going on', async (t) => {
  const { lab, ws } = await opened(t)
  assert.ok((await lab.write(ws, '/sleep 2')).accepted)
  await running(lab, ws)
  const e = (await lab.state(ws)).current!
  const commands = async () => (await lab.entries(ws)).filter((x) => x.kind === 'command').length
  const before = await commands()
  const target = { execution: e.id, session: e.session }
  assert.deepEqual(await lab.command(ws, 'Write', target, { prompt: 'not blocks', mayWait: true }), { accepted: false, reason: 'invalid_body' })
  assert.deepEqual(await lab.command(ws, 'Write', target, { prompt: text('x'.repeat(17 * 1024 * 1024)), mayWait: true }), { accepted: false, reason: 'line_too_large' })
  assert.equal(await commands(), before)
  assert.equal((await lab.state(ws)).waiting.length, 0)
  await lab.turn(ws, 'done')
  assert.equal(prompts(await lab.entries(ws)).length, 1)
})

test('L124 a Write that may wait after a Cancel, before the turn\'s answer: its turn once the turn is answered', async (t) => {
  const { lab, ws } = await opened(t, noSteering())
  assert.ok((await lab.write(ws, '/stubborn 2')).accepted)
  await running(lab, ws)
  const turn = await lab.turn(ws, 'in_progress')
  const e = (await lab.state(ws)).current!
  assert.ok((await lab.command(ws, 'Cancel', { execution: e.id, turn: turn.id })).accepted)
  const answer = await say(lab, ws, 'after the cancel')
  assert.ok(answer.accepted)
  assert.equal(answer.waiting, true)
  await allDone(lab, ws, 2)
  assert.deepEqual(promptText(prompts(await lab.entries(ws)).at(-1)!), ['after the cancel'])
})

test('L124 a Cancel the agent answers end_turn, a message waiting and no Write after it: no line, still waiting', async (t) => {
  const { lab, ws } = await opened(t, noSteering())
  assert.ok((await lab.write(ws, '/stubborn 2')).accepted)
  await running(lab, ws)
  const answer = await say(lab, ws, 'before the cancel')
  assert.ok(answer.accepted)
  const turn = await lab.turn(ws, 'in_progress')
  const e = (await lab.state(ws)).current!
  assert.ok((await lab.command(ws, 'Cancel', { execution: e.id, turn: turn.id })).accepted)
  await lab.turn(ws, 'done')
  await sleep(500)
  assert.equal(prompts(await lab.entries(ws)).length, 1)
  assert.equal((await lab.state(ws)).waiting.length, 1)
  await projected(lab, ws, answer.position, 'waiting')
})

// ---------------------------------------------------------------- a Create's message

/** An agent that takes this long to answer `initialize`, in the Pods `slowed` names by their order: its Session opens after it. */
const slow = (initializeDelayMs: number, slowed: (pod: number) => boolean = () => true) => {
  const own = keys()
  const kube = new FakeKube(own.publicKey)
  let pods = 0
  kube.bridgeFactory = (publicKey, pod) => mockBridge(publicKey, pod, slowed(pods++) ? { initializeDelayMs } : {})
  return { kube, keys: own }
}
/** Agora and a Workstream with no execution. */
const fresh = async (t: { after(fn: () => Promise<void>): void }, options: Omit<LabOptions, 'db'> = {}) => {
  const db = await database()
  const context = { db, lab: await Lab.start({ db, ...options }), ws: '' }
  t.after(async () => {
    await context.lab.close()
    await db.drop()
  })
  context.ws = await context.lab.workstream()
  return context
}
/** A Create carrying a message, as the client sends one. */
const createWith = (lab: Lab, ws: string, prompt: unknown, id = randomUUID()) => lab.workstreams.command(ws, { id, kind: 'Create', target: {}, body: { pool: 'mock-test', prompt } })
/** The position of the Write a Create's message is: the one after its Create. */
const messageOf = (answer: { position: string }) => String(BigInt(answer.position) + 1n)
const commandCount = async (lab: Lab, ws: string) => (await lab.entries(ws)).filter((x) => x.kind === 'command').length

test('L128 a Create carrying a message, its Session two seconds to open: a Write that waits written with it, sent once the Session is open; sent again, the first answer', async (t) => {
  const { lab, db, ws } = await fresh(t, slow(2_000))
  const blocks = text('first words\nand more')
  const command = { id: randomUUID(), kind: 'Create' as const, target: {}, body: { pool: 'mock-test', prompt: blocks } }
  const answer = await lab.workstreams.command(ws, command)
  assert.ok(answer.accepted)
  const execution = answer.execution!
  const at = await lab.entries(ws)
  const create = at.find((x) => x.position === answer.position)!
  const write = at.find((x) => x.position === messageOf(answer))!
  assert.deepEqual([create.content.kind, object(create.content.body)?.prompt], ['Create', undefined])
  assert.deepEqual([write.kind, write.content.kind, write.content.waits, write.content.first, write.content.target, write.content.body], ['command', 'Write', true, execution, {}, { prompt: blocks, mayWait: true }])
  // One commit: both rows written by one transaction.
  const xmin = (await db.admin.query('SELECT xmin::text AS x FROM entries WHERE workstream=$1 AND position IN ($2,$3)', [ws, create.position, write.position])).rows.map((r) => String(r.x))
  assert.equal(xmin.length, 2)
  assert.equal(xmin[0], xmin[1])
  // While the Session opens: waiting, no line.
  const state = await lab.state(ws)
  assert.deepEqual([state.waiting.map((w) => w.position), state.current?.session, prompts(at).length], [[write.position], null, 0])
  await projected(lab, ws, write.position, 'waiting')
  const element = await waitingOf(lab, ws, write.position)
  assert.deepEqual([element?.first, element?.content], [execution, blocks])
  const title = (await objectsOf(lab, ws)).find((o) => o.kind === 'workstream')?.object.title
  assert.equal(title, 'first words')
  // Sent again: the first answer, nothing written.
  const commands = await commandCount(lab, ws)
  assert.deepEqual(await lab.workstreams.command(ws, command), answer)
  assert.equal(await commandCount(lab, ws), commands)
  // Its turn, once the Session is open.
  await allDone(lab, ws, 1, 20_000)
  const entries = await lab.entries(ws)
  const sent = prompts(entries)
  assert.equal(sent.length, 1)
  assert.deepEqual([object(sent[0]!.content.params)?.prompt, sent[0]!.command], [blocks, write.command])
  const opening = entries.find((x) => x.kind === 'session.opened')!
  assert.ok(BigInt(opening.position) < BigInt(sent[0]!.position))
  await projected(lab, ws, write.position, 'sent')
  t.diagnostic(`Create at ${create.position}, its Write at ${write.position}, waits, first its execution, one transaction (xmin ${xmin[0]!}); title '${String(title)}'; session.opened at ${opening.position}, session/prompt at ${sent[0]!.position}; ${String(sent.length)} prompt; ${String(commands)} commands before and after the replay`)
})

test('L129 a Create carrying a message whose prompt is not valid ACP, beyond the line’s maximum, or holds an image for a pool no Session has opened in: refused, nothing written, no execution', async (t) => {
  const { lab, ws } = await fresh(t)
  const image = [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=', uri: 'pixel.png' }]
  const refusals = [await createWith(lab, ws, 'not blocks'), await createWith(lab, ws, text('x'.repeat(17 * 1024 * 1024))), await createWith(lab, ws, image)]
  assert.deepEqual(refusals, [
    { accepted: false, reason: 'invalid_body' },
    { accepted: false, reason: 'line_too_large' },
    { accepted: false, reason: 'prompt_unsupported' },
  ])
  assert.deepEqual([(await lab.entries(ws)).length, (await lab.state(ws)).current], [0, null])
  // Once a Session of that pool has said it takes images, the same Create is accepted, and its message goes.
  await lab.open(await lab.workstream())
  await until('the pool known to take images', async () => object((await lab.workstreams.catalogue()).find((p) => p.name === 'mock-test')?.promptCapabilities)?.image === true)
  assert.ok((await createWith(lab, ws, image)).accepted)
  await allDone(lab, ws, 1, 20_000)
  assert.equal(prompts(await lab.entries(ws)).length, 1)
  t.diagnostic(`refused ${refusals.map((r) => (r.accepted ? 'accepted' : r.reason)).join(', ')}; 0 entries, no execution; accepted once the pool's last Session took images`)
})

test('L130 a Create carrying a message whose agent never answers initialize: failed, no prompt; the message given back, its element returned with its blocks; the next Create’s alone goes', async (t) => {
  // The first Pod's agent never answers in time; the next ones do.
  const { lab, ws } = await fresh(t, { ...slow(30_000, (pod) => pod === 0), workstreams: { responseTimeoutMs: 1000 } })
  const blocks = text('never read')
  const answer = await createWith(lab, ws, blocks)
  assert.ok(answer.accepted)
  const written = messageOf(answer)
  assert.deepEqual((await lab.state(ws)).waiting.map((w) => w.position), [written])
  const failed = await until('execution.failed', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.failed'))
  assert.equal(failed.content.reason, 'startup_failed')
  assert.equal((await lab.state(ws)).waiting.length, 0)
  await projected(lab, ws, written, 'returned')
  const element = await waitingOf(lab, ws, written)
  assert.deepEqual([element?.first, element?.content, element?.lastPosition], [answer.execution, blocks, failed.position])
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  assert.equal(prompts(await lab.entries(ws)).length, 0)
  // Another message, with the next Create: it alone goes.
  assert.ok((await createWith(lab, ws, text('read at last'))).accepted)
  await allDone(lab, ws, 1, 20_000)
  const sent = prompts(await lab.entries(ws)).map(promptText)
  assert.deepEqual(sent, [['read at last']])
  assert.equal((await waitingOf(lab, ws, written))?.status, 'returned')
  t.diagnostic(`execution.failed (${String(failed.content.reason)}) at ${failed.position}: the message of ${written} returned at that position, its blocks kept; prompts in all: ${JSON.stringify(sent)}`)
})

test('L130 a Create carrying a message, stopped before its Session opens: ended at its deadline, no prompt; the message given back', async (t) => {
  const { lab, ws } = await fresh(t, slow(3_000))
  const blocks = text('stopped before it was read')
  const answer = await createWith(lab, ws, blocks)
  assert.ok(answer.accepted)
  const written = messageOf(answer)
  assert.ok((await lab.command(ws, 'Stop', { execution: answer.execution })).accepted)
  // Its claim, once there, at its deadline.
  await until('obtained', async () => (await lab.state(ws)).current?.uid)
  assert.equal((await waitingOf(lab, ws, written))?.status, 'waiting')
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  const ended = await until('execution.ended', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.ended'), 30_000)
  const entries = await lab.entries(ws)
  assert.deepEqual([(await lab.state(ws)).waiting.length, prompts(entries).length, entries.some((x) => x.kind === 'execution.failed')], [0, 0, false])
  await projected(lab, ws, written, 'returned')
  const element = await waitingOf(lab, ws, written)
  assert.deepEqual([element?.content, element?.lastPosition], [blocks, ended.position])
  t.diagnostic(`stopped, then execution.ended at ${ended.position}: no prompt, no execution.failed; the message of ${written} returned at that position`)
})

test('L131 a message left waiting by an ended execution, then a Create carrying one, its execution lost during the first turn: the older first, the Create’s still waiting, sent in the next execution', async (t) => {
  const { lab, ws, e } = await opened(t, noSteering())
  // A message left waiting: written during a turn, its execution ending before it could go.
  assert.ok((await lab.write(ws, '/sleep 30')).accepted)
  await running(lab, ws)
  assert.ok((await say(lab, ws, '/die 2')).accepted)
  await expire(lab.kube, e.claimName)
  await until('ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  assert.equal((await lab.state(ws)).waiting.length, 1)
  // The Create's message waits behind it; the older one's turn loses the execution.
  const answer = await createWith(lab, ws, text('the newer one'))
  assert.ok(answer.accepted)
  const written = messageOf(answer)
  const older = await until('the older one’s prompt', async () => prompts(await lab.entries(ws)).at(1), 20_000)
  assert.equal(promptText(older).at(-1), '/die 2')
  await until('lost', async () => (await lab.state(ws)).current?.lost, 20_000)
  const lost = await lab.state(ws)
  assert.deepEqual([lost.current?.id, lost.waiting.map((w) => w.position)], [answer.execution, [written]])
  await expire(lab.kube, lost.current!.claimName)
  await until('ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  assert.deepEqual([(await lab.state(ws)).waiting.map((w) => w.position), (await waitingOf(lab, ws, written))?.status], [[written], 'waiting'])
  // The next execution: it goes.
  assert.ok((await lab.command(ws, 'Create', {}, { pool: 'mock-test' })).accepted)
  const newer = await until('its prompt', async () => prompts(await lab.entries(ws)).at(2), 20_000)
  assert.equal(promptText(newer).at(-1), 'the newer one')
  await lab.turn(ws, 'done')
  await projected(lab, ws, written, 'sent')
  t.diagnostic(`prompts in order: ${JSON.stringify(prompts(await lab.entries(ws)).map((x) => promptText(x).at(-1)))}; after its execution's loss and end the Create's message still waiting, then sent in the next execution`)
})

test('L132 Agora killed after a Create carrying a message, before its Session is open: read back, sent once', async (t) => {
  const context = await fresh(t)
  // Its Pod two seconds to come: nothing of the Session exists when Agora dies.
  context.lab.kube.allocationDelayMs = 2_000
  const answer = await createWith(context.lab, context.ws, text('across the restart'))
  assert.ok(answer.accepted)
  const before = await context.lab.state(context.ws)
  assert.deepEqual([before.waiting.length, before.current?.session], [1, null])
  context.lab = await context.lab.restart('halt')
  const { lab, ws } = context
  await allDone(lab, ws, 1, 30_000)
  const entries = await lab.entries(ws)
  const sent = prompts(entries)
  assert.deepEqual(sent.map(promptText), [['across the restart']])
  assert.equal(entries.filter((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === sent[0]!.position).length, 1)
  await projected(lab, ws, messageOf(answer), 'sent')
  t.diagnostic(`killed with the message waiting and no Session; after the restart: ${String(sent.length)} session/prompt, dispatched once, its turn done`)
})
