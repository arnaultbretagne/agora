// docs/specs/log.md, "Continuing": a Create restores the Workstream's last anchor of its harness, and the
// execution's first prompt gives the agent, as text, the exchanges that anchor does not hold — all of
// them when there is none. Real bridges with the mock agent; a Pod ending without its anchor is its
// push not reaching Agora, as when the node dies.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { keys, mockBridge } from '@agora/testkit'
import { CATCH_UP_MAX, CATCH_UP_META, catchUpText, dispatched, exchangesOf, isCatchUp } from '../src/catch-up.ts'
import { schemaValue } from '../src/json.ts'
import { fold, project, type Execution } from '../src/state.ts'
import type { Entry } from '../src/store.ts'
import { expire, FakeKube, lines, opened, until, type Lab } from './support.ts'

type Context = { lab: Lab; ws: string }

async function turn(c: Context, text: string): Promise<void> {
  const answer = await c.lab.write(c.ws, text)
  assert.ok(answer.accepted, `Write refused: ${String((answer as { reason?: string }).reason)}`)
  await c.lab.turn(c.ws, 'done')
}

/** The execution's Pod ends at its deadline; with `lost`, its anchor never reaches Agora. */
async function end(c: Context, e: Execution, lost = false): Promise<Entry> {
  const url = c.lab.kube.anchorUrl
  if (lost) c.lab.kube.anchorUrl = ''
  await expire(c.lab.kube, e.claimName)
  const ended = await until('execution.ended', async () => (await c.lab.entries(c.ws)).find((x) => x.kind === 'execution.ended' && x.execution === e.id))
  c.lab.kube.anchorUrl = url
  return ended
}

/** A Create in that pool, with no anchor named; its execution once its Session is open. */
async function create(c: Context, pool = 'mock-test'): Promise<Execution> {
  const answer = (await c.lab.command(c.ws, 'Create', {}, { pool })) as { accepted: boolean; execution?: string; reason?: string }
  assert.ok(answer.accepted, `Create refused: ${String(answer.reason)}`)
  return until('the Session open, its commands given', async () => {
    const e = (await c.lab.state(c.ws)).executions.get(String(answer.execution))
    return e?.session && e.connection && e.commands.length ? { ...e } : null
  })
}

const opening = async (c: Context, e: Execution): Promise<Entry> =>
  (await c.lab.entries(c.ws)).find((x) => x.kind === 'session.opened' && x.execution === e.id)!

const prompts = async (c: Context, e: Execution): Promise<unknown[][]> =>
  lines(await c.lab.entries(c.ws), 'out', 'session/prompt')
    .filter((x) => x.execution === e.id && x.rpc_kind === 'request')
    .map((x) => (x.content.params as { prompt: unknown[] }).prompt)

