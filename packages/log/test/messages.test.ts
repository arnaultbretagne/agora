// docs/specs/log.md, "Messages during a turn": a message written during a turn waits in the log, then goes into the
// running turn when the agent can take it there, as the next turn otherwise. Real bridges, the mock agent.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keys, mockBridge } from '@agora/testkit'
import { catchUpText, exchangesOf } from '../src/catch-up.ts'
import { object, type Entry } from '../src/index.ts'
import { expire, FakeKube, lines, opened, sleep, until, type Lab } from './support.ts'

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
  assert.ok((await lab.write(ws, '/sleep 3')).accepted)
  await running(lab, ws)
  const [one, two] = await Promise.all([say(lab, ws, 'one'), say(lab, ws, 'two')])
  assert.ok(one.accepted && two.accepted)
  await lab.turn(ws, 'done')
  const entries = await lab.entries(ws)
  const sent = steerings(entries)
  assert.equal(sent.length, 2)
  assert.equal(prompts(entries).length, 1)
  const answer = entries.find((x) => x.direction === 'in' && x.request_position === sent[0]!.position)!
  assert.ok(BigInt(answer.position) < BigInt(sent[1]!.position))
  assert.deepEqual(sent.map((x) => promptText(x)[0]), BigInt(one.position) < BigInt(two.position) ? ['one', 'two'] : ['two', 'one'])
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
    const two = await say(lab, ws, 'second')
    assert.ok(one.accepted && two.accepted)
    const line = await until('its line', async () => steerings(await lab.entries(ws)).at(0))
    await until('its answer', async () => (await lab.entries(ws)).some((x) => x.direction === 'in' && x.request_position === line.position))
    assert.equal((await lab.state(ws)).waiting.length, 2)
    await projected(lab, ws, one.position, 'waiting')
    assert.equal((await objectsOf(lab, ws)).filter((o) => o.kind === 'element' && o.object.steered === true).length, 0)
    await sleep(300)
    assert.equal(steerings(await lab.entries(ws)).length, 1)
    await allDone(lab, ws, 3)
    const entries = await lab.entries(ws)
    assert.deepEqual(prompts(entries).slice(1).map((x) => promptText(x)), [['first'], ['second']])
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
  assert.equal(steerings(entries).length, 0)
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
  await allDone(lab, ws, 5, 20_000)
  const entries = await lab.entries(ws)
  assert.equal(steerings(entries).length, 0)
  const last = prompts(entries).slice(-3)
  // The command alone: read as one, the catch-up left for the next.
  assert.deepEqual(promptText(last[0]!), ['/recall'])
  const answered = lines(entries, 'in', 'session/update').map((x) => object(object(object(x.content.params)?.update)?.content)?.text)
  assert.ok(answered.some((said) => typeof said === 'string' && said.startsWith('You told me')))
  // Then the catch-up, ahead of the message and its image; none after.
  const blocks = object(last[1]!.content.params)?.prompt as Record<string, unknown>[]
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'text', 'image'])
  assert.match(String(blocks[0]!.text), /an exchange to catch up/)
  assert.deepEqual(promptText(last[2]!), ['plain'])
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
  await allDone(lab, ws, 3, 20_000).catch(async () => {
    // The first turn ended cancelled.
    await until('both next turns', async () => [...(await lab.state(ws)).turns.values()].slice(-2).every((x) => x.status === 'done'))
  })
  const last = prompts(await lab.entries(ws)).slice(-2)
  assert.equal(last.length, 2)
  assert.equal(promptText(last[0]!).at(-1), 'after the stop')
  assert.equal(promptText(last[1]!).at(-1), 'and this')
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
