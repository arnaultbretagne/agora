// docs/specs/assistant-ui.md, acceptance cases: the client's objects and conversion, on the objects the
// log's projection folds from a real history (test/fixtures/mock.json: the log, real bridges and the
// mock agent, captured by scripts/capture.fixture.ts), cut at each moment that matters.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { CoreProjection, decode, project, type Entry } from '@agora/log'
import { apply, empty, type ThreadRow, type ThreadState } from '../src/agora/objects.ts'
import { diffStats, labelOf, type Artifact } from '../src/agora/tools.ts'
import { acceptOf, blockOf, prepare, promptOf, refusalOf, TEXT_MAX } from '../src/agora/attachments.ts'
import {
  accessDefault,
  accessDisplay,
  accessEntries,
  accessGranted,
  accessLabel,
  accessTitle,
  accessOf,
  commandsMatching,
  composerOf,
  continuationNote,
  firstMessageStep,
  messagesOf,
  modelChoice,
  noticeText,
  offeredPools,
  poolOffered,
  planItems,
  poolLimits,
  poolSettings,
  resetIn,
  sections,
  startBody,
  windowName,
  withAccess,
  workstreamOf,
  type AccountLimits,
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

test('U9 an execution ended with an anchor, then a message: the Create carries the pool alone; what the agent will be given, said before sending; then the restored Session', () => {
  const ended = at(fixture.marks.ended!)
  const view = workstreamOf(ended, ws)
  assert.equal(view.state, 'ended')
  assert.equal(typeof view.anchor, 'string')
  assert.deepEqual(view.continuation, { mock: { anchor: view.anchor, exchanges: 0 } })
  assert.ok(view.exchanges! > 0)
  // Which save it continues from is the server's to find, whatever the pool's name.
  assert.deepEqual(startBody('mock-test', {}, []), { pool: 'mock-test' })
  // Its harness's save holds everything: nothing to say. Another harness has none: all of it, as text.
  assert.equal(continuationNote(view, 'mock'), null)
  assert.equal(continuationNote(view, 'claude-code'), `No saved Claude Code session: the ${String(view.exchanges)} exchanges above go to the agent as text.`)
  assert.equal(
    continuationNote({ ...view, continuation: { mock: { anchor: 'a', exchanges: 1 } } }, 'mock'),
    'Mock agent resumes its saved session; the 1 exchange since then goes to it as text.',
  )
  assert.equal(continuationNote(workstreamOf(empty, ''), 'mock'), null, 'a draft: nothing above')
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
  // With what its first prompt gives (docs/specs/log.md, "Continuing").
  assert.equal(
    noticeText({ type: 'session.opened', origin: 'a1', harness: 'mock', catchUp: 2, omitted: 0 }, false),
    'Session restored with Mock agent. The 2 exchanges since its last save go to the agent with your next message.',
  )
  assert.equal(noticeText({ type: 'session.opened', origin: 'a1', harness: 'mock', catchUp: 0, omitted: 0 }, false), 'Session restored with Mock agent: the agent remembers the history above.')
  assert.equal(
    noticeText({ type: 'session.opened', origin: 'new', harness: 'codex', catchUp: 3, omitted: 1 }, false),
    'New session with Codex. The 3 exchanges above go to the agent with your next message (the 1 exchange before them left out for length).',
  )
  assert.equal(noticeText({ type: 'session.opened', origin: 'new', harness: 'codex', catchUp: 0, omitted: 0 }, false), 'New session with Codex.')
  assert.equal(noticeText({ type: 'session.opened', origin: 'new', harness: 'codex', catchUp: 0, omitted: 0 }, true), 'Session started with Codex.')
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
  // Its own pool gone with an older image: one of its harness, so that it continues.
  const harnessed = [
    { name: 'claude-code-new', harness: 'claude-code' },
    { name: 'codex-1', harness: 'codex' },
  ]
  assert.equal(poolOffered(harnessed, null, 'claude-code-old', 'codex-1', 'claude-code'), 'claude-code-new')
  assert.equal(poolOffered(harnessed, 'codex-1', 'claude-code-old', null, 'claude-code'), 'codex-1', 'the one picked here first')
})

test('U31 the rights: each offered repository with None, Read and, when offered, Write; a service off or on; the services first, the Internet first; the button', () => {
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
  assert.deepEqual(accessDisplay(entries).map((e) => e.name), ['Internet', 'z.ai', 'o/a', 'o/b'], 'the services first, the Internet first')
  assert.equal(accessLabel([], entries), 'No access')
  assert.equal(accessLabel(['internet'], entries), 'Internet')
  assert.equal(accessLabel(['github:o/a:read'], entries), 'a · Read')
  assert.equal(accessLabel(['github:o/a:read', 'internet'], entries), 'Internet, a', 'their names, in the menu\'s order')
  assert.equal(accessTitle(['github:o/a:read', 'internet'], entries), 'Internet, a · Read', 'each with its access')
  assert.equal(accessLabel(['github:o/a:write', 'github:o/b:read'], entries), 'a, b')
  assert.equal(accessTitle(['github:o/a:write', 'github:o/b:read', 'zai'], entries), 'z.ai, a · Write, b · Read')
  assert.equal(accessTitle([], entries), 'No access')
  assert.equal(accessOf(['github:o/a:read'], entries[0]!), 'github:o/a:read')
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

test('U33 an ended Workstream whose execution had profiles: its Create carries them; another access picked, that one; a draft: the Internet when offered', () => {
  const view = { ...workstreamOf(at(fixture.marks.ended!), ws), profiles: ['github:o/a:read'] }
  assert.deepEqual(startBody('mock-test', {}, accessGranted(null, view)), { pool: 'mock-test', profiles: ['github:o/a:read'] })
  assert.deepEqual(startBody('mock-test', { model: 'mock-large' }, accessGranted([], view)), { pool: 'mock-test', settings: { model: 'mock-large' } })
  const draft = workstreamOf(empty, '')
  assert.deepEqual(startBody('mock-test', {}, accessGranted(null, draft)), { pool: 'mock-test' })
  assert.deepEqual(startBody('mock-test', {}, accessGranted(null, draft, accessDefault(['github:o/a:write', 'internet']))), { pool: 'mock-test', profiles: ['internet'] })
  assert.deepEqual(accessDefault(['github:o/a:write']), [], 'not offered: nothing')
  assert.deepEqual(startBody('mock-test', {}, accessGranted([], draft, ['internet'])), { pool: 'mock-test' }, 'turned off')
  const none = { ...workstreamOf(at(fixture.marks.ended!), ws), profiles: [] }
  assert.deepEqual(accessGranted(null, none, ['internet']), [], 'an execution without it continues without it')
})

test('U42 the context and the limits: the view\'s usage; a pool\'s account; how long until a window starts again', () => {
  const withUsage = (usage: unknown): ThreadState =>
    apply(empty, { type: 'snapshot', position: '1', operation: 'upsert', kind: 'workstream', id: ws, object: { state: 'ready', usage } })
  assert.deepEqual(workstreamOf(withUsage({ used: 1200, size: 200000 }), ws).usage, { used: 1200, size: 200000 })
  for (const malformed of [null, { used: 5 }, { used: 5, size: 0 }, { used: -1, size: 10 }, 'full']) assert.equal(workstreamOf(withUsage(malformed), ws).usage, null)
  const claude: AccountLimits = { windows: [{ kind: 'five_hour', usedPercent: 7, resetsAt: '2026-10-07T12:00:00Z' }], plan: null, checkedAt: '2026-10-07T10:00:00Z', stale: false, error: null }
  const unread: AccountLimits = { windows: [], plan: null, checkedAt: null, stale: true, error: 'the gateway refused the tunnel: 403' }
  const limits = { anthropic: claude, zai: unread, chatgpt: { ...unread, error: null } }
  assert.equal(poolLimits(['anthropic'], limits), claude)
  assert.equal(poolLimits(['zai'], limits), unread, 'never read: shown, with why')
  assert.equal(poolLimits(['chatgpt'], limits), null, 'nothing and no reason: nothing')
  assert.equal(poolLimits(undefined, limits), null, 'a pool without base profiles: none')
  assert.equal(poolLimits(['anthropic'], null), null, 'not read yet')
  const now = Date.parse('2026-10-07T10:00:00Z')
  assert.deepEqual(
    ['2026-10-07T10:44:10Z', '2026-10-07T12:00:00Z', '2026-10-07T12:10:00Z', '2026-10-10T10:00:00Z', '2026-10-10T14:30:00Z', '2026-10-07T09:00:00Z'].map((at) => resetIn(at, now)),
    ['45m', '2h', '2h 10m', '3d', '3d 4h', null],
  )
  assert.equal(resetIn(null, now), null)
  assert.deepEqual([windowName('five_hour'), windowName('weekly')], ['5-hour', 'Weekly'])
})

test('U45 attachments: what each file becomes for what the agent accepts; the prompt in order; a message\'s blocks shown back', async () => {
  const both = { image: true, audio: false, embeddedContext: true }
  const images = { image: true, audio: false, embeddedContext: false }
  const file = (bytes: BlobPart, name: string, type: string) => new File([bytes], name, { type })
  // An image becomes an image: decided on its type; drawn and re-encoded in a browser (U46).
  assert.equal(refusalOf({ type: 'image/png' }, both), null)
  const notes = await prepare(file('# Notes\n', 'notes.md', 'text/markdown'), both)
  assert.ok(!('refused' in notes))
  assert.equal(notes.type, 'document')
  assert.deepEqual(blockOf({ name: 'notes.md', content: notes.content }), { type: 'resource', resource: { uri: 'notes.md', mimeType: 'text/markdown', text: '# Notes\n' } })
  // A file the browser gives no type: text/plain.
  const plain = await prepare(file('x = 1\n', 'main.rs', ''), both)
  assert.ok(!('refused' in plain))
  assert.deepEqual(blockOf({ name: 'main.rs', content: plain.content }), { type: 'resource', resource: { uri: 'main.rs', mimeType: 'text/plain', text: 'x = 1\n' } })
  const refused = async (f: File, caps: typeof both) => {
    const r = await prepare(f, caps)
    return 'refused' in r ? r.refused : null
  }
  assert.equal(await refused(file(new Uint8Array([0x25, 0x50, 0x00, 0x46]), 'a.bin', 'application/octet-stream'), both), 'only images and text files can be attached')
  assert.equal(await refused(file('a'.repeat(TEXT_MAX + 1), 'big.log', 'text/plain'), both), 'text files are limited to 256 KiB')
  assert.equal(await refused(file('a'.repeat(TEXT_MAX), 'full.log', 'text/plain'), both), null, 'at the limit: attached')
  assert.equal(await refused(file(new Uint8Array([0xff, 0xfe, 0x41]), 'latin.txt', 'text/plain'), both), 'only images and text files can be attached')
  assert.equal(await refused(file('# Notes\n', 'notes.md', 'text/markdown'), images), 'the agent takes images only')
  assert.equal(await refused(file('png', 'a.png', 'image/png'), { image: false, audio: false, embeddedContext: true }), 'the agent does not take images')
  // The paperclip: what the picker offers, or none.
  assert.equal(acceptOf(both), '*')
  assert.equal(acceptOf(images), 'image/*')
  assert.equal(acceptOf({ image: false, audio: true, embeddedContext: false }), null)
  assert.equal(acceptOf(null), null)
  // The prompt: the text, then the attachments in the order added; no text block without text.
  const photo = { name: 'photo.jpg', content: [{ type: 'image' as const, image: 'data:image/jpeg;base64,/9j/AA==' }] }
  const doc = { name: 'notes.md', content: notes.content }
  assert.deepEqual(promptOf('look', [photo, doc]), [
    { type: 'text', text: 'look' },
    { type: 'image', mimeType: 'image/jpeg', data: '/9j/AA==', uri: 'photo.jpg' },
    { type: 'resource', resource: { uri: 'notes.md', mimeType: 'text/markdown', text: '# Notes\n' } },
  ])
  assert.deepEqual(promptOf('', [doc]).map((b) => b.type), ['resource'])
  // A user element of text, an image, a resource, a link and an audio block, as the log projects it.
  const blocks = [
    { type: 'text', text: 'look' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', uri: 'screen.png' },
    { type: 'resource', resource: { uri: 'notes.md', mimeType: 'text/markdown', text: '# Notes\n' } },
    { type: 'resource_link', uri: 'file:///work/plan.md', name: 'plan.md' },
    { type: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' },
  ]
  const entries = fixture.entries.map((e) =>
    e.position === firstPrompt.position ? { ...e, content: { ...e.content, params: { ...(e.content.params as Record<string, unknown>), prompt: blocks } } } : e,
  )
  let state = empty
  for (const o of project(entries)) state = apply(state, { type: 'snapshot', position: last, operation: 'upsert', kind: o.kind, id: o.id, object: o.object as Record<string, unknown> })
  state = apply(state, { type: 'snapshot-end', position: last })
  const user = messagesOf(state).find((m) => m.role === 'user')!
  assert.deepEqual(user.content, [{ type: 'text', text: 'look' }])
  assert.deepEqual(
    user.attachments!.map((a) => [a.type, a.name]),
    [
      ['image', 'screen.png'],
      ['document', 'notes.md'],
      ['document', 'file:///work/plan.md'],
      ['file', 'audio'],
    ],
  )
  assert.deepEqual(user.attachments![0]!.content, [{ type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' }], 'the image shown from its data')
  // What the agent accepts comes with the view: the agent of that history accepted nothing beyond text.
  assert.deepEqual(workstreamOf(state, ws).promptCapabilities, { image: false, audio: false, embeddedContext: false })
  assert.equal(acceptOf(workstreamOf(state, ws).promptCapabilities!), null, 'so no paperclip')
})

// ---------------------------------------------------------------- a question to the person

// A question's history is the log's commands alone: synthetic entries, as the log writes them.
const QUESTION_WS = '0c9e5a3e-0000-4000-8000-00000000c0de'
const asked = {
  title: 'Approve the envelope',
  text: '## The plan\n\nOne feature, **one** dev.',
  options: [
    { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
    { optionId: 'revise', name: 'Revise', kind: 'reject_once' },
  ],
  note: true,
}
const commandEntry = (position: number, kind: string, target: Record<string, unknown>, body: Record<string, unknown>): Entry =>
  ({
    workstream: QUESTION_WS,
    position: String(position),
    time: `2026-10-25T10:00:0${String(position)}.000Z`,
    kind: 'command',
    content: { id: `c${String(position)}`, kind, target, body },
    command: `c${String(position)}`,
  }) as unknown as Entry
const pendingQuestion = [commandEntry(1, 'Ask', {}, asked)]
const answeredQuestion = [...pendingQuestion, commandEntry(2, 'Answer', { question: '1' }, { optionId: 'revise', note: 'One criterion per behaviour.' })]

function stateOf(entries: readonly Entry[]): ThreadState {
  const position = entries.at(-1)!.position
  let state = empty
  for (const o of project(entries)) state = apply(state, { type: 'snapshot', position, operation: 'upsert', kind: o.kind, id: o.id, object: o.object as Record<string, unknown> })
  return apply(state, { type: 'snapshot-end', position })
}

type QuestionPart = { type: string; text?: string; toolName?: string; artifact?: Artifact; approval?: Record<string, unknown> }

test('U47 a question pending, then answered with an option and a note', () => {
  const before = messagesOf(stateOf(pendingQuestion))
  assert.equal(before.length, 1)
  const message = before[0]!
  assert.deepEqual([message.role, message.status], ['assistant', { type: 'requires-action', reason: 'tool-calls' }])
  const [part, call] = message.content as unknown as QuestionPart[]
  assert.deepEqual([part!.type, part!.text], ['text', `**Approve the envelope**\n\n${asked.text}`])
  assert.deepEqual([call!.type, call!.toolName, call!.artifact!.title, call!.artifact!.note], ['tool-call', 'question', 'Approve the envelope', true])
  assert.deepEqual(call!.approval!.options, [
    { id: 'approve', kind: 'allow-once', label: 'Approve' },
    { id: 'revise', kind: 'reject-once', label: 'Revise' },
  ])
  assert.ok(!('optionId' in call!.approval!))
  const after = messagesOf(stateOf(answeredQuestion))[0]!
  assert.deepEqual(after.status, { type: 'complete', reason: 'stop' })
  const done = (after.content as unknown as QuestionPart[])[1]!
  assert.deepEqual([done.approval!.optionId, done.approval!.approved], ['revise', false])
  assert.deepEqual([done.artifact!.answer, done.artifact!.answerNote], ['Revise', 'One criterion per behaviour.'])
})

test('U48 a question pending on a Workstream with no execution closes sending, a first message included', () => {
  const state = stateOf(pendingQuestion)
  const view = workstreamOf(state, QUESTION_WS)
  assert.deepEqual([view.state, view.question], ['none', '1'])
  const closed = composerOf(state, view)
  assert.deepEqual([closed.open, closed.create, closed.reason], [false, false, 'Answer the question above.'])
  const after = stateOf(answeredQuestion)
  const open = composerOf(after, workstreamOf(after, QUESTION_WS))
  assert.deepEqual([open.open, open.create, open.reason], [true, true, null])
})

test('U49 a Workstream in none whose question waits is listed though not open; once answered, left out again', () => {
  const now = new Date('2026-10-25T12:00:00Z')
  const listed = (entries: readonly Entry[]) => {
    const view = { ...workstreamOf(stateOf(entries), QUESTION_WS), changedAt: '2026-10-25T10:00:00Z' }
    return sections([view], now, '', null).flatMap((s) => s.workstreams.map((w) => w.id))
  }
  assert.deepEqual(listed(pendingQuestion), [QUESTION_WS])
  assert.deepEqual(listed(answeredQuestion), [])
})
