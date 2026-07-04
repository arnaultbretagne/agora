import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore } from '../lib/store.js'

test('create → addMessage auto-titles from the first user turn', async () => {
  const store = new ConversationStore()
  const conv = await store.create({ kind: 'claude', model: 'default' })
  assert.equal(conv.title, 'Nouvelle conversation')
  await store.addMessage(conv.id, { role: 'user', text: 'Migrer la table orders sans downtime, plan complet et détaillé ?' })
  assert.equal(store.get(conv.id).title.length <= 45, true)
  assert.match(store.get(conv.id).title, /^Migrer la table/)
  // a second user message must NOT re-title
  await store.addMessage(conv.id, { role: 'user', text: 'autre chose' })
  assert.match(store.get(conv.id).title, /^Migrer la table/)
})

test('messages get monotonic ids/seq and updatedAt moves', async () => {
  const store = new ConversationStore()
  const conv = await store.create({})
  const m1 = await store.addMessage(conv.id, { role: 'user', text: 'a' })
  const m2 = await store.addMessage(conv.id, { role: 'assistant', text: 'b', replyTo: m1.id })
  assert.equal(m1.id, 'm1')
  assert.equal(m1.seq, 1)
  assert.equal(m2.id, 'm2')
  assert.equal(m2.seq, 2)
  assert.equal(m2.replyTo, 'm1')
  assert.equal(store.get(conv.id).updatedAt, m2.ts)
})

test('a fresh conversation carries an empty natives map (ADR 0007 handle map)', async () => {
  const store = new ConversationStore()
  const conv = await store.create({})
  assert.deepEqual(conv.natives, {})
})

test('patch (pin/title/model/effort/agent) never moves updatedAt — only addMessage does', async () => {
  const store = new ConversationStore()
  const conv = await store.create({})
  await store.addMessage(conv.id, { role: 'user', text: 'a' })
  const stamp = store.get(conv.id).updatedAt

  await store.patch(conv.id, { pinned: true })
  await store.patch(conv.id, { pinned: false })
  await store.patch(conv.id, { title: 'Renommée' })
  await store.patch(conv.id, { model: 'opus', effort: 'high', agent: 'reviewer' })
  assert.equal(store.get(conv.id).updatedAt, stamp, 'metadata patches must not touch updatedAt')

  const m2 = await store.addMessage(conv.id, { role: 'assistant', text: 'b' })
  assert.equal(store.get(conv.id).updatedAt, m2.ts, 'a real message still sets updatedAt to its own ts')
})

test('delete removes it from memory; unknown ops reject', async () => {
  const store = new ConversationStore()
  const conv = await store.create({})
  assert.equal(await store.delete(conv.id), true)
  assert.equal(store.get(conv.id), undefined)
  assert.equal(await store.delete(conv.id), false)
  await assert.rejects(() => store.addMessage('c-nope', { role: 'user', text: 'x' }), /unknown conversation/)
})
