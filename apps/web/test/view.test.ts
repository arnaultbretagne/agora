// docs/specs/assistant-ui.md, acceptance cases: the client's objects and conversion, on the objects the
// log's projection folds from a real history (test/fixtures/mock.json: the log, real bridges and the
// mock agent, captured by scripts/capture.fixture.ts), cut at each moment that matters.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { CoreProjection, decode, project, type Entry } from '@agora/log'
import { Api } from '../src/agora/api.ts'
import { apply, empty, type ThreadRow, type ThreadState } from '../src/agora/objects.ts'
import { diffStats, firstLine, foldable, foldOf, labelOf, messageLabel, type Artifact } from '../src/agora/tools.ts'
import { acceptOf, blockOf, composerAttachments, prepare, promptOf, refusalOf, TEXT_MAX } from '../src/agora/attachments.ts'
import { ASKS, askUserQuestion, mcpForm, QUESTIONS, requestUserInput } from '../../../packages/mock-agent/src/forms.ts'
import {
  accessDefault,
  approvalAnswer,
  formContent,
  formFor,
  formOf,
  numberFits,
  accessEntries,
  harnessName,
  accessGranted,
  accessTitle,
  accessState,
  commandsMatching,
  composerOf,
  excerpt,
  continuationNote,
  messagesOf,
  modelChoice,
  noticeText,
  offeredPools,
  poolOffered,
  planItems,
  poolSettings,
  resetIn,
  subscriptions,
  fullest,
  returnedOf,
  merged,
  sections,
  startBody,
  startedDelegate,
  delegatesOf,
  startingOf,
  waitingOf,
  windowName,
  withAccess,
  withRole,
  workstreamOf,
  type AccountLimits,
  type Picks,
  type Role,
  type Setting,
  type Received,
  type WorkstreamView,
} from '../src/agora/view.ts'
import { HARNESS_MARKS } from '../src/screen/harness-marks.ts'

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
  assert.equal(noticeText({ type: 'execution.lost', reason: 'agent_failed' }, false), 'The agent stopped on an internal error. The history is kept.')
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
  // Read by the stream as just changed, and by an older page as it was: once, as last changed, first.
  const page = [w('d', 'Ancient', at(40)), w('c', 'Old task', at(5))]
  const stream = [w('d', 'Ancient, renamed', at(0, 14)), list[0]!]
  assert.deepEqual(merged(page, stream).map((x) => [x.id, x.title]), [['d', 'Ancient, renamed'], ['a', 'Fix the login'], ['c', 'Old task']])
})

test('U59 the line under a title: from the word before the text, the text apart, as the line wrote it', () => {
  const long = `Echo #2: ${'a long way round, '.repeat(12)}then a quokka again.`
  assert.deepEqual(excerpt(long, 'QUOKKA'), { before: '…round, then a ', text: 'quokka', after: ' again.' })
  // Near the line's start: nothing cut.
  assert.deepEqual(excerpt('Echo #2: the quokka came by.', 'quokka'), { before: 'Echo #2: the ', text: 'quokka', after: ' came by.' })
  // A text that is not in the line (a pattern's match the screen cannot find): the line whole, nothing apart.
  assert.deepEqual(excerpt('Echo #2: the quokka came by.', 'kangaroo'), { before: 'Echo #2: the quokka came by.', text: '', after: '' })
  // Characters a pattern would read as such are matched as typed.
  assert.deepEqual(excerpt('costs (a+b) twice', '(a+b)'), { before: 'costs ', text: '(a+b)', after: ' twice' })
})

/** A log of the entries that matter here, folded by the log's own projector and read as a thread. */
const logged = (entries: readonly Entry[]): ThreadState => {
  let state = empty
  const position = String(entries.length)
  for (const o of project(entries)) state = apply(state, { type: 'snapshot', position, operation: 'upsert', kind: o.kind, id: o.id, object: o.object as Record<string, unknown> })
  return apply(state, { type: 'snapshot-end', position })
}
const entryOf = (position: number, kind: string, content: Record<string, unknown>, columns: Record<string, unknown> = {}): Entry =>
  ({ workstream: ws, position: String(position), time: '2026-01-01T00:00:00.000Z', kind, execution: null, session: null, content, direction: null, rpc_kind: null, method: null, correlated_method: null, request_position: null, rpc_id: null, command: null, connection: null, receive_ordinal: null, files: null, ...columns }) as unknown as Entry
const createOf = (position: number, execution: string): Entry =>
  entryOf(position, 'command', { id: `c${String(position)}`, kind: 'Create', target: {}, body: { pool: 'mock-test', harness: 'mock', execution }, execution, claimName: `sbx-${execution}` }, { execution, command: `c${String(position)}` })
/** A Write that waits: one written during a turn, or, with `first`, the message its Create carried. */
const waitingWrite = (position: number, blocks: readonly unknown[], first?: string): Entry =>
  entryOf(position, 'command', { id: `w${String(position)}`, kind: 'Write', target: {}, body: { prompt: blocks, mayWait: true }, waits: true, ...(first ? { first } : {}) }, { command: `w${String(position)}` })
const PIXEL = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=', uri: 'pixel.png' }

test('U15 a message waiting for the Session of the execution it starts: in the thread while it starts, above the composer once ready; given back by the log, to its own execution alone', () => {
  const older = waitingWrite(1, [{ type: 'text', text: 'left from before' }])
  const entries = [older, createOf(2, 'e1'), waitingWrite(3, [{ type: 'text', text: 'starts it' }, PIXEL], 'e1')]
  const starting = logged(entries)
  const view = workstreamOf(starting, ws)
  assert.deepEqual([view.state, view.execution, view.title], ['starting', 'e1', 'left from before'])
  // While it starts: in the thread, where its turn will be; the one of another execution above the composer.
  assert.deepEqual(startingOf(starting, view).map((e) => e.object.position), ['3'])
  assert.deepEqual(waitingOf(starting, view).map((w) => [w.position, w.text]), [['1', 'left from before']])
  const shown = messagesOf(starting, view).slice(-2)
  const [said, response] = shown
  assert.deepEqual(shown.map((m) => [m.role, (m.metadata?.custom as Record<string, unknown>).turnStatus, (m.metadata?.custom as Record<string, unknown>).harness]), [['user', 'pending', 'mock'], ['assistant', 'pending', 'mock']])
  assert.deepEqual([said!.content, said!.attachments?.map((a) => [a.type, a.name]), response!.status], [[{ type: 'text', text: 'starts it' }], [['image', 'pixel.png']], { type: 'running' }])
  // Once the Session is ready: no longer in the thread, both above the composer, oldest first.
  const ready = { ...view, state: 'ready' as const, session: 's' }
  assert.deepEqual([startingOf(starting, ready).length, messagesOf(starting, ready).filter((m) => (m.metadata?.custom as Record<string, unknown> | undefined)?.turnStatus === 'pending').length], [0, 0])
  assert.deepEqual(waitingOf(starting, ready).map((w) => w.position), ['1', '3'])
  // Its execution failing before any prompt: the log gives it back; the other still waits.
  const failed = logged([...entries, entryOf(4, 'execution.failed', { reason: 'startup_failed' }, { execution: 'e1' })])
  const after = workstreamOf(failed, ws)
  assert.equal(after.state, 'failed')
  assert.deepEqual(returnedOf(failed, after).map((m) => [m.text, m.blocks]), [['starts it', [PIXEL]]])
  assert.deepEqual([startingOf(failed, after).length, waitingOf(failed, after).map((w) => w.position)], [0, ['1']])
  // The next Create: what an earlier execution gave back is not given again; its own message is in the thread.
  const again = logged([...entries, entryOf(4, 'execution.failed', { reason: 'startup_failed' }, { execution: 'e1' }), createOf(5, 'e2'), waitingWrite(6, [{ type: 'text', text: 'sent again' }], 'e2')])
  const next = workstreamOf(again, ws)
  assert.deepEqual([next.execution, returnedOf(again, next).length, startingOf(again, next).map((e) => e.object.position)], ['e2', 0, ['6']])
})

