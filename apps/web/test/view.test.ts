// docs/specs/assistant-ui.md, acceptance cases: the client's objects and conversion, on the objects the
// log's projection folds from a real history (test/fixtures/mock.json: the log, real bridges and the
// mock agent, captured by scripts/capture.fixture.ts), cut at each moment that matters.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { CoreProjection, decode, project, type Entry } from '@agora/log'
import { apply, empty, type ThreadRow, type ThreadState } from '../src/agora/objects.ts'
import { diffStats, labelOf, type Artifact } from '../src/agora/tools.ts'
import {
  accessEntries,
  accessGranted,
  accessLabel,
  accessOf,
  commandsMatching,
  composerOf,
  continueBody,
  createBody,
  firstMessageStep,
  messagesOf,
  modelChoice,
  noticeText,
  offeredPools,
  poolOffered,
  planItems,
  poolSettings,
  sections,
  startBody,
  withAccess,
  workstreamOf,
  type WorkstreamView,
} from '../src/agora/view.ts'

const fixture = decode(await readFile(new URL('fixtures/mock.json', import.meta.url), 'utf8')) as {
  workstream: string
  marks: Record<string, string>
  entries: Entry[]
}
const ws = fixture.workstream
const upTo = (position: string): Entry[] => fixture.entries.filter((e) => BigInt(e.position) <= BigInt(position))

/** The thread read whole at that position: a snapshot from zero, then its end. */
function at(position: string): ThreadState {
  let state = empty
  for (const o of project(upTo(position))) state = apply(state, { type: 'snapshot', position, operation: 'upsert', kind: o.kind, id: o.id, object: o.object as Record<string, unknown> })
  return apply(state, { type: 'snapshot-end', position })
}

/** The rows the projector appends, one per change, as the thread delivers them live. */
function rowsOf(entries: readonly Entry[]): ThreadRow[] {
  const projection = new CoreProjection()
  const rows: ThreadRow[] = []
  let position = 0n
  for (const entry of entries)
    for (const id of projection.apply([entry])) {
      const o = projection.objects.get(id)!
      rows.push({ type: 'live', position: String(++position), operation: 'upsert', kind: o.kind, id, object: o.object as Record<string, unknown> })
    }
  return rows
}

const last = fixture.entries.at(-1)!.position
const firstPrompt = fixture.entries.find((e) => e.kind === 'acp' && e.method === 'session/prompt' && e.direction === 'out')!
const turnStatus = (m: { metadata?: { custom?: Record<string, unknown> } }) => m.metadata?.custom?.turnStatus
const texts = (state: ThreadState) => messagesOf(state).map((m) => `${m.role}:${(m.content as unknown as { type: string; text?: string }[]).map((p) => p.text ?? p.type).join('|')}`)

test('U1 objects read from zero, then again from a cursor: the same messages, in order; commands wait for snapshot-end', () => {
  const whole = at(last)
  const rows = rowsOf(fixture.entries)
  // Read up to a cursor in the middle, then live: the same objects as one read from zero.
  const middle = Math.floor(rows.length / 2)
  let state = empty
  for (const row of rows.slice(0, middle)) state = apply(state, { ...row, type: 'snapshot' })
  state = apply(state, { type: 'snapshot-end', position: rows[middle - 1]!.position })
  for (const row of rows.slice(middle)) state = apply(state, row)
  // A row read twice changes nothing.
  for (const row of rows.slice(middle, middle + 5)) state = apply(state, row)
  assert.deepEqual(texts(state), texts(at(last)))
  assert.deepEqual(messagesOf(state).map((m) => m.id), messagesOf(whole).map((m) => m.id))
  const loading = apply(empty, { type: 'snapshot', position: '1', operation: 'upsert', kind: 'workstream', id: ws, object: { state: 'ready' } })
  const composer = composerOf(loading, workstreamOf(loading, ws))
  assert.deepEqual([composer.open, composer.reason], [false, 'Loading…'])
})

