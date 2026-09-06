import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeSessionWithAcp } from '../src/session.js'
import type { PodObservation } from '../src/types.js'

function pod(overrides: Partial<PodObservation> = {}): PodObservation {
  return { uid: 'u1', phase: 'Running', imageId: null, admittedDigest: null, retiring: false, startupDeadlineExpired: false, harnessDigestFor: () => null, ...overrides }
}

test('live: a connected, matching-generation context on a Running Pod is live', () => {
  const value = normalizeSessionWithAcp({
    pod: pod(),
    startupDeadlineSeconds: 120,
    podAgeSeconds: 10,
    acp: { connected: true, contextId: 'ctx-1', contextProcessGeneration: 0, currentProcessGeneration: 0 },
  })
  assert.equal(value, 'live')
})

test('unusable: a context bound to an old process generation is lost, not silently treated as absent', () => {
  const value = normalizeSessionWithAcp({
    pod: pod(),
    startupDeadlineSeconds: 120,
    podAgeSeconds: 10,
    acp: { connected: true, contextId: 'ctx-1', contextProcessGeneration: 0, currentProcessGeneration: 1 },
  })
  assert.equal(value, 'unusable', 'SESSION-A06 shape: a process restart invalidates the old context, it never reopens silently')
})

test('a terminal Pod is unusable even with an apparently live context', () => {
  const value = normalizeSessionWithAcp({
    pod: pod({ phase: 'Failed' }),
    startupDeadlineSeconds: 120,
    podAgeSeconds: 10,
    acp: { connected: true, contextId: 'ctx-1', contextProcessGeneration: 0, currentProcessGeneration: 0 },
  })
  assert.equal(value, 'unusable')
})

test('no ACP evidence yet: falls back to Pod-based pending/openable', () => {
  assert.equal(normalizeSessionWithAcp({ pod: pod({ phase: 'Pending' }), startupDeadlineSeconds: 120, podAgeSeconds: 5, acp: null }), 'pending')
  assert.equal(normalizeSessionWithAcp({ pod: pod({ phase: 'Running' }), startupDeadlineSeconds: 120, podAgeSeconds: 5, acp: null }), 'openable')
})

test('a disconnected or context-less ACP read falls back to Pod-based evidence rather than claiming live', () => {
  const value = normalizeSessionWithAcp({
    pod: pod({ phase: 'Running' }),
    startupDeadlineSeconds: 120,
    podAgeSeconds: 5,
    acp: { connected: false, contextId: null, contextProcessGeneration: null, currentProcessGeneration: 0 },
  })
  assert.equal(value, 'openable')
})

test('no Pod at all: inapplicable (null), never inferred', () => {
  assert.equal(normalizeSessionWithAcp({ pod: null, startupDeadlineSeconds: 120, podAgeSeconds: 0, acp: null }), null)
})
