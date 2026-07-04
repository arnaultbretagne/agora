import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PgConversationStore } from '../lib/pg-store.js'

const url = process.env.TEST_DATABASE_URL

test('pg store roundtrip (ADR 0010 schema: conversations, runs, messages, anchors)', { skip: !url && 'set TEST_DATABASE_URL' }, async () => {
  const store = await PgConversationStore.open(url)
  const conv = await store.create()
  await store.addMessage(conv.id, { role: 'user', text: 'un' })
  const run = await store.addRun(conv.id, { kind: 'claude', model: 'sonnet', effort: 'high', nativeSessionId: 'uuid-test-1', resume: false })
  await store.addMessage(conv.id, { role: 'assistant', text: 'deux', runId: run.id })
  await store.setRunResolvedModel(conv.id, run.id, 'claude-sonnet-5')
  await store.setAnchor(conv.id, 'claude', { runId: run.id, syncedSeq: 2 })
  await store.setLive(conv.id, { runId: run.id, token: 'tok-1' })
  await store.patch(conv.id, { pinned: true, title: 'Renommée' })

  const before = store.get(conv.id)
  await store.close()

  const reopened = await PgConversationStore.open(url)
  assert.deepEqual(reopened.get(conv.id), before)
  assert.equal(reopened.getRun(conv.id, run.id).resolvedModel, 'claude-sonnet-5')
  assert.deepEqual(reopened.get(conv.id).anchors.claude, { runId: run.id, syncedSeq: 2 })

  // anchor deletion persists too
  await reopened.clearAnchor(conv.id, 'claude')
  await reopened.close()
  const reopened2 = await PgConversationStore.open(url)
  assert.equal(reopened2.get(conv.id).anchors.claude, undefined)

  assert.equal(await reopened2.delete(conv.id), true)
  await reopened2.close()

  const reopenedAgain = await PgConversationStore.open(url)
  assert.equal(reopenedAgain.get(conv.id), undefined)
  await reopenedAgain.close()
})