test('U2 a turn saved, in progress, then done', () => {
  const saved = messagesOf(at(firstPrompt.position)).filter((m) => m.role !== 'system')
  assert.equal(turnStatus(saved[0]!), 'saved')
  assert.deepEqual([saved[1]!.status, saved[1]!.content], [{ type: 'running' }, []])
  const running = messagesOf(at(fixture.marks.inProgress!)).filter((m) => m.role === 'assistant').at(-1)!
  assert.deepEqual(running.status, { type: 'running' })
  const done = messagesOf(at(last)).filter((m) => m.role !== 'system')
  assert.equal(turnStatus(done[0]!), 'done')
  assert.deepEqual(done[0]!.content, [{ type: 'text', text: 'Hello agent\nwith a second line' }])
  assert.deepEqual(done[1]!.status, { type: 'complete', reason: 'stop' })
  const planned = done[3]!.content as unknown as { type: string; text?: string; name?: string }[]
  assert.deepEqual(planned.map((p) => p.type), ['reasoning', 'data', 'text'])
  assert.deepEqual([planned[0]!.text, planned[2]!.text], ['Planning the change.', 'Here is the plan.'])
})

test('U3 an uncertain turn: its badge, its explanation, Cancel targeting it and Stop', () => {
  const state = at(fixture.marks.uncertain!)
  const messages = messagesOf(state).filter((m) => m.role !== 'system')
  const [user, assistant] = messages.slice(-2)
  assert.equal(turnStatus(user!), 'uncertain')
  assert.deepEqual(assistant!.status, { type: 'incomplete', reason: 'other', error: 'The end of this turn could not be confirmed.' })
  const view = workstreamOf(state, ws)
  const composer = composerOf(state, view)
  assert.equal(composer.open, false)
  assert.equal(composer.uncertain?.id, user!.metadata!.custom!.turn)
  assert.equal(composer.cancellable?.id, composer.uncertain?.id)
  assert.equal(composer.running, false)
  assert.ok(view.execution !== null, 'Stop has its target')
})

test('U4 a permission pending, answered, and another pending when its turn is cancelled', () => {
  const pending = at(fixture.marks.permissionPending!)
  const assistant = messagesOf(pending).filter((m) => m.role === 'assistant').at(-1)!
  assert.deepEqual(assistant.status, { type: 'requires-action', reason: 'tool-calls' })
  const call = (assistant.content as unknown as { type: string; approval?: Record<string, unknown> }[]).find((p) => p.type === 'tool-call')!
  assert.deepEqual(call.approval!.options, [
    { id: 'allow-once', kind: 'allow-once', label: 'Allow' },
    { id: 'reject-once', kind: 'reject-once', label: 'Reject' },
  ])
  assert.ok(!('optionId' in call.approval!) && !('resolution' in call.approval!))
  assert.equal(composerOf(pending, workstreamOf(pending, ws)).reason, 'Answer the permission request above.')
  const approvals = messagesOf(at(last))
    .flatMap((m) => (m.role === 'assistant' ? (m.content as unknown as { type: string; approval?: Record<string, unknown> }[]) : []))
    .filter((p) => p.approval)
    .map((p) => p.approval!)
  assert.equal(approvals.length, 2)
  assert.deepEqual([approvals[0]!.optionId, approvals[0]!.approved], ['allow-once', true])
  assert.equal(approvals[1]!.resolution, 'cancelled')
})

test('U5 a tool through its updates with a diff, and a plan', () => {
  const parts = messagesOf(at(last)).flatMap((m) => (m.role === 'assistant' ? (m.content as unknown as Record<string, unknown>[]) : []))
  const edits = parts.filter((p) => p.type === 'tool-call' && (p.artifact as { diffs: unknown[] }).diffs.length > 0)
  assert.equal(edits.length, 1)
  const edit = edits[0]!
  assert.deepEqual([edit.toolName, edit.isError, edit.result, (edit.artifact as { title: string }).title], ['edit', false, '(no output)', 'Edit demo.txt'])
  const diff = (edit.artifact as { diffs: Record<string, unknown>[] }).diffs[0]!
  assert.deepEqual([String(diff.path).endsWith('/demo.txt'), diff.oldText, diff.newText], [true, 'before\n', 'after\n'])
  const plan = parts.find((p) => p.type === 'data' && p.name === 'plan')!
  assert.deepEqual(planItems((plan.data as { entries: unknown[] }).entries).map((i) => i.status), ['done', 'active', 'pending'])
})