test('U15 a message given back: its blocks as the composer’s attachments, an image kept in R2 read again; sent again, the same blocks', async () => {
  const kept = { type: 'image', mimeType: 'image/jpeg', data: `agora-file:sha256:${'ab'.repeat(32)}`, uri: 'photo.jpg' }
  const notes = { type: 'resource', resource: { uri: 'notes.md', mimeType: 'text/markdown', text: '# Notes\n' } }
  const read: string[] = []
  const attachments = await composerAttachments([PIXEL, kept, notes], async (address) => {
    read.push(address)
    return new TextEncoder().encode('jpeg bytes').buffer as ArrayBuffer
  })
  assert.deepEqual(attachments.map((a) => [a.type, a.name, a.contentType, a.status.type]), [
    ['image', 'pixel.png', 'image/png', 'complete'],
    ['image', 'photo.jpg', 'image/jpeg', 'complete'],
    ['document', 'notes.md', 'text/markdown', 'complete'],
  ])
  // Only the one kept in R2 is read, from the files route.
  assert.equal(read.length, 1)
  assert.match(read[0]!, new RegExp(`^/api/files/${'ab'.repeat(32)}\\?type=image%2Fjpeg`))
  assert.deepEqual(promptOf('again', attachments), [{ type: 'text', text: 'again' }, PIXEL, { ...kept, data: Buffer.from('jpeg bytes').toString('base64') }, notes])
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

test('U31 the rights folded: the Internet, the other services, GitHub with every repository at its widest, vault, k8s, agora, the rest as themselves; their states; the key\'s name', () => {
  const offered = ['github:o/a:write', 'github:o/b:read', 'zai', 'vault:write', 'internet', 'kubernetes:read', 'agora:delegate', 'github:o/c:review', 'agora:read', 'previews']
  const entries = accessEntries(offered)
  assert.deepEqual(
    entries.map((e) => [e.name, e.profiles]),
    [
      ['Internet', ['internet']],
      ['z.ai', ['zai']],
      ['GitHub', ['github:o/a:write', 'github:o/b:read', 'github:o/c:review']],
      ['vault', ['vault:write']],
      ['k8s', ['kubernetes:read']],
      ['agora', ['agora:delegate']],
      ['agora:read', ['agora:read']],
      ['previews', ['previews']],
    ],
  )
  const github = entries[2]!
  assert.equal(github.detail, 'o/a, o/b (read), o/c (review)')
  assert.deepEqual(github.covers, ['github:o/a:read', 'github:o/a:review', 'github:o/a:write', 'github:o/b:read', 'github:o/c:read', 'github:o/c:review'], 'each level up to the widest offered, never above')
  assert.deepEqual(entries[3]!.covers, ['vault:read', 'vault:write'])
  assert.deepEqual(accessEntries(['vault:read']).map((e) => [e.name, e.profiles]), [['vault', ['vault:read']]], 'the read alone offered: the vault gives it')
  assert.equal(accessState([], github), 'off')
  assert.equal(accessState(['github:o/a:write', 'github:o/b:read', 'github:o/c:review'], github), 'on')
  assert.equal(accessState(['github:o/b:read'], github), 'partial', 'one repository, as a card may give it')
  assert.equal(accessState(['github:o/a:read', 'github:o/b:read', 'github:o/c:review'], github), 'partial', 'a narrower level')
  assert.equal(accessTitle([], entries), 'No access')
  assert.equal(accessTitle(['internet'], entries), 'Internet')
  assert.equal(accessTitle(['github:o/a:write', 'github:o/b:read', 'github:o/c:review', 'internet', 'agora:delegate'], entries), 'Internet, GitHub, agora', "in the menu's order")
  assert.equal(accessTitle(['github:o/b:read', 'vault:write'], entries), 'GitHub (partly), vault')
  assert.deepEqual(accessEntries([]), [])
})

test('U32 an entry switched gives the whole set: on, what it gives in place of what it covered; off, none of it; in the order offered, then what was granted beyond', () => {
  const offered = ['github:o/a:write', 'github:o/b:read', 'internet', 'vault:write']
  const [internet, github, vault] = accessEntries(offered)
  const all = withAccess(['internet'], offered, github!, true)
  assert.deepEqual(all, ['github:o/a:write', 'github:o/b:read', 'internet'])
  assert.deepEqual(withAccess(all, offered, github!, false), ['internet'])
  assert.deepEqual(withAccess(['github:o/a:read', 'internet'], offered, github!, true), ['github:o/a:write', 'github:o/b:read', 'internet'], 'a partial entry ticked: the whole of it')
  assert.deepEqual(withAccess(['github:x/y:read', 'vault:read'], offered, vault!, true), ['vault:write', 'github:x/y:read'], 'the read replaced by the write; what no entry covers kept')
  assert.deepEqual(withAccess(['internet', 'agora:delegate'], offered, internet!, false), ['agora:delegate'])
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

test('U42 the context and the limits: the view\'s usage; every account worth showing, named, the fullest window; how long until a window starts again', () => {
  const withUsage = (usage: unknown): ThreadState =>
    apply(empty, { type: 'snapshot', position: '1', operation: 'upsert', kind: 'workstream', id: ws, object: { state: 'ready', usage } })
  assert.deepEqual(workstreamOf(withUsage({ used: 1200, size: 200000 }), ws).usage, { used: 1200, size: 200000 })
  for (const malformed of [null, { used: 5 }, { used: 5, size: 0 }, { used: -1, size: 10 }, 'full']) assert.equal(workstreamOf(withUsage(malformed), ws).usage, null)
  const claude: AccountLimits = { windows: [{ kind: 'five_hour', usedPercent: 7, resetsAt: '2026-10-07T12:00:00Z' }], plan: null, checkedAt: '2026-10-07T10:00:00Z', stale: false, error: null }
  const unread: AccountLimits = { windows: [], plan: null, checkedAt: null, stale: true, error: 'the gateway refused the tunnel: 403' }
  const codex: AccountLimits = { windows: [{ kind: 'five_hour', usedPercent: 12, resetsAt: null }, { kind: 'weekly', usedPercent: 88.4, resetsAt: null }], plan: 'pro', checkedAt: '2026-10-07T10:00:00Z', stale: false, error: null }
  const failed: AccountLimits = { ...claude, stale: true, error: 'api.z.ai answered 503' }
  const other: AccountLimits = { ...claude, windows: [{ kind: 'weekly', usedPercent: 3, resetsAt: null }] }
  const limits = { anthropic: claude, chatgpt: codex, nobody: { ...unread, error: null }, zai: failed, vendor: other, google: unread }
  assert.deepEqual(
    subscriptions(limits).map((a) => [a.profile, a.name, a.limits]),
    [
      ['anthropic', 'Claude', claude],
      ['chatgpt', 'ChatGPT', codex],
      ['zai', 'z.ai', failed],
      ['vendor', 'vendor', other],
      ['google', 'google', unread],
    ],
    'in order; failed after a read, or never read with a reason: shown; with neither windows nor a reason: left out',
  )
  assert.deepEqual(subscriptions(null), [], 'not read yet')
  assert.deepEqual(subscriptions({}), [], 'the server reads none')
  assert.deepEqual(subscriptions({ chatgpt: { ...unread, error: null } }), [], 'nothing and no reason: nothing')
  assert.equal(fullest(subscriptions(limits)), 88.4, 'the fullest window of every account')
  assert.equal(fullest(subscriptions({ zai: failed, vendor: other })), 7)
  assert.equal(fullest(subscriptions({ google: unread })), 0, 'no window at all')
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
  assert.deepEqual([call!.type, call!.toolName, call!.artifact!.title], ['tool-call', 'question', 'Approve the envelope'])
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

const proposal = {
  kind: 'approval',
  title: 'Review the change',
  text: "**mock**\nRights beyond the caller's: `internet`\n\n> Review the change",
  options: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' }],
  expiresAt: '2026-10-25T10:04:30.000Z',
}
const factEntry = (position: number, kind: string, content: Record<string, unknown>): Entry =>
  ({ workstream: QUESTION_WS, position: String(position), time: `2026-10-25T10:00:0${String(position)}.000Z`, kind, content }) as unknown as Entry
const pendingApproval = [commandEntry(1, 'Ask', {}, proposal)]
const settled = {
  answered: [...pendingApproval, commandEntry(2, 'Answer', { question: '1' }, { optionId: 'approve' })],
  refused: [...pendingApproval, commandEntry(2, 'Write', {}, { prompt: [{ type: 'text', text: 'use the read-only rights' }] })],
  expired: [...pendingApproval, factEntry(2, 'question.expired', { question: '1' })],
}

test('U65 a `spawn_agent` answer read as a harness gives it: the text alone, or inside its result’s JSON; `send_message`’s and `stop_agent`’s too', () => {
  const id = '7f1c9a52-3b1e-4c8e-9d61-2a4b5c6d7e8f'
  assert.deepEqual(startedDelegate(`started ${id} · Review the change`), { id, title: 'Review the change' })
  assert.deepEqual(startedDelegate(`sent ${id} · Review the change`), { id, title: 'Review the change' })
  assert.deepEqual(startedDelegate(`stopped ${id} · Review the change`), { id, title: 'Review the change' })
  assert.deepEqual(startedDelegate(`no turn to stop ${id} · Review the change`), { id, title: 'Review the change' })
  assert.deepEqual(startedDelegate(JSON.stringify({ content: [{ type: 'text', text: `started ${id} · Review the change` }] }, null, 2)), { id, title: 'Review the change' })
  assert.equal(startedDelegate('refused: use the read-only rights'), null)
  assert.equal(startedDelegate('sent'), null, 'a message to its delegator names no delegate')
})

test('U84 a send_message and a stop_agent naming a delegate, a send_message to parent, a list_agents, a delegate line of an earlier contract, a command naming a tool: the first two and the earlier one a delegate’s line; the others as any tool’s', () => {
  const id = '7f1c9a52-3b1e-4c8e-9d61-2a4b5c6d7e8f'
  const line = (position: number, title: string, rawOutput: string) => ({
    kind: 'element',
    id: `tool-${String(position)}`,
    object: { type: 'tool', turn: 't', session: 's', firstPosition: String(position), lastPosition: String(position), toolCallId: `call-${String(position)}`, title, kind: 'other', status: 'completed', rawOutput },
  })
  const messages = messagesOf(
    crafted([
      turnObject('done'),
      said(1, 'go'),
      line(2, 'mcp__agora__send_message', `sent ${id} · Review the change`),
      line(3, 'agora_stop_agent', `stopped ${id} · Review the change`),
      line(4, 'mcp__agora__send_message', 'sent'),
      line(5, 'mcp__agora__list_agents', `${id} · Review the change · working`),
      line(6, 'delegate', `started ${id} · Review the change`),
      // A command that names a tool and quotes its answer is no delegate's line; nor is a list, whatever it prints.
      line(7, 'grep -n spawn_agent entries.json', `12: started ${id} · Review the change`),
      line(8, 'mcp.agora.list_agents', `sent ${id} · Review the change`),
      line(9, 'mcp.agora.spawn_agent', `started ${id} · Review the change`),
    ]),
  )
  const parts = (messages.find((m) => m.role === 'assistant')!.content as unknown as { type: string; artifact?: { title?: string; delegate?: { id: string; title: string } } }[]).filter((p) => p.type === 'tool-call')
  assert.deepEqual(parts.map((p) => [p.artifact?.title, p.artifact?.delegate ?? null]), [
    ['mcp__agora__send_message', { id, title: 'Review the change' }],
    ['agora_stop_agent', { id, title: 'Review the change' }],
    ['mcp__agora__send_message', null],
    ['mcp__agora__list_agents', null],
    ['delegate', { id, title: 'Review the change' }],
    ['grep -n spawn_agent entries.json', null],
    ['mcp.agora.list_agents', null],
    ['mcp.agora.spawn_agent', { id, title: 'Review the change' }],
  ])
  assert.deepEqual(delegatesOf(crafted([line(2, 'mcp__agora__send_message', `sent ${id} · Review the change`), line(5, 'mcp__agora__list_agents', `${id} · Review the change · working`)])), [id])
})

test('U89 a subagent element among a turn’s parts: a delegate’s line, its sub-stream and its state; its sub-stream among those whose rows the thread reads', () => {
  const child = '7f1c9a52-3b1e-4c8e-9d61-2a4b5c6d7e8f'
  const line = (state: string) => ({ kind: 'element', id: 'sub-line', object: { type: 'subagent', turn: 't', session: 's', firstPosition: '2', lastPosition: '3', workstream: child, title: 'Count the files', description: 'general-purpose', state, cancel: true } })
  const partOf = (state: string) => {
    const thread = crafted([turnObject('in_progress'), said(1, 'go'), line(state), chunk(4, 'its own words')])
    const assistant = messagesOf(thread).find((m) => m.role === 'assistant')!
    return (assistant.content as unknown as { type: string; isError?: boolean; result?: string; artifact?: { title?: string; status?: string; subagent?: string; delegate?: { id: string; title: string } } }[]).find((p) => p.type === 'tool-call')!
  }
  assert.deepEqual([partOf('working').artifact?.delegate, partOf('working').artifact?.subagent, partOf('working').artifact?.status, partOf('working').result], [{ id: child, title: 'Count the files' }, 'working', 'in_progress', undefined])
  assert.deepEqual([partOf('waiting').artifact?.subagent, partOf('waiting').artifact?.status], ['waiting', 'in_progress'])
  assert.deepEqual([partOf('idle').artifact?.status, partOf('idle').result, partOf('idle').isError], ['completed', 'idle', false])
  assert.deepEqual([partOf('failed').artifact?.status, partOf('failed').isError], ['failed', true])
  assert.equal(foldable(partOf('idle') as never), false, 'out of a fold, as a delegate’s')
  assert.deepEqual(delegatesOf(crafted([line('working')])), [child])
})

test('U90 a native sub-stream’s view: no sending, read-only; Cancel for its turn in progress while cancel is offered; its permission pending; a turn with no task, its response alone', () => {
  const native = (cancel: boolean) => ({ kind: 'workstream', id: 'w', object: { title: 'Count the files', state: 'native', harness: 'mock', native: { host: 'h', description: null, cancel }, subagent: 'working' } })
  const turn = (status: string) => ({ kind: 'turn', id: 't', object: { status, requestPosition: '1', session: 's', execution: 'e', requestId: null, native: true } })
  const permission = { kind: 'element', id: 'p', object: { type: 'permission', turn: 't', session: 's', firstPosition: '3', lastPosition: '3', status: 'pending', execution: 'e', requestPosition: '3', params: { toolCall: { toolCallId: 'x', title: 'ls' }, options: [] } } }
  const of = (objects: Parameters<typeof crafted>[0]) => {
    const thread = { ...crafted(objects), complete: true }
    return { thread, composer: composerOf(thread, workstreamOf(thread, 'w')) }
  }
  const working = of([native(true), turn('in_progress'), chunk(2, 'at work')]).composer
  assert.deepEqual([working.open, working.create, working.readOnly, working.reason, working.cancellable?.id], [false, false, true, null, 't'])
  assert.equal(of([native(false), turn('in_progress')]).composer.cancellable, null, 'no Cancel where none is offered')
  assert.equal(of([native(true), turn('done')]).composer.cancellable, null, 'nor once its turn is over')
  // Its permission is its own, whatever Session its host's execution has.
  assert.equal(of([native(true), turn('in_progress'), permission]).composer.pendingPermission?.id, 'p')
  // No task reported: no message of anybody's before its response.
  const { thread } = of([native(true), turn('done'), chunk(2, 'its answer')])
  assert.deepEqual(messagesOf(thread).map((m) => m.role), ['assistant'])
  assert.equal(workstreamOf(thread, 'w').native?.host, 'h')
  // Positive control: any other turn keeps its first message.
  assert.deepEqual(messagesOf(crafted([turnObject('done'), chunk(2, 'an answer')])).map((m) => m.role), ['user', 'assistant'])
})

// ---------------------------------------------------------------- roles

// docs/specs/assistant-ui.md, "Roles": a catalogue as `GET /api/pools` gives it, each pool with what its last Session
// offered — Codex's effort under its own id —, and cards as `GET /api/config` gives them.
const offering = (models: readonly string[], efforts: readonly string[], effortId = 'effort'): Setting[] => {
  const select = (id: string, category: string, values: readonly string[]): Setting => ({ id, name: id, category, type: 'select', currentValue: 'default', options: ['default', ...values].map((value) => ({ value, name: value, description: null })) })
  return [select('mode', 'mode', ['full-access']), select('model', 'model', models), select(effortId, 'thought_level', efforts)]
}
const ROLE_POOLS = [
  { name: 'mock-1', harness: 'mock', settings: offering(['mock-small', 'mock-large'], ['low', 'high']) },
  { name: 'claude-1', harness: 'claude-code', settings: offering(['sonnet', 'opus'], ['low', 'medium', 'high']) },
  { name: 'claude-2', harness: 'claude-code', settings: offering(['sonnet', 'opus'], ['low', 'medium', 'high']) },
  { name: 'codex-1', harness: 'codex', settings: offering(['gpt-6.1-sol'], ['low', 'xhigh'], 'reasoning_effort') },
  { name: 'opencode-kept', harness: 'opencode', testing: true, settings: offering(['glm'], ['high']) },
  { name: 'unopened', harness: 'pi', settings: null },
]
const ROLE_OFFERED = ['github:o/a:write', 'internet', 'agora:delegate']
const LEAD: Role = { role: 'lead', summary: 'Runs a small team on one goal.', harness: 'claude-code', model: 'opus', effort: 'high', access: ['agora:delegate'] }
const NOTHING_PICKED: Picks = { pool: null, settings: null, access: null }
/** The picks in effect for a role, in a draft whose own pool is the mock's unless said. */
const picks = (role: Role | null, own: Partial<Picks> = {}, start: string | null = 'mock-1', offered: readonly string[] = ROLE_OFFERED) => withRole(role, { ...NOTHING_PICKED, ...own }, ROLE_POOLS, offered, start)

test('U92 a role picked: its card’s harness, model and effort and its access where the person picked nothing, each when offered; what the person picked as they left it; No role, the draft’s own', () => {
  // A draft nothing was picked in, a role of another harness: the card's harness, model and effort, its access beside the Internet.
  assert.deepEqual(picks(LEAD), { pool: 'claude-1', settings: { pool: 'claude-1', values: { model: 'opus', effort: 'high' } }, access: ['internet', 'agora:delegate'] })
  // The draft's own pool already one of the card's harness: that one, not the first of its harness.
  assert.equal(picks(LEAD, {}, 'claude-2').pool, 'claude-2')
  assert.deepEqual(picks(LEAD, {}, 'claude-2').settings, { pool: 'claude-2', values: { model: 'opus', effort: 'high' } })

  // The harness the person picked stays; the card's model and effort are its own harness's: on another, none.
  const otherHarness = picks(LEAD, { pool: 'mock-1' })
  assert.deepEqual([otherHarness.pool, otherHarness.settings, otherHarness.access], ['mock-1', null, ['internet', 'agora:delegate']])
  // Picked by the person and the card's own harness: the card's model and effort, the person having picked neither.
  assert.deepEqual(picks(LEAD, { pool: 'claude-2' }).settings, { pool: 'claude-2', values: { model: 'opus', effort: 'high' } })

  // The model with its effort is one pick: the person's effort alone, and the card sets neither.
  const ownEffort = { pool: 'claude-1', values: { effort: 'low' } }
  assert.deepEqual(picks(LEAD, { pool: 'claude-1', settings: ownEffort }).settings, ownEffort)
  // A model the person picked keeps its harness with it, whatever the card's.
  const ownModel = { pool: 'mock-1', values: { model: 'mock-large' } }
  assert.deepEqual(picks(LEAD, { settings: ownModel }), { pool: 'mock-1', settings: ownModel, access: ['internet', 'agora:delegate'] })
  assert.deepEqual(picks(LEAD, { settings: ownModel }, 'claude-1').pool, 'mock-1', 'wherever the draft started')
  // One picked in a pool the person then left is that pool's: here they picked none, and the card's stand.
  assert.deepEqual(picks(LEAD, { pool: 'claude-1', settings: ownModel }).settings, { pool: 'claude-1', values: { model: 'opus', effort: 'high' } })

  // The access the person picked stays, nothing granted included.
  assert.deepEqual(picks(LEAD, { access: [] }).access, [])
  assert.deepEqual(picks(LEAD, { access: ['github:o/a:read'] }).access, ['github:o/a:read'])
  // Every pick the person's own: the card sets nothing.
  const all: Picks = { pool: 'mock-1', settings: ownModel, access: ['github:o/a:read'] }
  assert.deepEqual(picks(LEAD, all), all)

  // Only what is offered. No pool of the card's harness, or one kept for the tests: the draft's own harness, and that pool's own model.
  for (const harness of ['gemini', 'opencode']) assert.deepEqual(picks({ ...LEAD, harness }), { pool: null, settings: null, access: ['internet', 'agora:delegate'] })
  // A model or an effort its pool does not offer, or the card leaves to the pool: not set; the other is.
  assert.deepEqual(picks({ ...LEAD, model: 'haiku' }).settings, { pool: 'claude-1', values: { effort: 'high' } })
  assert.deepEqual(picks({ ...LEAD, effort: 'max' }).settings, { pool: 'claude-1', values: { model: 'opus' } })
  assert.deepEqual(picks({ ...LEAD, model: null }).settings, { pool: 'claude-1', values: { effort: 'high' } })
  assert.equal(picks({ ...LEAD, model: null, effort: null }).settings, null)
  assert.equal(picks({ ...LEAD, model: 'default', effort: 'default' }).settings, null, 'never the value default')
  // A pool no Session has opened in offers none yet.
  assert.deepEqual(picks({ ...LEAD, harness: 'pi' }), { pool: 'unopened', settings: null, access: ['internet', 'agora:delegate'] })
  // The effort under the id its pool gives it.
  assert.deepEqual(picks({ ...LEAD, harness: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }).settings, { pool: 'codex-1', values: { model: 'gpt-6.1-sol', reasoning_effort: 'xhigh' } })
  // The access: the draft's own start and the card's, each when offered — a level under the one offered is —, in the order offered.
  assert.deepEqual(picks({ ...LEAD, access: ['zai', 'agora:delegate', 'github:o/a:read', 'github:o/b:read'] }).access, ['github:o/a:read', 'internet', 'agora:delegate'])
  assert.deepEqual(picks(LEAD, {}, 'mock-1', ['agora:delegate']).access, ['agora:delegate'], 'no Internet where none is offered')
  assert.deepEqual(picks({ ...LEAD, access: [] }).access, ['internet'], 'a card with no access: the draft’s own start')
  assert.deepEqual(picks(LEAD, {}, 'mock-1', []).access, [])

  // No role, or back to it: what a card had set returns to the draft's own — nothing picked —, the person's picks kept.
  assert.deepEqual(picks(null), NOTHING_PICKED)
  assert.deepEqual(picks(null, all), all)
  assert.deepEqual(picks(null, { settings: ownModel }), { pool: 'mock-1', settings: ownModel, access: null })
  assert.deepEqual(accessGranted(picks(null).access, workstreamOf(empty, ''), accessDefault(ROLE_OFFERED)), ['internet'])
  assert.equal(poolOffered(ROLE_POOLS, picks(null).pool, null, null), 'mock-1')
  // What the pickers then show: the card's model and effort as the chosen ones, over the pool's own.
  const shown = picks(LEAD)
  assert.deepEqual(modelChoice(poolSettings(ROLE_POOLS[1]), shown.settings!.values).current, { model: 'opus', effort: 'high' })
  assert.deepEqual(modelChoice(poolSettings(ROLE_POOLS[1])).current, { model: null, effort: null }, 'the control: none without the card')
})

test('U93 a role picked, a first message: the Create carries the role with the card’s settings and the profiles shown; the view gives the Workstream’s role', () => {
  const shown = picks(LEAD)
  assert.deepEqual(startBody(shown.pool!, shown.settings!.values, shown.access!, LEAD.role), {
    pool: 'claude-1',
    settings: { model: 'opus', effort: 'high' },
    profiles: ['internet', 'agora:delegate'],
    role: 'lead',
  })
  // The header's role is the view's, as the log projects it from the Workstream's first Create.
  const created = (body: Record<string, unknown>) =>
    logged([entryOf(1, 'command', { id: 'c1', kind: 'Create', target: {}, body: { pool: 'mock-test', harness: 'mock', execution: 'e1', ...body }, execution: 'e1', claimName: 'sbx-e1' }, { execution: 'e1', command: 'c1' })])
  assert.equal(workstreamOf(created({ role: 'lead' }), ws).role, 'lead')
  assert.equal(workstreamOf(created({}), ws).role, null, 'none without one')
})

test('U94 a message sent again: its Create names no role', () => {
  assert.deepEqual(startBody('mock-test', {}, ['internet']), { pool: 'mock-test', profiles: ['internet'] })
  assert.ok(!('role' in startBody('mock-test', { model: 'mock-large' }, [], null)))
  assert.equal(startBody('mock-test', {}, [], 'dev').role, 'dev', 'the control: named when given')
})

test('U95 GET /api/config: its roles as the cards give them, none when it gives none; the profiles offered beside them', async () => {
  const answering = (body: unknown) => new Api('', async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))
  const card = { role: 'lead', summary: 'Runs a small team on one goal.', harness: 'claude-code', model: 'opus', effort: null, access: ['agora:delegate'] }
  assert.deepEqual(await answering({ testRoutes: false, credentials: { offered: ['internet'] }, roles: [card] }).config(), { offered: ['internet'], roles: [card] })
  assert.deepEqual(await answering({ testRoutes: false, credentials: { offered: ['internet'] }, roles: [] }).config(), { offered: ['internet'], roles: [] })
  // A server of before the roles, or without credentials: nothing offered.
  assert.deepEqual(await answering({ testRoutes: false, credentials: null }).config(), { offered: [], roles: [] })
})

test('U62 an approval pending: sending open, no Create, what is sent refusing it; refused, sending as it was', () => {
  const state = stateOf(pendingApproval)
  const open = composerOf(state, workstreamOf(state, QUESTION_WS))
  assert.deepEqual([open.open, open.create, open.reason, open.refuses], [true, false, null, true])
  const after = stateOf(settled.refused)
  const back = composerOf(after, workstreamOf(after, QUESTION_WS))
  assert.deepEqual([back.open, back.create, back.refuses], [true, true, false])
})

test('U63 an approval matched to no line: its box at its position, pending; then answered, refused with the words, or expired', () => {
  const gate = (entries: readonly Entry[]) => {
    const messages = messagesOf(stateOf(entries))
    assert.equal(messages.length, 1)
    const [part] = messages[0]!.content as unknown as QuestionPart[]
    assert.deepEqual([messages[0]!.role, part!.toolName], ['assistant', 'delegate'])
    return part!.artifact!.gate!
  }
  const pending = gate(pendingApproval)
  assert.deepEqual([pending.status, pending.title, pending.text, pending.words], ['pending', 'Review the change', proposal.text, null])
  assert.equal(gate(settled.answered).status, 'answered')
  assert.deepEqual([gate(settled.refused).status, gate(settled.refused).words], ['refused', 'use the read-only rights'])
  assert.equal(gate(settled.expired).status, 'expired')
})

// docs/specs/assistant-ui.md, "Messages during a turn": objects as the log projects them, crafted.
const MESSAGES_WS = '0c9e5a3e-0000-4000-8000-00000000d00d'
const crafted = (objects: readonly { kind: string; id: string; object: Record<string, unknown> }[]): ThreadState => {
  let state = empty
  const all = [{ kind: 'workstream', id: MESSAGES_WS, object: { state: 'ready', execution: 'e', session: 's' } }, ...objects]
  for (const o of all) state = apply(state, { type: 'snapshot', position: '1', operation: 'upsert', kind: o.kind as 'element', id: o.id, object: o.object })
  return apply(state, { type: 'snapshot-end', position: '1' })
}
const turnObject = (status: string) => ({ kind: 'turn', id: 't', object: { status, requestPosition: '1', session: 's' } })
const said = (position: number, words: string, steered = false) => ({
  kind: 'element',
  id: `said-${String(position)}`,
  object: { type: 'user', turn: 't', session: 's', firstPosition: String(position), content: [{ type: 'text', text: words }], ...(steered ? { steered: true } : {}) },
})
const chunk = (position: number, words: string) => ({ kind: 'element', id: `chunk-${String(position)}`, object: { type: 'agent_message_chunk', turn: 't', session: 's', firstPosition: String(position), text: words } })

test('U67 a turn saved, then in progress: sending open, the turn running; uncertain, or a permission pending: closed', () => {
  for (const status of ['saved', 'in_progress']) {
    const state = crafted([turnObject(status)])
    const composer = composerOf(state, workstreamOf(state, MESSAGES_WS))
    assert.deepEqual([composer.open, composer.create, composer.running, composer.reason], [true, false, true, null])
  }
  const uncertain = crafted([turnObject('uncertain')])
  assert.deepEqual([composerOf(uncertain, workstreamOf(uncertain, MESSAGES_WS)).open, composerOf(uncertain, workstreamOf(uncertain, MESSAGES_WS)).running], [false, false])
  const asking = crafted([turnObject('in_progress'), { kind: 'element', id: 'p', object: { type: 'permission', turn: 't', session: 's', status: 'pending', params: {} } }])
  const closed = composerOf(asking, workstreamOf(asking, MESSAGES_WS))
  assert.deepEqual([closed.open, closed.reason], [false, 'Answer the permission request above.'])
})

test('U68 a message sent into a turn: the response split around it, ids and statuses; before any text, no empty response', () => {
  const messages = messagesOf(crafted([turnObject('in_progress'), said(1, 'first'), chunk(2, 'before'), said(3, 'also this', true), chunk(4, 'after')]))
  assert.deepEqual(messages.map((m) => [m.id, m.role]), [
    ['t:user', 'user'],
    ['t:assistant', 'assistant'],
    ['t:user:3', 'user'],
    ['t:assistant:3', 'assistant'],
  ])
  assert.deepEqual(messages[1]!.content, [{ type: 'text', text: 'before' }])
  assert.deepEqual(messages[1]!.status, { type: 'complete', reason: 'stop' })
  assert.deepEqual(messages[2]!.content, [{ type: 'text', text: 'also this' }])
  assert.equal(turnStatus(messages[2]!), undefined)
  assert.equal(turnStatus(messages[0]!), 'in_progress')
  assert.deepEqual(messages[3]!.content, [{ type: 'text', text: 'after' }])
  assert.deepEqual(messages[3]!.status, { type: 'running' })
  // The turn over: the last part has its status.
  const over = messagesOf(crafted([turnObject('cancelled'), said(1, 'first'), chunk(2, 'before'), said(3, 'also this', true)]))
  assert.deepEqual(over.at(-1)!.status, { type: 'incomplete', reason: 'cancelled' })
  // Nothing said before it: no empty message before it; the last part is there, empty, to say the agent works.
  const early = messagesOf(crafted([turnObject('in_progress'), said(1, 'first'), said(2, 'at once', true)]))
  assert.deepEqual(early.map((m) => m.id), ['t:user', 't:user:2', 't:assistant:2'])
  assert.deepEqual([early[2]!.content, early[2]!.status], [[], { type: 'running' }])
})

test('U69 waiting elements: those waiting, in position order, with their text and attachments counted', () => {
  const element = (position: number, status: string, content?: unknown[]) => ({ kind: 'element', id: `w-${String(position)}`, object: { type: 'waiting', position: String(position), firstPosition: String(position), status, ...(content ? { content } : {}) } })
  const state = crafted([
    element(9, 'waiting', [{ type: 'text', text: 'the second' }, { type: 'image', uri: 'a.png' }]),
    element(5, 'waiting', [{ type: 'text', text: 'the first' }]),
    element(3, 'sent'),
    element(4, 'retracted'),
  ])
  assert.deepEqual(waitingOf(state), [
    { id: 'w-5', position: '5', text: 'the first', attachments: 0, from: null, as: null },
    { id: 'w-9', position: '9', text: 'the second', attachments: 1, from: null, as: null },
  ])
  // Not messages of the thread.
  assert.deepEqual(messagesOf(state), [])
  // Held with no turn running; not during a turn.
  const during = crafted([turnObject('in_progress'), element(5, 'waiting', [{ type: 'text', text: 'the first' }])])
  assert.equal(composerOf(during, workstreamOf(during, MESSAGES_WS)).held, false)
  const cancelled = crafted([turnObject('cancelled'), element(5, 'waiting', [{ type: 'text', text: 'the first' }])])
  assert.equal(composerOf(cancelled, workstreamOf(cancelled, MESSAGES_WS)).held, true)
})

/** A message of another's than the person's, `as` its writer stands, from `d` (docs/specs/delegation.md, "Messages"). */
const another = (position: number, words: string, as: string, steered = true, turn = 't') => ({
  kind: 'element',
  id: `said-${String(position)}`,
  object: { type: 'user', turn, session: 's', firstPosition: String(position), content: [{ type: 'text', text: words }], ...(steered ? { steered: true } : {}), from: 'd', as },
})
type MessagePart = { type: string; toolName?: string; toolCallId?: string; result?: unknown; text?: string; artifact?: { kind?: string; status?: string; message?: unknown } }
const partsIn = (message: { content: unknown }) => message.content as MessagePart[]
/** A response's parts as the thread draws them: a message received by its writer and its text, any other by its type. */
const drawn = (message: { content: unknown }) => partsIn(message).map((p) => (p.type === 'tool-call' ? (p.toolName === 'message' ? ['message', p.artifact?.message] : ['tool', p.toolName]) : [p.type, p.text]))

test('U76 a delegate’s message sent into a running turn; one of Agora’s; one waiting: each a line of the response at its place, the response not split; the third saying who wrote it', () => {
  const messages = messagesOf(crafted([turnObject('in_progress'), said(1, 'first'), chunk(2, 'before'), another(3, 'the result', 'delegate'), chunk(4, 'between'), another(5, 'it failed', 'agora'), chunk(6, 'after')]))
  assert.deepEqual(messages.map((m) => [m.id, m.role]), [
    ['t:user', 'user'],
    ['t:assistant', 'assistant'],
  ])
  assert.deepEqual(drawn(messages[1]!), [
    ['text', 'before'],
    ['message', { from: 'd', as: 'delegate', text: 'the result' }],
    ['text', 'between'],
    ['message', { from: null, as: 'agora', text: 'it failed' }],
    ['text', 'after'],
  ])
  assert.deepEqual(messages[1]!.status, { type: 'running' }, 'the response going on under them')
  const waiting = crafted([turnObject('in_progress'), { kind: 'element', id: 'w', object: { type: 'waiting', position: '7', firstPosition: '7', status: 'waiting', content: [{ type: 'text', text: 'later' }], from: 'd', as: 'delegate' } }])
  assert.deepEqual(waitingOf(waiting), [{ id: 'w', position: '7', text: 'later', attachments: 0, from: 'd', as: 'delegate' }])
})

test('U112 messages received — sent into a running command’s turn, opening a turn, a report, a task —: each a `message` part at its place in its response, no message of its own; folded with the command, alone its own line; the person’s message still splitting', () => {
  const command = (position: number, status = 'completed') => ({
    kind: 'element',
    id: `tool-${String(position)}`,
    object: { type: 'tool', turn: 't', session: 's', firstPosition: String(position), lastPosition: String(position + 10), toolCallId: `call-${String(position)}`, title: 'npm test', kind: 'execute', status },
  })
  /** The folds of a response, as U77 reads them: each run of foldable tools between the other parts, by its count and label. */
  const runs = (message: { content: unknown }) => {
    const out: MessagePart[][] = [[]]
    for (const p of partsIn(message)) {
      if (p.type === 'tool-call' && foldable(p as never)) out.at(-1)!.push(p)
      else if (p.type !== 'reasoning') out.push([])
    }
    return out.filter((run) => run.length > 0).map((run) => (run.length < 2 ? { alone: run[0]!.toolName } : { count: foldOf(run as never).count, summary: foldOf(run as never).summary, size: foldOf(run as never).size }))
  }

  // A command running, a delegate's last message and one of Agora's sent into its turn, then the agent's text.
  const during = messagesOf(crafted([turnObject('in_progress'), said(1, 'go'), command(2, 'in_progress'), another(3, '## Done\n\nAll **tests** pass.', 'delegate'), another(4, 'Your delegate d "the task": The person stopped it.', 'agora'), chunk(5, 'Both heard.')]))
  assert.deepEqual(during.map((m) => [m.id, m.role]), [['t:user', 'user'], ['t:assistant', 'assistant']], 'no user or system message of theirs, the response not split')
  assert.deepEqual(drawn(during[1]!), [
    ['tool', 'execute'],
    ['message', { from: 'd', as: 'delegate', text: '## Done\n\nAll **tests** pass.' }],
    ['message', { from: null, as: 'agora', text: 'Your delegate d "the task": The person stopped it.' }],
    ['text', 'Both heard.'],
  ])
  const [, first, second] = partsIn(during[1]!)
  assert.deepEqual([first!.toolCallId, first!.result, first!.artifact?.kind, first!.artifact?.status], ['said-3', '## Done\n\nAll **tests** pass.', 'message', 'completed'])
  // Its line: who wrote it, then its first line without the marks of Markdown.
  assert.equal(messageLabel(first!.artifact!.message as Received, 'the task'), 'From the task · Done')
  assert.equal(messageLabel(second!.artifact!.message as Received, 'Agora'), 'From Agora · Your delegate d "the task": The person stopped it.')
  assert.equal(firstLine('\n\n> - **All** `tests` pass\nthen more'), 'All tests pass')
  assert.deepEqual(runs(during[1]!), [{ count: 3, summary: '1 command, 2 messages', size: '1 tool, 2 messages' }], 'one fold, the text after it out of it')
  // Beside a delegate's line, which stays out of folds: alone.
  const spawn = { kind: 'element', id: 'spawn', object: { type: 'tool', turn: 't', session: 's', firstPosition: '2', lastPosition: '2', toolCallId: 'call-spawn', title: 'mcp__agora__spawn_agent', kind: 'other', status: 'completed', rawOutput: 'started 7f1c9a52-3b1e-4c8e-9d61-2a4b5c6d7e8f · the task' } }
  assert.deepEqual(runs(messagesOf(crafted([turnObject('done'), said(1, 'go'), spawn, another(3, 'Your delegate d "the task": It ended its turn with nothing to say.', 'agora')]))[1]!), [{ alone: 'message' }])

  // Turns opened by a delegate's last message, by one of Agora's, by an earlier delegation's report: their response alone, the message first.
  for (const [opening, message] of [
    [another(1, 'Slept 3 s.', 'delegate', false), { from: 'd', as: 'delegate', text: 'Slept 3 s.' }],
    [another(1, 'Your delegate d "x": Its turn failed.', 'agora', false), { from: null, as: 'agora', text: 'Your delegate d "x": Its turn failed.' }],
    [{ kind: 'element', id: 'report', object: { type: 'report', turn: 't', session: 's', firstPosition: '1', text: 'Two outcomes.', delegates: ['a', 'b'] } }, { from: null, as: 'agora', text: 'Two outcomes.', outcomes: 2 }],
    // A delegate's task from its delegator, in the delegate's own thread.
    [another(1, 'Review the change.', 'delegator', false), { from: 'd', as: 'delegator', text: 'Review the change.' }],
  ] as const) {
    const opened = messagesOf(crafted([turnObject('done'), opening, chunk(2, 'An answer.')]))
    assert.deepEqual(opened.map((m) => [m.id, m.role]), [['t:assistant', 'assistant']])
    assert.deepEqual(drawn(opened[0]!), [['message', message], ['text', 'An answer.']])
    assert.deepEqual(runs(opened[0]!), [{ alone: 'message' }], 'alone, its own line')
  }
  // A native sub-stream's task from its parent: its response alone, the task first.
  const native = crafted([{ kind: 'turn', id: 't', object: { status: 'done', requestPosition: '1', session: 's', native: true } }, another(1, 'Count the files.', 'parent', false), chunk(2, '3 files.')])
  assert.deepEqual(messagesOf(native).map((m) => m.role), ['assistant'])
  assert.deepEqual(drawn(messagesOf(native)[0]!), [['message', { from: 'd', as: 'parent', text: 'Count the files.' }], ['text', '3 files.']])

  // The control: the person's message, opening the turn and sent into it, a bubble of its own that splits the response, as in U68.
  const person = messagesOf(crafted([turnObject('in_progress'), said(1, 'go'), command(2), said(3, 'also this', true), command(4)]))
  assert.deepEqual(person.map((m) => [m.id, m.role]), [['t:user', 'user'], ['t:assistant', 'assistant'], ['t:user:3', 'user'], ['t:assistant:3', 'assistant']])
  assert.deepEqual(runs(person[1]!), [{ alone: 'execute' }])
})

test('U77 tools in a row, the reasoning in them, one fold each; a pending permission, a delegate, an approval and a question out', async () => {
  type Tool = { type: string; toolName: string; artifact?: unknown; approval?: unknown; isError?: boolean }
  /** The folds of a response: what `messages.tsx` asks `GroupedParts` for, without React. */
  const folds = (parts: readonly Tool[]) => {
    const runs: Tool[][] = [[]]
    for (const p of parts) {
      if (p.type === 'tool-call' && foldable(p)) runs.at(-1)!.push(p)
      else if (p.type !== 'reasoning') runs.push([])
    }
    return runs.filter((run) => run.length > 0).map((run) => {
      const { count, summary, note } = foldOf(run)
      return { count, summary, note }
    })
  }
  const foldsOf = async (harness: string) => messagesOf((await real(harness)).state).flatMap((m) => (m.role === 'assistant' ? folds(m.content as unknown as Tool[]) : []))
  assert.deepEqual(await foldsOf('claude-code'), [
    { count: 3, summary: '2 edits, 1 command', note: '+22 −0' },
    { count: 4, summary: '3 edits, 1 command', note: '+5 −5' },
  ])
  assert.deepEqual(await foldsOf('codex'), [
    { count: 6, summary: '4 commands, 2 other tools', note: '3 failed' },
    { count: 2, summary: '1 command, 1 other tool', note: undefined },
  ])
  // Its reasoning comes after the first six, before a text: in that fold, not a fold of its own.
  assert.deepEqual(await foldsOf('opencode'), [
    { count: 6, summary: '2 other tools, 2 edits, 2 commands', note: undefined },
    { count: 3, summary: '1 edit, 1 command, 1 other tool', note: '+1 −1' },
  ])
  const tool = (over: Partial<Tool>): Tool => ({ type: 'tool-call', toolName: 'execute', artifact: { kind: 'execute', status: 'completed' }, ...over })
  const pending = { id: 'p', options: [] }
  assert.equal(foldable(tool({ approval: pending })), false, 'a permission pending')
  assert.equal(foldable(tool({ approval: { ...pending, optionId: 'allow' } })), true, 'answered')
  assert.equal(foldable(tool({ approval: { ...pending, resolution: 'cancelled' } })), true, 'its turn cancelled')
  assert.equal(foldable(tool({ artifact: { delegate: { id: 'd', title: 'a task' } } })), false, 'a delegate line')
  assert.equal(foldable(tool({ artifact: { gate: { id: 'g' } } })), false, 'an approval')
  assert.equal(foldable(tool({ toolName: 'question' })), false, 'a question')
  assert.deepEqual(folds([tool({}), tool({ approval: pending }), tool({}), tool({})]).map((f) => f.count), [1, 2], 'what stays out ends a fold')
  // Running: the running tool's label, whatever came after it; else the last tool's.
  const named = (title: string, status: string) => tool({ artifact: { title: `${title} now`, kind: 'execute', status } })
  assert.equal(foldOf([named('a', 'completed'), named('b', 'in_progress'), named('c', 'completed')]).latest, 'b now')
  assert.equal(foldOf([named('a', 'completed'), named('b', 'in_progress'), named('c', 'completed')]).running, true)
  assert.equal(foldOf([named('a', 'completed'), named('b', 'completed')]).latest, 'b now')
  assert.equal(foldOf([named('a', 'completed'), named('b', 'completed')]).running, false)
})

const mergeAsk = {
  kind: 'merge',
  title: 'Add feature 7',
  text: '[owner/a#7](https://github.com/owner/a/pull/7) · `main ← feat/7` · agora-contributor[bot]',
  options: [{ optionId: 'merge', name: 'Merge', kind: 'allow_once' }],
  repo: 'owner/a',
  number: 7,
  url: 'https://github.com/owner/a/pull/7',
}
const pendingMerge = [commandEntry(1, 'Ask', {}, mergeAsk)]

test('G8 a merge card: its own message, the pull request and its status; sending open while it waits; merged, refused, cancelled', () => {
  const card = (entries: readonly Entry[]) => {
    const message = messagesOf(stateOf(entries))[0]!
    const call = (message.content as unknown as QuestionPart[])[0]!
    assert.deepEqual([message.role, call.type, call.toolName], ['assistant', 'tool-call', 'merge'])
    return call.artifact!.merge!
  }
  const pending = card(pendingMerge)
  assert.deepEqual(
    [pending.status, pending.position, pending.title, pending.url, pending.repo, pending.number, pending.outcome],
    ['pending', '1', 'Add feature 7', 'https://github.com/owner/a/pull/7', 'owner/a', 7, null],
  )
  // Sending stays open: the person's message cancels the card, it does not answer it (docs/specs/merge.md).
  const state = stateOf(pendingMerge)
  const open = composerOf(state, workstreamOf(state, QUESTION_WS))
  assert.deepEqual([open.open, open.reason, open.refuses], [true, null, false])
  const answered = [...pendingMerge, commandEntry(2, 'Answer', { question: '1' }, { optionId: 'merge' })]
  assert.deepEqual([card(answered).status, card(answered).outcome], ['answered', null])
  assert.deepEqual(card([...answered, factEntry(3, 'merge.merged', { question: '1', sha: 'f00d1234' })]).outcome, { merged: true, sha: 'f00d1234' })
  assert.deepEqual(card([...answered, factEntry(3, 'merge.refused', { question: '1', reason: 'waiting for a review' })]).outcome, { merged: false, reason: 'waiting for a review' })
  assert.equal(card([...pendingMerge, factEntry(2, 'question.cancelled', { question: '1' })]).status, 'cancelled')
})

test('U99 the approvals Agora asks, as assistant-ui holds them: a question taking a note, an approval on its line and at its place, a merge card, each pending then settled; a permission its delegator answered', () => {
  type Held = { id: string; options?: { id: string; kind: string }[]; allowFreeform?: boolean; approved?: boolean; optionId?: string; text?: string; resolution?: string }
  const approvalOf = (entries: readonly Entry[]) => ((messagesOf(stateOf(entries))[0]!.content as unknown as QuestionPart[]).find((p) => p.type === 'tool-call')!.approval as unknown as Held)
  // A question: its note is the approval's free-form answer, recorded as its text.
  const question = approvalOf(pendingQuestion)
  assert.deepEqual([question.allowFreeform, question.optionId, question.text], [true, undefined, undefined])
  const answered = approvalOf(answeredQuestion)
  assert.deepEqual([answered.optionId, answered.approved, answered.text], ['revise', false, 'One criterion per behaviour.'])
  const noNote = approvalOf([commandEntry(1, 'Ask', {}, { ...asked, note: false })])
  assert.equal(noNote.allowFreeform, undefined)
  // An approval at its place: Approve, once; then approved, refused or expired.
  const gate = approvalOf(pendingApproval)
  assert.deepEqual([gate.options, gate.approved, gate.resolution], [[{ id: 'approve', kind: 'allow-once', label: 'Approve' }], undefined, undefined])
  assert.deepEqual([approvalOf(settled.answered).approved, approvalOf(settled.answered).optionId], [true, 'approve'])
  assert.deepEqual([approvalOf(settled.refused).approved, approvalOf(settled.refused).optionId], [false, undefined])
  assert.equal(approvalOf(settled.expired).resolution, 'expired')
  // A merge card: Merge, once; then merged, or cancelled by a message.
  const merge = approvalOf(pendingMerge)
  assert.deepEqual([merge.options?.map((o) => [o.id, o.kind]), merge.approved], [[['merge', 'allow-once']], undefined])
  assert.deepEqual(approvalOf([...pendingMerge, commandEntry(2, 'Answer', { question: '1' }, { optionId: 'merge' })]).optionId, 'merge')
  assert.equal(approvalOf([...pendingMerge, factEntry(2, 'question.cancelled', { question: '1' })]).resolution, 'cancelled')
  // An approval on the spawn_agent line it gates: that line's approval is Agora's, not the harness's.
  const onLine = crafted([
    turnObject('in_progress'),
    { kind: 'element', id: 'tool', object: { type: 'tool', turn: 't', session: 's', toolCallId: 'call-1', title: 'mcp__agora__spawn_agent', kind: 'other', status: 'in_progress', firstPosition: '2' } },
    { kind: 'element', id: 'gate', object: { type: 'question', kind: 'approval', toolCallId: 'call-1', position: '3', title: 'Review the change', text: 'proposal', options: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' }], status: 'pending', firstPosition: '3' } },
  ])
  const line = (messagesOf(onLine).find((m) => m.role === 'assistant')!.content as unknown as QuestionPart[]).find((p) => p.type === 'tool-call')!
  assert.deepEqual([(line.approval as unknown as Held).id, (line.approval as unknown as Held).options?.map((o) => o.id)], ['gate', ['approve']])
  // A permission its delegator answered: said on its line.
  const byDelegator = crafted([
    turnObject('done'),
    { kind: 'element', id: 'tool', object: { type: 'tool', turn: 't', session: 's', toolCallId: 'call-2', title: 'Write demo.txt', kind: 'edit', status: 'completed', firstPosition: '2' } },
    { kind: 'element', id: 'perm', object: { type: 'permission', turn: 't', session: 's', status: 'answered', from: 'd', as: 'delegator', answer: { outcome: { outcome: 'selected', optionId: 'allow-once' } }, params: { toolCall: { toolCallId: 'call-2' }, options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }] }, firstPosition: '3' } },
  ])
  const answeredLine = (messagesOf(byDelegator).find((m) => m.role === 'assistant')!.content as unknown as QuestionPart[]).find((p) => p.type === 'tool-call')!
  assert.deepEqual([answeredLine.artifact!.answeredBy, (answeredLine.approval as unknown as Held).optionId], ['delegator', 'allow-once'])
})

test('U100 a list row with a request pending, and a delegate waiting on one: waiting, as a question is; a Workstream in none with one is listed', () => {
  const row = { id: 'a', title: 'Sim', state: 'ready', harness: 'mock', question: null, request: '42', changedAt: '2026-11-16T10:00:00.000Z' } as const
  const view = workstreamOf(crafted([{ kind: 'workstream', id: MESSAGES_WS, object: { state: 'ready', execution: 'e', session: 's', request: '42' } }]), MESSAGES_WS)
  assert.equal(view.request, '42')
  const now = new Date('2026-11-16T12:00:00.000Z')
  assert.deepEqual(sections([{ ...row, state: 'none' }], now, '', null).flatMap((s) => s.workstreams.map((w) => w.id)), ['a'])
  assert.deepEqual(sections([{ ...row, state: 'none', request: null }], now, '', null), [])
})

// ---------------------------------------------------------------- forms (docs/specs/assistant-ui.md, "Forms")

test('U103 the forms of Claude Code and Codex, as assistant-ui holds them: one question of options — its “Other” folded in — an approval `select`, free-form; one text an approval `text`; one multi-select and several questions an interrupt; a number and a yes/no; settled; a secret form, nothing to answer; what each answer gives', () => {
  const formPart = (params: Record<string, unknown>, extra: Record<string, unknown> = {}, tool = false) => {
    const toolCallId = typeof params.toolCallId === 'string' ? params.toolCallId : undefined
    const state = crafted([
      turnObject('in_progress'),
      ...(tool && toolCallId ? [{ kind: 'element', id: 'tool', object: { type: 'tool', turn: 't', session: 's', toolCallId, title: 'Which database should the service use?', kind: 'other', status: 'pending', firstPosition: '2' } }] : []),
      { kind: 'element', id: 'form', object: { type: 'elicitation', turn: 't', session: 's', execution: 'e', requestId: 'mock-1', requestPosition: '3', params, status: 'pending', firstPosition: '3', ...extra } },
    ])
    const message = messagesOf(state).find((m) => m.role === 'assistant')!
    const parts = message.content as unknown as (QuestionPart & { interrupt?: { type: string; payload: unknown }; toolCallId?: string })[]
    return { part: parts.find((p) => p.type === 'tool-call')!, parts, message, state }
  }
  type Held = { display?: string; options?: { id: string; kind: string; label: string }[]; allowFreeform?: boolean; dismissible?: boolean; approved?: boolean; optionId?: string; text?: string; resolution?: string }
  // Claude Code, one question: on its AskUserQuestion line, an approval of options, its "Other" free-form.
  const one = formPart(askUserQuestion(ASKS.one!, 's', 'toolu_1'), {}, true)
  assert.equal(one.parts.length, 1, 'its own tool line holds it')
  const held = one.part.approval as unknown as Held
  assert.deepEqual([held.display, held.allowFreeform, held.dismissible, held.options?.map((o) => [o.id, o.kind])], ['select', true, true, [['PostgreSQL', '_option'], ['SQLite', '_option']]])
  assert.equal(one.part.artifact?.form?.shape, 'select')
  assert.deepEqual(one.message.status, { type: 'requires-action', reason: 'tool-calls' })
  const form = one.part.artifact!.form!
  assert.deepEqual(approvalAnswer(form, { approved: true, optionId: 'SQLite', text: 'for the tests' }), { action: 'accept', content: { question_0: 'SQLite', question_0_custom: 'for the tests' } })
  assert.deepEqual(approvalAnswer(form, { approved: true, text: 'MySQL' }), { action: 'accept', content: { question_0_custom: 'MySQL' } })
  assert.deepEqual(approvalAnswer(form, { approved: false }), { action: 'decline' })
  // Codex, one question: its field holds its question, required; "None of the above" and its note.
  const codex = formOf({ id: 'f', object: { type: 'elicitation', params: requestUserInput(QUESTIONS.one!, 's', 'call_1'), status: 'pending' } } as never)
  assert.deepEqual([codex.shape, codex.questions[0]?.question, codex.questions[0]?.required, codex.questions[0]?.other, codex.questions[0]?.options.map((o) => o.id)], ['select', 'Which environment should I deploy to?', true, 'environment_note', ['Staging', 'Production', 'None of the above']])
  // One text: an approval `text`.
  const text = formPart(requestUserInput(QUESTIONS.text!, 's', 'call_2'))
  assert.deepEqual([(text.part.approval as unknown as Held).display, text.part.artifact?.form?.shape], ['text', 'text'])
  assert.deepEqual(approvalAnswer(text.part.artifact!.form!, { approved: true, text: 'main' }), { action: 'accept', content: { branch: 'main' } })
  // One multi-select, several questions, a number and a yes/no: interrupts, answered by `resume`.
  for (const [params, shape] of [
    [askUserQuestion(ASKS.multi!, 's', 'toolu_2'), 'list'],
    [askUserQuestion(ASKS.several!, 's', 'toolu_3'), 'flow'],
    [requestUserInput(QUESTIONS.several!, 's', 'call_3'), 'flow'],
    [mcpForm('s'), 'flow'],
  ] as const) {
    const { part, message } = formPart(params)
    assert.deepEqual([part.artifact?.form?.shape, part.approval, part.interrupt?.type, message.status], [shape, undefined, 'human', { type: 'requires-action', reason: 'interrupt' }])
  }
  const several = formOf({ id: 'f', object: { type: 'elicitation', params: askUserQuestion(ASKS.several!, 's', 'toolu_3'), status: 'pending' } } as never)
  assert.deepEqual(several.questions.map((q) => [q.key, q.kind, q.question, q.label, q.other]), [
    ['question_0', 'one', 'Which database should the service use?', 'Database', 'question_0_custom'],
    ['question_1', 'many', 'Which checks should run before the merge?', 'Checks', 'question_1_custom'],
  ])
  assert.deepEqual(formContent(several, { question_0: ['SQLite'], question_1: ['Lint'] }, { question_1: 'a smoke test' }), { question_0: 'SQLite', question_1: ['Lint'], question_1_custom: 'a smoke test' })
  // Codex's questions in their order, though the log keeps no member order — jsonb's, the shorter key first —: `required`'s.
  const stored = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stored)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1)).map(([k, v]) => [k, stored(v)]))
        : value
  const asked = stored(requestUserInput(QUESTIONS.several!, 's', 'call_3')) as Record<string, unknown>
  assert.deepEqual(Object.keys((asked.requestedSchema as { properties: object }).properties), ['branch', 'environment', 'environment_note'])
  const ordered = formOf({ id: 'f', object: { type: 'elicitation', params: asked, status: 'pending' } } as never)
  assert.deepEqual(ordered.questions.map((q) => q.key), ['environment', 'branch'])
  const rollout = formOf({ id: 'f', object: { type: 'elicitation', params: mcpForm('s'), status: 'pending' } } as never)
  assert.deepEqual(rollout.questions.map((q) => [q.key, q.kind, q.required]), [['replicas', 'integer', true], ['canary', 'yes-no', false]])
  assert.deepEqual([numberFits(rollout.questions[0]!, '3'), numberFits(rollout.questions[0]!, '9'), numberFits(rollout.questions[0]!, '2.5')], [true, false, false])
  assert.deepEqual(formContent(rollout, { canary: ['true'] }, { replicas: '3' }), { replicas: 3, canary: true })
  // Settled: accepted, declined, cancelled; a secret form, Agora's decline, nothing to answer.
  const settle = (extra: Record<string, unknown>) => formPart(askUserQuestion(ASKS.one!, 's', 'toolu_1'), extra, true).part.approval as unknown as Held
  const accepted = settle({ status: 'answered', answer: { action: 'accept', content: { question_0: 'SQLite', question_0_custom: 'for the tests' } } })
  assert.deepEqual([accepted.approved, accepted.optionId, accepted.text], [true, 'SQLite', 'for the tests'])
  assert.deepEqual(settle({ status: 'answered', answer: { action: 'decline' } }).approved, false)
  assert.equal(settle({ status: 'answered', answer: { action: 'cancel' } }).resolution, 'cancelled')
  assert.equal(settle({ status: 'cancelled' }).resolution, 'cancelled')
  const secret = formPart(requestUserInput(QUESTIONS.secret!, 's', 'call_4'), { declined: 'secret' })
  assert.deepEqual([secret.part.artifact?.form?.declined, secret.part.interrupt, (secret.part.approval as unknown as Held | undefined)?.approved, secret.message.status], ['secret', undefined, false, { type: 'running' }])
  // The pending form a part's `resume` answers, by the tool call it names.
  assert.equal(formFor(formPart(askUserQuestion(ASKS.several!, 's', 'toolu_3')).state, 'toolu_3')?.id, 'form')
  // A form names the composer's reason.
  assert.equal(composerOf(one.state, { ...workstreamOf(one.state, MESSAGES_WS), state: 'ready' }).reason, 'Answer the question above.')
})

test('U119 harnesses as people name them, each with its mark: Claude Code, Codex, OpenCode, Antigravity; the mock and another by name, with no mark', () => {
  const named = ['claude-code', 'codex', 'opencode', 'antigravity', 'mock', 'other-harness'].map((h) => [h, harnessName(h)])
  assert.deepEqual(named, [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['antigravity', 'Antigravity'], ['mock', 'Mock agent'], ['other-harness', 'other-harness']])
  assert.equal(harnessName(null), 'the agent')
  assert.deepEqual(Object.keys(HARNESS_MARKS), ['claude-code', 'codex', 'opencode', 'antigravity'])
  // One SVG path each, on the 24 × 24 box, all different; the mock and the rest get the robot.
  for (const [harness, d] of Object.entries(HARNESS_MARKS)) assert.match(d, /^M[0-9.\s,a-zA-Z-]+$/, harness)
  assert.equal(new Set(Object.values(HARNESS_MARKS)).size, 4)
  assert.equal(HARNESS_MARKS.mock, undefined)
  assert.equal(HARNESS_MARKS['other-harness'], undefined)
  // Its service, offered as an access, by its name.
  assert.equal(accessEntries(['antigravity'])[0]!.name, 'Antigravity')
})
