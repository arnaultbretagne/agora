import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore } from '../lib/store.js'

test('create → addMessage auto-titles from the first user turn', async () => {
  const store = new ConversationStore()
  const conv = await store.create()
  assert.equal(conv.title, 'Nouvelle conversation')
  await store.addMessage(conv.id, { role: 'user', text: 'Migrer la table orders sans downtime, plan complet et détaillé ?' })
  assert.equal(store.get(conv.id).title.length <= 45, true)
  assert.match(store.get(conv.id).title, /^Migrer la table/)
  // a second user message must NOT re-title
  await store.addMessage(conv.id, { role: 'user', text: 'autre chose' })
  assert.match(store.get(conv.id).title, /^Migrer la table/)
})

test('messages get monotonic ids/seq and updatedAt moves; runId sticks to assistant turns', async () => {
  const store = new ConversationStore()
  const conv = await store.create()
  const m1 = await store.addMessage(conv.id, { role: 'user', text: 'a' })
  const m2 = await store.addMessage(conv.id, { role: 'assistant', text: 'b', replyTo: m1.id, runId: `${conv.id}-r1` })
  assert.equal(m1.id, 'm1')
  assert.equal(m1.seq, 1)
  assert.equal(m1.runId, undefined, 'user turns have no producer')
  assert.equal(m2.id, 'm2')
  assert.equal(m2.seq, 2)
  assert.equal(m2.replyTo, 'm1')
  assert.equal(m2.runId, `${conv.id}-r1`)
  assert.equal(store.get(conv.id).updatedAt, m2.ts)
})

test('a fresh conversation carries empty runs and anchors (ADR 0010)', async () => {
  const store = new ConversationStore()
  const conv = await store.create()
  assert.deepEqual(conv.runs, [])
  assert.deepEqual(conv.anchors, {})
  assert.equal(conv.spawnCount, 0)
})

test('addRun journals the frozen config and allocates monotonic ids; resolvedModel is the one backfill', async () => {
  const store = new ConversationStore()
  const conv = await store.create()
  const run1 = await store.addRun(conv.id, { kind: 'claude', model: 'sonnet', effort: 'high', nativeSessionId: 'uuid-1', resume: false })
  const run2 = await store.addRun(conv.id, { kind: 'claude', model: 'opus', nativeSessionId: 'uuid-1', resume: true })
  assert.equal(run1.id, `${conv.id}-r1`)
  assert.equal(run2.id, `${conv.id}-r2`)
  assert.equal(store.get(conv.id).spawnCount, 2)
  assert.equal(store.getRun(conv.id, run1.id).model, 'sonnet')
  assert.equal(store.lastRun(conv.id).model, 'opus')
  assert.equal(store.lastRun(conv.id).resume, true)

  assert.equal(await store.setRunResolvedModel(conv.id, run1.id, 'claude-sonnet-5'), true)
  assert.equal(await store.setRunResolvedModel(conv.id, run1.id, 'claude-sonnet-5'), false, 'idempotent → no re-broadcast')
  assert.equal(store.getRun(conv.id, run1.id).resolvedModel, 'claude-sonnet-5')
})

test('anchors move, clear, and are keyed per kind (ADR 0007/0010)', async () => {
  const store = new ConversationStore()
  const conv = await store.create()
  const run = await store.addRun(conv.id, { kind: 'claude', model: 'sonnet', nativeSessionId: 'uuid-1', resume: false })
  await store.setAnchor(conv.id, 'claude', { runId: run.id, syncedSeq: 2 })
  await store.setAnchor(conv.id, 'codex', { runId: 'other-run', syncedSeq: 7 })
  assert.deepEqual(store.get(conv.id).anchors.claude, { runId: run.id, syncedSeq: 2 })

  await store.setAnchor(conv.id, 'claude', { runId: run.id, syncedSeq: 4 })
  assert.equal(store.get(conv.id).anchors.claude.syncedSeq, 4)

  await store.clearAnchor(conv.id, 'claude')
  assert.equal(store.get(conv.id).anchors.claude, undefined)
  assert.deepEqual(store.get(conv.id).anchors.codex, { runId: 'other-run', syncedSeq: 7 }, 'other kinds untouched')
})

test('patch (pin/title) never moves updatedAt — only addMessage does', async () => {
  const store = new ConversationStore()
  const conv = await store.create()
  await store.addMessage(conv.id, { role: 'user', text: 'a' })
  const stamp = store.get(conv.id).updatedAt

  await store.patch(conv.id, { pinned: true })
  await store.patch(conv.id, { pinned: false })
  await store.patch(conv.id, { title: 'Renommée' })
  assert.equal(store.get(conv.id).updatedAt, stamp, 'metadata patches must not touch updatedAt')

  const m2 = await store.addMessage(conv.id, { role: 'assistant', text: 'b' })
  assert.equal(store.get(conv.id).updatedAt, m2.ts, 'a real message still sets updatedAt to its own ts')
})

test('delete removes it from memory; unknown ops reject', async () => {
  const store = new ConversationStore()
  const conv = await store.create()
  assert.equal(await store.delete(conv.id), true)
  assert.equal(store.get(conv.id), undefined)
  assert.equal(await store.delete(conv.id), false)
  await assert.rejects(() => store.addMessage('c-nope', { role: 'user', text: 'x' }), /unknown conversation/)
})