test('U6 a reset in the stream: the objects cleared, the complete state applied, nothing twice', () => {
  const rows = rowsOf(fixture.entries)
  let state = empty
  for (const row of rows) state = apply(state, { ...row, type: 'snapshot' })
  state = apply(state, { type: 'snapshot-end', position: rows.at(-1)!.position })
  const whole = at(last)
  // A rebuild: reset, then every object again, live.
  let position = BigInt(state.cursor)
  state = apply(state, { type: 'live', position: String(++position), operation: 'reset', kind: null, id: null, object: null })
  assert.equal(state.objects.size, 0)
  for (const o of whole.objects.values()) state = apply(state, { type: 'live', position: String(++position), operation: 'upsert', kind: o.kind, id: o.id, object: o.object })
  assert.deepEqual(texts(state), texts(whole))
  assert.equal(new Set(messagesOf(state).map((m) => m.id)).size, messagesOf(state).length)
})

test('U9 an execution ended with an anchor: a message continues it in the same pool, from nothing in another; then the restored Session', () => {
  const ended = at(fixture.marks.ended!)
  const view = workstreamOf(ended, ws)
  assert.equal(view.state, 'ended')
  assert.equal(typeof view.anchor, 'string')
  assert.deepEqual(continueBody(view), { pool: 'mock-test', anchor: view.anchor })
  assert.deepEqual(createBody(view, 'mock-test'), { pool: 'mock-test', anchor: view.anchor })
  assert.deepEqual(createBody(view, 'claude-code'), { pool: 'claude-code' })
  const after = messagesOf(at(fixture.marks.restored!)).filter((m) => m.role === 'system').map((m) => (m.content as unknown as { text: string }[])[0]!.text)
  assert.equal(after.at(-1), 'Session restored with Mock agent: the agent remembers the history above.')
})

test('U10 each notice type: its text', () => {
  const notices = messagesOf(at(last))
    .filter((m) => m.role === 'system')
    .map((m) => [m.metadata!.custom!.notice, (m.content as unknown as { text: string }[])[0]!.text])
  // A Session's end is not shown: the execution's own notice says it; nor a break its loss follows.
  assert.deepEqual(notices, [
    ['session.opened', 'Session started with Mock agent.'],
    ['execution.break', 'The connection to the sandbox was interrupted.'],
    ['execution.lost', "The agent's process exited. The history is kept."],
    ['execution.ended', 'The sandbox has ended.'],
    ['session.opened', 'Session restored with Mock agent: the agent remembers the history above.'],
  ])
  assert.equal(noticeText({ type: 'session.opened', origin: 'new', harness: 'codex' }, false), 'New session with Codex: the agent does not know the history above.')
  assert.equal(noticeText({ type: 'session.ended', reason: 'replaced' }, false), 'Another session replaced this one.')
  assert.equal(noticeText({ type: 'request.failed', reason: 'deadline_refused' }, false), "The sandbox's deadline could not be extended.")
  assert.equal(noticeText({ type: 'request.failed', reason: 'something_new' }, false), 'A request to the agent failed.')
  assert.equal(noticeText({ type: 'execution.failed', reason: 'startup_failed' }, false), 'The sandbox could not start.')
  assert.equal(noticeText({ type: 'execution.lost', reason: 'claim_missing' }, false), 'The sandbox disappeared. The history is kept.')
  // No reason code reaches the screen.
  for (const [, text] of notices) assert.doesNotMatch(String(text), /[a-z]+_[a-z]+/)
})

test('U11 each Workstream state: the composer and its reason', () => {
  const created = fixture.entries.find((e) => e.kind === 'command' && e.content.kind === 'Create')!
  // [position, state, sending offered, sending starts an execution, why not]
  const cases: [string, string, boolean, boolean, string | null][] = [
    [created.position, 'starting', false, false, 'Starting the sandbox…'],
    [fixture.marks.opened!, 'ready', true, false, null],
    [fixture.marks.uncertain!, 'interrupted', false, false, 'Reconnecting to the sandbox…'],
    [fixture.marks.lost!, 'lost', false, false, 'The sandbox was lost. It ends at its deadline; then a new one can start.'],
    [fixture.marks.ended!, 'ended', true, true, null],
    [fixture.marks.stopped!, 'stopped', false, false, 'Stopped. The sandbox ends at its deadline.'],
  ]
  for (const [position, expected, open, create, reason] of cases) {
    const state = at(position)
    const view = workstreamOf(state, ws)
    const composer = composerOf(state, view)
    assert.deepEqual([view.state, composer.open, composer.create, composer.reason], [expected, open, create, reason], `at ${position}`)
  }
  const none = workstreamOf(at('0'), ws)
  assert.equal(none.state, 'none')
  const failed: WorkstreamView = { ...workstreamOf(at(last), ws), state: 'failed' }
  assert.deepEqual([composerOf(at(last), failed).open, composerOf(at(last), failed).create], [true, true])
})

