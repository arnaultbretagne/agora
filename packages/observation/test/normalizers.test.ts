import assert from 'node:assert/strict'
import { test } from 'node:test'
import { construction, harnessDigestForCatalogue, normalizeConstruction, normalizeConstructionWithBinding, normalizeGrantsAttached, normalizeGrantsEffective, normalizePower, normalizePowerWithBroker, normalizeSession } from '../src/index.js'
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

test('normalizePowerWithBroker: an Agent, grant or binding with no Pod at all is still on (002: a missing Pod cannot hide them)', () => {
  const emptyKubernetes = { workstreamId: 'w', podCount: 0, unresolvedObligations: 0, complete: true }
  assert.equal(normalizePowerWithBroker(emptyKubernetes, { agentExists: true, hasAnyGrant: false, hasBinding: false }), 'on')
  assert.equal(normalizePowerWithBroker(emptyKubernetes, { agentExists: false, hasAnyGrant: true, hasBinding: false }), 'on')
  assert.equal(normalizePowerWithBroker(emptyKubernetes, { agentExists: false, hasAnyGrant: false, hasBinding: true }), 'on')
})

test('normalizePowerWithBroker: off needs both a complete empty Kubernetes listing AND a read, empty broker inventory', () => {
  const emptyKubernetes = { workstreamId: 'w', podCount: 0, unresolvedObligations: 0, complete: true }
  assert.equal(normalizePowerWithBroker(emptyKubernetes, { agentExists: false, hasAnyGrant: false, hasBinding: false }), 'off')
  assert.equal(normalizePowerWithBroker(emptyKubernetes, null), null, 'an unread broker inventory cannot prove off')
})

test('normalizePowerWithBroker: a Kubernetes footprint alone still proves on while the broker owner is unreachable', () => {
  const onKubernetes = { workstreamId: 'w', podCount: 1, unresolvedObligations: 0, complete: true }
  assert.equal(normalizePowerWithBroker(onKubernetes, null), 'on')
})

test('normalizeConstructionWithBinding: agentBound:false makes an otherwise-coherent Pod incoherent', () => {
  const coherentPod = pod({ admittedDigest: 'sha256:admitted' })
  const withoutBinding = normalizeConstructionWithBinding([{ ...coherentPod, agentBound: false }])
  assert.equal(withoutBinding.kind === 'set' && withoutBinding.incoherent, true)
})

test('normalizeConstructionWithBinding: omitting agentBound entirely keeps S6\'s Kubernetes-only coherence', () => {
  const coherentPod = pod({ admittedDigest: 'sha256:admitted' })
  assert.deepEqual(normalizeConstructionWithBinding([coherentPod]), normalizeConstruction([coherentPod]))
})

test('normalizeGrantsAttached/Effective: an unsettled read is unavailable, never an empty or full guess', () => {
  assert.deepEqual(normalizeGrantsAttached(undefined), { ok: false, reason: 'unavailable' })
  assert.deepEqual(normalizeGrantsEffective(undefined), { ok: false, reason: 'unavailable' })
})

test('normalizeGrantsAttached/Effective: a settled consistent pair reports its own attached/effective sets', () => {
  const attached = new Set([{ kind: 'secret' as const, credential: 's1', tools: 'full' as const, approval: 'unconditional' as const, restrictions: [] }])
  const effective = new Set<(typeof attached extends Set<infer T> ? T : never)>()
  assert.deepEqual(normalizeGrantsAttached({ attached }), { ok: true, value: attached })
  assert.deepEqual(normalizeGrantsEffective({ effective }), { ok: true, value: effective })
})

test('S13: a Pod still PULLING its image is coherent — an empty imageId is absence of evidence, not a stranger', () => {
  // The kubelet publishes a container status whose imageID is "" while the pull is in flight. Read
  // as an id it matched nothing in the catalogue, the Pod read as incoherent, and CONSTRUCT-002
  // selects TURN_OFF for that: on the first live deployment every harness Pod was destroyed
  // mid-pull, so no image slower to pull than one tick could ever converge.
  const pulling = normalizeConstruction([pod({ phase: 'Pending', imageId: '' })])
  assert.deepEqual(pulling, construction([{ digest: 'sha256:harness' }]), 'the admitted digest is what is known, and it is the right one')

  // Once it IS running something, that something is what counts — including when it is wrong.
  const stranger = normalizeConstruction([pod({ phase: 'Running', imageId: 'sha256:somebody-elses' })])
  assert.equal(stranger.kind === 'set' && stranger.incoherent, true)

  // And an empty ADMITTED digest is not an image either: nothing to compare, so incoherent.
  const nothing = normalizeConstruction([pod({ phase: 'Pending', imageId: '', admittedDigest: '' })])
  assert.equal(nothing.kind === 'set' && nothing.incoherent, true)
})
