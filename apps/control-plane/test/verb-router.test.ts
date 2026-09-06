import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Verb } from '@agora/domain'
import { RecordingVerbExecutor, type VerbContext } from '@agora/engine'
import { createVerbRouter } from '../src/verb-router.js'

function context(): VerbContext {
  return { workstreamId: 'w1', intentSeq: 1, workGeneration: 1, claimToken: 'claim-1', rule: 'SESSION-001' }
}

test('a routed verb goes to its own executor, never the fallback', async () => {
  const start = new RecordingVerbExecutor()
  const fallback = new RecordingVerbExecutor()
  const router = createVerbRouter({ START: start }, fallback)
  await router.execute('START', context())
  assert.equal(start.calls.length, 1)
  assert.equal(fallback.calls.length, 0)
})

test('an unrouted verb falls through to the fallback', async () => {
  const start = new RecordingVerbExecutor()
  const fallback = new RecordingVerbExecutor()
  const router = createVerbRouter({ START: start }, fallback)
  const verbs: readonly Verb[] = ['BUILD', 'TURN_OFF', 'GRANT', 'REVOKE', 'SET_MODEL', 'SET_EFFORT', 'RESTORE', 'REFILL']
  for (const verb of verbs) await router.execute(verb, context())
  assert.equal(fallback.calls.length, verbs.length)
  assert.equal(start.calls.length, 0)
})

test('a fallback failure propagates — the router never swallows it', async () => {
  const fallback = new RecordingVerbExecutor().failWith('BUILD', () => new Error('boom'))
  const router = createVerbRouter({}, fallback)
  await assert.rejects(() => router.execute('BUILD', context()), /boom/)
})