// The real histories of the three harnesses (test/fixtures/<harness>.json: a tool-heavy task played on
// the deployed server, entries read back through its test route).
const real = async (harness: string) => {
  const f = decode(await readFile(new URL(`fixtures/${harness}.json`, import.meta.url), 'utf8')) as { workstream: string; entries: Entry[] }
  const position = f.entries.at(-1)!.position
  let state = empty
  for (const o of project(f.entries)) state = apply(state, { type: 'snapshot', position, operation: 'upsert', kind: o.kind, id: o.id, object: o.object as Record<string, unknown> })
  state = apply(state, { type: 'snapshot-end', position })
  const tools = messagesOf(state)
    .flatMap((m) => (m.role === 'assistant' ? (m.content as unknown as Record<string, unknown>[]) : []))
    .filter((p) => p.type === 'tool-call')
  return { state, tools, artifact: (p: Record<string, unknown>) => p.artifact as Artifact & { diffs: Diff[] } }
}
type Diff = { path?: string; oldText?: string | null; newText?: string }

test('U12 claude-code for real: each change carries its diff, taken from the permission it asked; the permissions answered', async () => {
  const { tools, artifact } = await real('claude-code')
  const labels = tools.map((t) => labelOf(artifact(t), String(t.toolName)))
  assert.deepEqual(labels.filter((l) => /^(Write|Edit) /.test(l)), ['Write fizzbuzz.js', 'Write fizzbuzz.test.js', 'Edit fizzbuzz.js', 'Edit fizzbuzz.js', 'Edit fizzbuzz.test.js'])
  const edits = tools.filter((t) => artifact(t).kind === 'edit')
  assert.ok(edits.every((t) => artifact(t).diffs.length === 1), 'every edit has its diff')
  assert.deepEqual(diffStats(artifact(edits[0]!).diffs), { added: 12, removed: 0 })
  const approvals = tools.map((t) => t.approval as { optionId?: string } | undefined)
  assert.ok(approvals.every((a) => a?.optionId === 'allow-once'), 'every tool was allowed once')
})

test('U13 codex and opencode for real: commands without their shell, failures marked, a todo list as a list', async () => {
  const codex = await real('codex')
  const commands = codex.tools.filter((t) => codex.artifact(t).kind === 'execute').map((t) => labelOf(codex.artifact(t), String(t.toolName)))
  assert.ok(commands.length >= 3)
  assert.ok(commands.every((c) => !c.startsWith('/usr/bin/bash -lc')), commands.join(' | '))
  assert.ok(codex.tools.some((t) => t.isError === true), 'a failed command is marked')
  const opencode = await real('opencode')
  const todos = opencode.tools.map((t) => opencode.artifact(t).todos).find((t) => t !== undefined)
  assert.deepEqual(todos?.map((t) => t.content), ['Create fizzbuzz.js', 'Create fizzbuzz.test.js', 'Run node --test', 'Rename to fizzBuzz and rerun tests'])
  const written = opencode.tools.filter((t) => opencode.artifact(t).kind === 'edit').map((t) => labelOf(opencode.artifact(t), String(t.toolName)))
  assert.ok(written.includes('Edit fizzbuzz.js'), written.join(' | '))
  const reasoning = messagesOf(opencode.state).flatMap((m) => (m.role === 'assistant' ? (m.content as unknown as { type: string }[]) : [])).filter((p) => p.type === 'reasoning')
  assert.ok(reasoning.length > 0, 'its reasoning is kept')
})