const said = async (c: Context, after: string): Promise<string> =>
  (await c.lab.entries(c.ws))
    .filter((x) => BigInt(x.position) > BigInt(after) && x.method === 'session/update')
    .map((x) => String((x.content.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? ''))
    .join('')

const last = async (c: Context): Promise<string> => (await c.lab.entries(c.ws)).at(-1)!.position

test('L57 an anchor before the last exchanges: restored, then the exchanges after it given with the first prompt', async (t) => {
  const c = await opened(t, { receiver: true })
  await turn(c, 'mirabelle')
  const anchor = String((await end(c, c.e)).content.anchor)
  // Continued with no anchor named: Agora restores the Workstream's own, and has nothing to give.
  const second = await create(c)
  assert.deepEqual(schemaValue([(await opening(c, second)).content.origin, (await opening(c, second)).content.catchUp]), [anchor, 0])
  await turn(c, 'quetsche')
  assert.equal((await prompts(c, second))[0]!.some(isCatchUp), false)
  assert.equal((await end(c, second, true)).content.anchor, null)

  const third = await create(c)
  const opened3 = await opening(c, third)
  assert.deepEqual(schemaValue([opened3.content.origin, opened3.content.catchUp, opened3.content.omitted]), [anchor, 1, 0])
  await turn(c, 'reine-claude')
  const [prompt] = await prompts(c, third)
  const block = prompt![0] as { text: string; _meta: Record<string, unknown> }
  assert.ok(isCatchUp(block))
  assert.deepEqual(schemaValue(block._meta[CATCH_UP_META]), { exchanges: 1, omitted: 0 })
  assert.match(block.text, /restored from a save that does not hold/)
  assert.match(block.text, /<user>\nquetsche\n<\/user>/)
  assert.doesNotMatch(block.text, /<user>\nmirabelle/, 'what the anchor holds is not given again')
  assert.deepEqual(prompt!.slice(1), [{ type: 'text', text: 'reine-claude' }])
  // Only the first prompt carries it.
  const before = await last(c)
  await turn(c, '/recall')
  assert.equal((await prompts(c, third))[1]!.some(isCatchUp), false)
  const recalled = await said(c, before)
  assert.match(recalled, /"mirabelle"/)
  assert.match(recalled, /quetsche/)

  // The thread shows the user's message, not the catch-up; the view says what a Create would give.
  const objects = project(await c.lab.entries(c.ws)).map((o) => o.object as Record<string, unknown>)
  const user = objects.find((o) => o.type === 'user' && (o.content as unknown[]).some((b) => (b as { text?: string }).text === 'reine-claude'))!
  assert.deepEqual(schemaValue([user.content, user.catchUp]), [[{ type: 'text', text: 'reine-claude' }], { exchanges: 1, omitted: 0 }])
  const notice = objects.find((o) => o.type === 'session.opened' && o.execution === third.id)!
  assert.deepEqual(schemaValue([notice.origin, notice.catchUp, notice.omitted]), [anchor, 1, 0])
  const view = objects.find((o) => o.id === c.ws)!
  assert.equal(view.exchanges, 4)
  // The third has not ended: its anchor is not there yet; the first's lacks the three after it.
  assert.deepEqual(view.continuation, { mock: { anchor, exchanges: 3 } })
})

test('L58 no anchor at all: a new Session, and every exchange given with its first prompt', async (t) => {
  const c = await opened(t, { receiver: true })
  await turn(c, 'mirabelle')
  await turn(c, 'quetsche')
  assert.equal((await end(c, c.e, true)).content.anchor, null)
  const view = project(await c.lab.entries(c.ws)).find((o) => o.id === c.ws)!.object
  assert.deepEqual([view.exchanges, view.continuation], [2, {}])

  const second = await create(c)
  assert.deepEqual(schemaValue([(await opening(c, second)).content.origin, (await opening(c, second)).content.catchUp]), ['new', 2])
  await turn(c, 'prune')
  const block = (await prompts(c, second))[0]![0] as { text: string }
  assert.ok(isCatchUp(block))
  assert.match(block.text, /no save of it could be restored/)
  assert.ok(block.text.indexOf('mirabelle') < block.text.indexOf('quetsche'), 'oldest first')
  const before = await last(c)
  await turn(c, '/recall')
  assert.match(await said(c, before), /mirabelle/)
})

test('L59 a pool of the same harness under another name, as after a new image: the anchor restored', async (t) => {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  kube.morePools.push(['mock-next', 'mock'])
  const c = await opened(t, { kube, keys: pair, receiver: true })
  await turn(c, 'mirabelle')
  const anchor = String((await end(c, c.e)).content.anchor)
  const next = await create(c, 'mock-next')
  assert.equal((await opening(c, next)).content.origin, anchor)
  const before = await last(c)
  await turn(c, '/recall')
  assert.match(await said(c, before), /"mirabelle"/)
})

test('L60 a first message that is a command does not carry the catch-up; the next one does', async (t) => {
  const c = await opened(t, { receiver: true })
  await turn(c, 'mirabelle')
  await end(c, c.e, true)
  const second = await create(c)
  await turn(c, '/recall')
  await turn(c, 'prune')
  await turn(c, 'abricot')
  assert.deepEqual((await prompts(c, second)).map((p) => p.some(isCatchUp)), [false, true, false])
})

test('L63 a catch-up never given — its execution ended before a message — is given by the next one', async (t) => {
  const c = await opened(t, { receiver: true })
  await turn(c, 'mirabelle')
  await end(c, c.e)
  const second = await create(c)
  await turn(c, 'quetsche')
  await end(c, second, true)
  // Restored, the exchange after its anchor due with a first message that never comes; its own anchor saved.
  const third = await create(c)
  const anchor3 = String((await end(c, third)).content.anchor)
  const fourth = await create(c)
  const opened4 = await opening(c, fourth)
  assert.deepEqual(schemaValue([opened4.content.origin, opened4.content.catchUp]), [anchor3, 1])
  await turn(c, 'prune')
  assert.match(((await prompts(c, fourth))[0]![0] as { text: string }).text, /<user>\nquetsche\n<\/user>/)
})

test('L64 an anchor that failed to restore is not restored again: a new Session, given every exchange', async (t) => {
  // An adapter that reads its files only at start, without the image saying so: a resume fails.
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  kube.bridgeFactory = async (publicKey, pod) => {
    const bridge = await mockBridge(publicKey, pod, { readAtStart: true, restartOnAnchor: false })
    await until('the adapter started', () => existsSync(join(bridge.home, '.mock-agent', 'read-at-start')))
    return bridge
  }
  const c = await opened(t, { kube, keys: pair, receiver: true })
  await turn(c, 'mirabelle')
  const anchor = String((await end(c, c.e)).content.anchor)
  const answer = (await c.lab.command(c.ws, 'Create', {}, { pool: 'mock-test' })) as { execution?: string }
  // The agent refuses the resume; the execution waits for its deadline (#109).
  await until('the resume refused', async () =>
    (await c.lab.entries(c.ws)).find((x) => x.execution === answer.execution && x.correlated_method === 'session/resume' && x.rpc_kind === 'error'),
  )
  await end(c, (await c.lab.state(c.ws)).executions.get(String(answer.execution))!)
  const view = project(await c.lab.entries(c.ws)).find((o) => o.id === c.ws)!.object
  assert.deepEqual(view.continuation, {}, 'neither the anchor that failed nor the one its execution pushed')
  const third = await create(c)
  const opened3 = await opening(c, third)
  assert.notEqual(opened3.content.origin, anchor)
  assert.deepEqual(schemaValue([opened3.content.origin, opened3.content.catchUp]), ['new', 1])
})

// ---------------------------------------------------------------- the text, from entries alone

let position = 0
const at = (fields: Partial<Entry>): Entry =>
  ({
    workstream: 'w',
    position: String(++position),
    time: '',
    kind: 'acp',
    execution: 'e1',
    session: 's1',
    content: {},
    direction: null,
    rpc_kind: null,
    method: null,
    correlated_method: null,
    request_position: null,
    rpc_id: null,
    command: null,
    connection: null,
    receive_ordinal: null,
    ...fields,
  }) as Entry

function history(): Entry[] {
  position = 0
  const create = (execution: string) => at({ kind: 'command', execution, session: null, content: { kind: 'Create', claimName: execution, body: {} } })
  const prompt = (execution: string, session: string, blocks: unknown[], dispatch = true) => {
    const p = at({ kind: 'acp', execution, session, direction: 'out', rpc_kind: 'request', method: 'session/prompt', rpc_id: `p${String(position + 1)}`, content: { params: { prompt: blocks } } })
    return dispatch ? [p, at({ kind: 'acp.dispatching', execution, session, content: { requestPosition: p.position } })] : [p]
  }
  const update = (execution: string, session: string, u: Record<string, unknown>) =>
    at({ kind: 'acp', execution, session, direction: 'in', rpc_kind: 'notification', method: 'session/update', content: { params: { update: u } } })
  return [
    create('e1'),
    ...prompt('e1', 's1', [{ type: 'text', text: 'first' }]),
    update('e1', 's1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Rea' } }),
    update('e1', 's1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ding.' } }),
    update('e1', 's1', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read README.md', status: 'pending' }),
    update('e1', 's1', { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' }),
    update('e1', 's1', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden thought' } }),
    ...prompt('e1', 's1', [{ type: 'text', text: 'never sent' }], false),
    create('e2'),
    ...prompt('e2', 's2', [{ type: 'text', text: 'old catch-up', _meta: { [CATCH_UP_META]: { exchanges: 1 } } }, { type: 'text', text: 'second' }]),
    update('e2', 's2', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } }),
  ]
}

