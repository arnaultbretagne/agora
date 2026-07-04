import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PgConversationStore } from '../lib/pg-store.js'

const url = process.env.TEST_DATABASE_URL

test('pg store roundtrip', { skip: !url && 'set TEST_DATABASE_URL' }, async () => {
  const store = await PgConversationStore.open(url)
  const conv = await store.create({ kind: 'claude', model: 'default' })
  await store.addMessage(conv.id, { role: 'user', text: 'un' })
  await store.addMessage(conv.id, { role: 'assistant', text: 'deux' })
  await store.patch(conv.id, { pinned: true, title: 'Renommée' })

  // Phase 4 (ADR 0007) adds setNativeHandle — for now just assert the schema default survives.
  assert.deepEqual(store.get(conv.id).natives, {})

  const before = store.get(conv.id)
  await store.close()

  const reopened = await PgConversationStore.open(url)
  assert.deepEqual(reopened.get(conv.id), before)

  assert.equal(await reopened.delete(conv.id), true)
  await reopened.close()

  const reopenedAgain = await PgConversationStore.open(url)
  assert.equal(reopenedAgain.get(conv.id), undefined)
  await reopenedAgain.close()
})
