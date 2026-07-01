import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../lib/store.js'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'agora-store-'))
  return { store: new ConversationStore(dir), dir }
}

test('create → addMessage auto-titles from the first user turn', () => {
  const { store, dir } = tempStore()
  const conv = store.create({ kind: 'claude', model: 'default' })
  assert.equal(conv.title, 'Nouvelle conversation')
  store.addMessage(conv.id, { role: 'user', text: 'Migrer la table orders sans downtime, plan complet et détaillé ?' })
  assert.equal(store.get(conv.id).title.length <= 45, true)
  assert.match(store.get(conv.id).title, /^Migrer la table/)
  // a second user message must NOT re-title
  store.addMessage(conv.id, { role: 'user', text: 'autre chose' })
  assert.match(store.get(conv.id).title, /^Migrer la table/)
  rmSync(dir, { recursive: true, force: true })
})

test('messages get monotonic ids and updatedAt moves', () => {
  const { store, dir } = tempStore()
  const conv = store.create({})
  const m1 = store.addMessage(conv.id, { role: 'user', text: 'a' })
  const m2 = store.addMessage(conv.id, { role: 'assistant', text: 'b', replyTo: m1.id })
  assert.equal(m1.id, 'm1')
  assert.equal(m2.id, 'm2')
  assert.equal(m2.replyTo, 'm1')
  assert.equal(store.get(conv.id).updatedAt, m2.ts)
  rmSync(dir, { recursive: true, force: true })
})

test('state survives reload from disk (files are the persistence)', () => {
  const { store, dir } = tempStore()
  const conv = store.create({ kind: 'claude' })
  store.addMessage(conv.id, { role: 'user', text: 'persist me' })
  store.patch(conv.id, { pinned: true, title: 'Renommée' })
  store.bumpSpawn(conv.id)

  const reloaded = new ConversationStore(dir)
  const got = reloaded.list().find((c) => c.id === conv.id)
  assert.ok(got, 'conversation reloaded')
  assert.equal(got.title, 'Renommée')
  assert.equal(got.pinned, true)
  assert.equal(got.spawnCount, 1)
  assert.equal(got.messages.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('delete removes memory and disk; unknown ops throw', () => {
  const { store, dir } = tempStore()
  const conv = store.create({})
  assert.equal(store.delete(conv.id), true)
  assert.equal(store.get(conv.id), undefined)
  assert.equal(store.delete(conv.id), false)
  assert.throws(() => store.addMessage('c-nope', { role: 'user', text: 'x' }), /unknown conversation/)
  rmSync(dir, { recursive: true, force: true })
})