test('U14 the Workstream list: by the day it last changed, without the empty ones but the open one, and searched by title', () => {
  const now = new Date(2026, 9, 3, 15, 0)
  const at = (d: number, h = 10) => new Date(2026, 9, 3 - d, h).toISOString()
  const w = (id: string, title: string, changedAt: string | null, state: WorkstreamView['state'] = 'ended'): WorkstreamView => ({
    id, title, state, changedAt, pool: null, harness: null, execution: null, session: null, anchor: null,
  })
  const list = [w('a', 'Fix the login', at(0)), w('b', 'Rename fizzbuzz', at(1)), w('c', 'Old task', at(5)), w('d', 'Ancient', at(40)), w('e', 'New workstream', null, 'none'), w('f', 'New workstream', null, 'none')]
  assert.deepEqual(sections(list, now, '', null).map((s) => [s.label, s.workstreams.map((x) => x.id)]), [
    ['Today', ['a']],
    ['Yesterday', ['b']],
    ['Previous 7 days', ['c']],
    ['Older', ['d']],
  ])
  assert.deepEqual(sections(list, now, '', 'e')[0]!.workstreams.map((x) => x.id), ['a', 'e'])
  assert.deepEqual(sections(list, now, 'FIZZ', null).map((s) => s.workstreams.map((x) => x.id)), [['b']])
})

test('U15 a first message waits for the Session its Create opens: written once ready, given back if the execution fails', () => {
  const base: WorkstreamView = { id: 'w', title: 't', state: 'starting', pool: 'p', harness: 'mock', execution: 'e1', session: null, anchor: null }
  assert.equal(firstMessageStep('e1', base, false), 'wait')
  assert.equal(firstMessageStep('e1', base, true), 'wait')
  assert.equal(firstMessageStep('e1', { ...base, execution: 'e0', state: 'ended' }, true), 'wait')
  assert.equal(firstMessageStep('e1', { ...base, state: 'ready', session: 's' }, true), 'write')
  for (const state of ['failed', 'ended', 'lost'] as const) assert.equal(firstMessageStep('e1', { ...base, state }, true), 'give back')
})

