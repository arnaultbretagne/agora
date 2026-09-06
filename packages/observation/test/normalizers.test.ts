import assert from 'node:assert/strict'
import { test } from 'node:test'
import { construction, harnessDigestForCatalogue, normalizeConstruction, normalizePower, normalizeSession } from '../src/index.js'
import type { PodObservation } from '../src/index.js'

function pod(overrides: Partial<PodObservation> = {}): PodObservation {
  return {
    uid: 'u1',
    phase: 'Running',
    imageId: null,
    admittedDigest: 'sha256:admitted',
    retiring: false,
    startupDeadlineExpired: false,
    harnessDigestFor: (admitted) => (admitted === 'sha256:admitted' ? 'sha256:harness' : null),
    ...overrides,
  }
}

test('OFF-003: a Failed or deadline-expired Pod contributes the bottom marker before any capability HOLD', () => {
  const failed = normalizeConstruction([pod({ phase: 'Failed' })])
  assert.equal(failed.kind === 'set' && failed.incoherent, true)
  const expired = normalizeConstruction([pod({ startupDeadlineExpired: true })])
  assert.equal(expired.kind === 'set' && expired.incoherent, true)
})

test('construction: one coherent Pod contributes {D}; duplicates contribute bottom', () => {
  const single = normalizeConstruction([pod()])
  assert.deepEqual(single, construction([{ digest: 'sha256:harness' }]))
  const duplicate = normalizeConstruction([pod({ uid: 'u1' }), pod({ uid: 'u2' })])
  assert.equal(duplicate.kind === 'set' && duplicate.incoherent, true)
  const unknownImage = normalizeConstruction([pod({ harnessDigestFor: () => null })])
  assert.equal(unknownImage.kind === 'set' && unknownImage.incoherent, true)
  const empty = normalizeConstruction([])
  assert.deepEqual(empty, construction([]))
})

test('power: any Pod in any phase or any obligation is on; off needs a complete empty listing', () => {
  assert.equal(normalizePower({ workstreamId: 'w', podCount: 1, unresolvedObligations: 0, complete: true }), 'on')
  assert.equal(normalizePower({ workstreamId: 'w', podCount: 0, unresolvedObligations: 2, complete: true }), 'on')
  assert.equal(normalizePower({ workstreamId: 'w', podCount: 0, unresolvedObligations: 0, complete: true }), 'off')
  assert.equal(normalizePower({ workstreamId: 'w', podCount: 0, unresolvedObligations: 0, complete: false }), null, 'OFF-006: an incomplete listing produces no off value')
})

test('session: pending within the deadline, openable when Running and unbound, unusable on terminal or expiry', () => {
  assert.equal(normalizeSession({ pod: pod({ phase: 'Pending' }), launchedContextBound: false, startupDeadlineSeconds: 120, podAgeSeconds: 10 }), 'pending')
  assert.equal(normalizeSession({ pod: pod({ phase: 'Running' }), launchedContextBound: false, startupDeadlineSeconds: 120, podAgeSeconds: 10 }), 'openable')
  assert.equal(normalizeSession({ pod: pod({ phase: 'Running' }), launchedContextBound: true, startupDeadlineSeconds: 120, podAgeSeconds: 10 }), null, 'a bound context is S8 evidence')
  assert.equal(normalizeSession({ pod: pod({ phase: 'Failed' }), launchedContextBound: false, startupDeadlineSeconds: 120, podAgeSeconds: 10 }), 'unusable')
  assert.equal(normalizeSession({ pod: pod({ startupDeadlineExpired: true }), launchedContextBound: false, startupDeadlineSeconds: 120, podAgeSeconds: 999 }), 'unusable')
  assert.equal(normalizeSession({ pod: null, launchedContextBound: false, startupDeadlineSeconds: 120, podAgeSeconds: 0 }), null)
})

test('harnessDigestForCatalogue: only a digest pinned in the catalogue contributes; a rotated-out digest maps to nothing', () => {
  const digestFor = harnessDigestForCatalogue([{ imageDigest: 'sha256:current' }])
  assert.equal(digestFor('sha256:current'), 'sha256:current')
  assert.equal(digestFor('sha256:stale'), null, 'a Pod admitted under a since-rotated digest is never guessed current')
})
