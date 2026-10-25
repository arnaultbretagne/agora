// docs/specs/log.md, "Commands" and "Elements": a question to the person — Ask, then Answer — whatever
// the Workstream's execution, and the Write and Configure it holds back while it is pending.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { canonical, project, type Entry } from '../src/index.ts'
import { database, Lab, opened, until } from './support.ts'

const ENVELOPE = {
  title: 'Approve the envelope',
  text: '## The plan\n\nOne feature, one dev.',
  options: [
    { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
    { optionId: 'revise', name: 'Revise', kind: 'reject_once' },
    { optionId: 'stop', name: 'Stop', kind: 'reject_always' },
  ],
  note: true,
}

/** The Workstream's question elements and its view, folded from its entries. */
function views(entries: readonly Entry[]) {
  const objects = project(entries)
  return {
    questions: objects.filter((o) => o.kind === 'element' && o.object.type === 'question').map((o) => o.object as Record<string, unknown>),
    view: objects.find((o) => o.kind === 'workstream')?.object as Record<string, unknown> | undefined,
  }
}

async function bare(t: { after(fn: () => Promise<void>): void }) {
  const db = await database()
  const lab = await Lab.start({ db })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  return { db, lab, ws: await lab.workstream() }
}

const count = async (lab: Lab, ws: string) => (await lab.entries(ws)).length

test('L69 an Ask on a Workstream without execution is accepted, pending in the thread and the view, and sent to no agent', async (t) => {
  const { lab, ws } = await bare(t)
  assert.equal((await lab.state(ws)).current, null)
  const asked = await lab.command(ws, 'Ask', {}, ENVELOPE)
  assert.ok(asked.accepted)
  const entries = await lab.entries(ws)
  assert.deepEqual(entries.map((x) => x.kind), ['command'])
  assert.equal(entries.filter((x) => x.kind === 'acp').length, 0)
  const { questions, view } = views(entries)
  assert.equal(questions.length, 1)
  const q = questions[0]!
  assert.deepEqual(
    [q.position, q.title, q.text, canonical(q.options), q.note, q.status, q.answer],
    [asked.position, ENVELOPE.title, ENVELOPE.text, canonical(ENVELOPE.options), true, 'pending', undefined],
  )
  assert.equal(view?.question, asked.position)
  // The same, projected live for the thread.
  await until('the question projected', async () =>
    (await lab.workstreams.projections.objects(ws)).find((o) => o.kind === 'element' && o.object.type === 'question' && o.object.status === 'pending'),
  )
})

test('L70 an Ask while one is pending, and Asks outside their bounds, are refused and write nothing', async (t) => {
  const { lab, ws } = await bare(t)
  assert.ok((await lab.command(ws, 'Ask', {}, ENVELOPE)).accepted)
  const before = await count(lab, ws)
  assert.deepEqual(await lab.command(ws, 'Ask', {}, { ...ENVELOPE, title: 'Another' }), { accepted: false, reason: 'question_pending' })
  const { lab: other, ws: fresh } = await bare(t)
  const option = (optionId: string, kind = 'allow_once') => ({ optionId, name: optionId, kind })
  for (const body of [
    { ...ENVELOPE, options: [option('a')] },
    { ...ENVELOPE, options: ['a', 'b', 'c', 'd', 'e'].map((id) => option(id)) },
    { ...ENVELOPE, options: [option('a'), option('a', 'reject_once')] },
    { ...ENVELOPE, options: [option('a'), option('b', 'maybe')] },
    { ...ENVELOPE, title: 'Two\nlines' },
  ])
    assert.deepEqual(await other.command(fresh, 'Ask', {}, body), { accepted: false, reason: 'invalid_question' })
  assert.equal(await count(other, fresh), 0)
  assert.equal(await count(lab, ws), before)
  // Control: the same Workstream takes a valid one.
  assert.ok((await other.command(fresh, 'Ask', {}, ENVELOPE)).accepted)
})

test('L71 a Write and a Configure while a question is pending are refused; once it is answered, the Write is accepted', async (t) => {
  const { lab, ws, e } = await opened(t)
  const asked = await lab.command(ws, 'Ask', {}, ENVELOPE)
  assert.ok(asked.accepted)
  const before = await count(lab, ws)
  assert.deepEqual(await lab.write(ws, 'too early'), { accepted: false, reason: 'question_pending' })
  assert.deepEqual(await lab.command(ws, 'Configure', { execution: e.id, session: e.session }, { configId: 'model', value: 'mock-large' }), {
    accepted: false,
    reason: 'question_pending',
  })
  const after = await lab.entries(ws)
  assert.equal(after.length, before)
  assert.equal(after.filter((x) => x.kind === 'acp' && x.method === 'session/prompt').length, 0)
  assert.ok((await lab.command(ws, 'Answer', { question: asked.position }, { optionId: 'approve' })).accepted)
  assert.ok((await lab.write(ws, 'now')).accepted)
  await lab.turn(ws, 'done')
})

test('L72 an Answer with an option and a note answers the question, clears the view, and lets another Ask in', async (t) => {
  const { lab, ws } = await bare(t)
  const asked = await lab.command(ws, 'Ask', {}, ENVELOPE)
  assert.ok(asked.accepted)
  const answered = await lab.command(ws, 'Answer', { question: asked.position }, { optionId: 'revise', note: 'One criterion per behaviour.' })
  assert.ok(answered.accepted)
  const { questions, view } = views(await lab.entries(ws))
  assert.deepEqual([questions[0]!.status, canonical(questions[0]!.answer)], ['answered', canonical({ optionId: 'revise', note: 'One criterion per behaviour.' })])
  assert.equal(view?.question, null)
  const next = await lab.command(ws, 'Ask', {}, { ...ENVELOPE, title: 'Approve the revised envelope' })
  assert.ok(next.accepted)
  assert.equal(views(await lab.entries(ws)).view?.question, next.position)
})

test('L73 Answers to another position, to an answered question, with an option not offered or a note not allowed, are refused', async (t) => {
  const { lab, ws } = await bare(t)
  const plain = { ...ENVELOPE, note: false }
  const asked = await lab.command(ws, 'Ask', {}, plain)
  assert.ok(asked.accepted)
  let before = await count(lab, ws)
  assert.deepEqual(await lab.command(ws, 'Answer', { question: '999' }, { optionId: 'approve' }), { accepted: false, reason: 'stale_question' })
  assert.deepEqual(await lab.command(ws, 'Answer', { question: asked.position }, { optionId: 'merge' }), { accepted: false, reason: 'invalid_question_option' })
  assert.deepEqual(await lab.command(ws, 'Answer', { question: asked.position }, { optionId: 'approve', note: 'not asked for' }), {
    accepted: false,
    reason: 'invalid_answer',
  })
  assert.equal(await count(lab, ws), before)
  assert.ok((await lab.command(ws, 'Answer', { question: asked.position }, { optionId: 'approve' })).accepted)
  before = await count(lab, ws)
  assert.deepEqual(await lab.command(ws, 'Answer', { question: asked.position }, { optionId: 'stop' }), { accepted: false, reason: 'stale_question' })
  assert.equal(await count(lab, ws), before)
})

test('L74 the same Ask again under its id, once answered, returns its first answer and asks nothing new', async (t) => {
  const { lab, ws } = await bare(t)
  const ask = { id: randomUUID(), kind: 'Ask' as const, target: {}, body: ENVELOPE }
  const first = await lab.workstreams.command(ws, ask)
  assert.ok(first.accepted)
  assert.ok((await lab.command(ws, 'Answer', { question: first.position }, { optionId: 'approve' })).accepted)
  const again = await lab.workstreams.command(ws, structuredClone(ask))
  assert.equal(canonical(again), canonical(first))
  const { questions, view } = views(await lab.entries(ws))
  assert.equal(questions.length, 1)
  assert.equal(view?.question, null)
})