test('U25 the real harnesses settings: the model and the effort without default, the current marked; no mode offered', async () => {
  const pick = async (harness: string) => {
    const { state } = await real(harness)
    const f = decode(await readFile(new URL(`fixtures/${harness}.json`, import.meta.url), 'utf8')) as { workstream: string }
    return modelChoice(workstreamOf(state, f.workstream).settings)
  }
  const claude = await pick('claude-code')
  assert.deepEqual(claude.models.map((o) => o.value), ['sonnet', 'opus', 'haiku'])
  assert.deepEqual(claude.efforts.map((o) => o.value), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(claude.current, { model: null, effort: null }, 'its current values are default: none shown as chosen')
  const codex = await pick('codex')
  assert.equal(codex.models.length, 8)
  assert.deepEqual(codex.current, { model: 'gpt-6.1-sol', effort: 'low' })
  assert.deepEqual(codex.efforts.map((o) => o.value), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  const opencode = await pick('opencode')
  assert.deepEqual(opencode.efforts.map((o) => o.value), ['low', 'high', 'max'])
  assert.equal(opencode.current.model, 'zai-coding-plan/glm-5.3')
  // Neither picker reads the mode.
  for (const c of [claude, codex, opencode]) assert.deepEqual([c.model?.category, c.effort?.category], ['model', 'thought_level'])
  // Before a Session: the pool's declared values stand for the current ones; a pick wins over both.
  const settings = workstreamOf((await real('claude-code')).state, (decode(await readFile(new URL('fixtures/claude-code.json', import.meta.url), 'utf8')) as { workstream: string }).workstream).settings
  const declared = poolSettings({ sessionConfig: [{ id: 'model', value: 'opus' }, { id: 'effort', value: 'high' }], settings })
  assert.deepEqual(modelChoice(declared).current, { model: 'opus', effort: 'high' })
  assert.deepEqual(modelChoice(declared, { model: 'haiku' }).current, { model: 'haiku', effort: 'high' })
})

test('U26 the commands: all at /, those starting with what is typed, none once a space follows', async () => {
  const { state } = await real('codex')
  const f = decode(await readFile(new URL('fixtures/codex.json', import.meta.url), 'utf8')) as { workstream: string }
  const commands = workstreamOf(state, f.workstream).commands ?? []
  assert.ok(commands.length >= 10)
  assert.equal(commandsMatching(commands, '/').length, commands.length)
  assert.deepEqual(commandsMatching(commands, '/re').map((c) => c.name), ['review', 'review-branch', 'review-commit', 'rename'].filter((n) => commands.some((c) => c.name === n)))
  assert.deepEqual(commandsMatching(commands, '/RE').map((c) => c.name), commandsMatching(commands, '/re').map((c) => c.name))
  assert.deepEqual(commandsMatching(commands, '/review the branch'), [])
  assert.deepEqual(commandsMatching(commands, 'review'), [])
})

test('U30 a pool kept for the tests: not offered; an ended Workstream of that pool continues in another', () => {
  const pools = [
    { name: 'mock-1', testing: true },
    { name: 'claude-1', testing: false },
    { name: 'codex-1' },
  ]
  assert.deepEqual(offeredPools(pools).map((p) => p.name), ['claude-1', 'codex-1'])
  assert.equal(poolOffered(pools, null, 'mock-1', null), 'claude-1', 'its own pool is for the tests')
  assert.equal(poolOffered(pools, null, 'mock-1', 'codex-1'), 'codex-1', 'the one picked last')
  assert.equal(poolOffered(pools, null, 'codex-1', 'claude-1'), 'codex-1', 'its own, so it continues')
  assert.equal(poolOffered(pools, 'mock-1', null, null), 'claude-1', 'never one kept for the tests')
  assert.equal(poolOffered([{ name: 'mock-1', testing: true }], null, null, null), null)
})

test('U31 the access picker: each offered repository with None, Read and, when offered, Write; a service Off and On; the button', () => {
  const entries = accessEntries(['github:o/a:write', 'github:o/b:read', 'zai', 'internet'])
  assert.deepEqual(
    entries.map((e) => [e.name, e.choices.map((c) => c.label)]),
    [
      ['o/a', ['None', 'Read', 'Write']],
      ['o/b', ['None', 'Read']],
      ['z.ai', ['Off', 'On']],
      ['Internet', ['Off', 'On']],
    ],
  )
  assert.equal(accessLabel([], entries), 'No access')
  assert.equal(accessLabel(['github:o/a:read'], entries), 'a · Read')
  assert.equal(accessLabel(['internet'], entries), 'Internet')
  assert.equal(accessOf(['github:o/a:read'], entries[0]!), 'github:o/a:read')
  assert.equal(accessLabel(['github:o/a:write', 'github:o/b:read'], entries), '2 repos')
  assert.equal(accessLabel(['github:o/a:write', 'zai'], entries), '2 grants')
  assert.deepEqual(accessEntries([]), [])
})

test('U32 an access choice gives the whole set: the entries in the order offered, then what was granted beyond them', () => {
  const entries = accessEntries(['github:o/a:write', 'github:o/b:read'])
  const [a] = entries
  const granted = withAccess(['github:o/b:read'], entries, a!, 'github:o/a:write')
  assert.deepEqual(granted, ['github:o/a:write', 'github:o/b:read'])
  assert.deepEqual(withAccess(granted, entries, a!, null), ['github:o/b:read'])
  assert.deepEqual(withAccess(['github:x/y:read'], entries, a!, 'github:o/a:read'), ['github:o/a:read', 'github:x/y:read'])
})

test('U33 an ended Workstream whose execution had profiles: its Create carries them; another access picked, that one', () => {
  const view = { ...workstreamOf(at(fixture.marks.ended!), ws), profiles: ['github:o/a:read'] }
  assert.deepEqual(startBody(view, 'mock-test', false, {}, accessGranted(null, view)), { pool: 'mock-test', anchor: view.anchor, profiles: ['github:o/a:read'] })
  assert.deepEqual(startBody(view, 'mock-test', false, { model: 'mock-large' }, accessGranted([], view)), { pool: 'mock-test', anchor: view.anchor, settings: { model: 'mock-large' } })
  const draft = workstreamOf(empty, '')
  assert.deepEqual(startBody(draft, 'mock-test', true, {}, accessGranted(null, draft)), { pool: 'mock-test' })
})
