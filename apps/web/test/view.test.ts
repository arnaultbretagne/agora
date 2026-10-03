// docs/specs/assistant-ui.md, acceptance cases: the client's objects and conversion, on the objects the
// log's projection folds from a real history (test/fixtures/mock.json: the log, real bridges and the
// mock agent, captured by scripts/capture.fixture.ts), cut at each moment that matters.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { CoreProjection, decode, project, type Entry } from '@agora/log'
import { apply, empty, type ThreadRow, type ThreadState } from '../src/agora/objects.ts'
import { composerOf, continueBody, messagesOf, noticeText, planItems, workstreamOf, type WorkstreamView } from '../src/agora/view.ts'

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
  assert.equal(composerOf(pending, workstreamOf(pending, ws)).reason, 'Answer the permission request first.')
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

test('U9 an execution ended with an anchor: Continue, then the restored Session', () => {
  const ended = at(fixture.marks.ended!)
  const view = workstreamOf(ended, ws)
  assert.equal(view.state, 'ended')
  assert.deepEqual(continueBody(view), { pool: 'mock-test', anchor: view.anchor })
  assert.equal(typeof view.anchor, 'string')
  const after = messagesOf(at(fixture.marks.restored!)).filter((m) => m.role === 'system').map((m) => (m.content as unknown as { text: string }[])[0]!.text)
  assert.equal(after.at(-1), 'Session restored: the agent remembers the history above.')
})

test('U10 each notice type: its text', () => {
  const notices = messagesOf(at(last))
    .filter((m) => m.role === 'system')
    .map((m) => [m.metadata!.custom!.notice, (m.content as unknown as { text: string }[])[0]!.text])
  assert.deepEqual(notices, [
    ['session.opened', 'Session started with mock.'],
    ['execution.break', 'Connection to the sandbox lost, reconnecting…'],
    ['execution.break', 'Connection to the sandbox lost, reconnecting…'],
    ['execution.lost', 'The sandbox was lost (adapter_exited). The history is kept.'],
    ['session.ended', 'Session ended (adapter_exited).'],
    ['execution.ended', 'The execution has ended.'],
    ['session.opened', 'Session restored: the agent remembers the history above.'],
  ])
  assert.equal(noticeText({ type: 'session.opened', origin: 'new', harness: 'mock' }, false), 'New session: the agent does not know the history above.')
  assert.equal(noticeText({ type: 'request.failed', reason: 'deadline_refused' }, false), 'A request failed (deadline_refused).')
  assert.equal(noticeText({ type: 'execution.failed', reason: 'startup_failed' }, false), 'The execution could not start (startup_failed).')
})

test('U11 each Workstream state: the composer and its reason', () => {
  const created = fixture.entries.find((e) => e.kind === 'command' && e.content.kind === 'Create')!
  const cases: [string, string, boolean, string | null][] = [
    [created.position, 'starting', false, 'Starting the sandbox…'],
    [fixture.marks.opened!, 'ready', true, null],
    [fixture.marks.uncertain!, 'interrupted', false, 'Connection to the sandbox lost, reconnecting…'],
    [fixture.marks.lost!, 'lost', false, 'The sandbox was lost.'],
    [fixture.marks.ended!, 'ended', false, null],
    [fixture.marks.stopped!, 'stopped', false, 'Stopped. The sandbox ends at its deadline.'],
  ]
  for (const [position, expected, open, reason] of cases) {
    const state = at(position)
    const view = workstreamOf(state, ws)
    const composer = composerOf(state, view)
    assert.deepEqual([view.state, composer.open, composer.reason], [expected, open, reason], `at ${position}`)
  }
  const none = workstreamOf(at('0'), ws)
  assert.equal(none.state, 'none')
  const failed: WorkstreamView = { ...workstreamOf(at(last), ws), state: 'failed' }
  assert.equal(composerOf(at(last), failed).reason, 'The execution could not start.')
})