test('L61 the exchanges: dispatched prompts only, their text and tools in order, no thought, no earlier catch-up', () => {
  const entries = history()
  const positions = dispatched(fold(entries))
  assert.equal(positions.length, 2, 'the prompt never dispatched is not an exchange')
  assert.deepEqual(
    exchangesOf(entries, positions).map(({ user, agent }) => ({ user, agent })),
    [
      { user: 'first', agent: 'Reading.\n[tool: Read README.md — failed]' },
      { user: 'second', agent: 'Done.' },
    ],
  )
})

test('L62 a catch-up longer than its maximum keeps the most recent exchanges and says how many it left out', () => {
  const big = 'x'.repeat(19_000)
  const exchanges = Array.from({ length: 12 }, (_, i) => ({ position: String(i + 1), user: `message ${String(i)}`, agent: big }))
  const result = catchUpText(exchanges, false)
  assert.ok(result.omitted > 0)
  assert.equal(result.turns.length + result.omitted, 12)
  assert.equal(result.turns.at(-1), '12')
  assert.ok(result.text.length < CATCH_UP_MAX + 1_000)
  assert.match(result.text, /message 11\n/)
  assert.doesNotMatch(result.text, /message 0\n/)
  assert.match(result.text, new RegExp(`${String(result.omitted)} earlier exchanges are left out`))
  // Given again later, the same exchanges and the same count left out.
  const again = catchUpText(exchanges.filter((x) => result.turns.includes(x.position)), false, result.omitted)
  assert.deepEqual([again.text, again.turns, again.omitted], [result.text, result.turns, result.omitted])
})
