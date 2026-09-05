import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ANCHOR_VALUES,
  CONSTRUCTION_EMPTY,
  INTENT_POWER_VALUES,
  POWER_VALUES,
  SESSION_VALUES,
  SYNC_VALUES,
  VERBS,
  capabilityId,
  construction,
  harnessId,
  intentSeq,
  isConstructionEmpty,
  isExactlyConstruction,
  workGeneration,
  workstreamId,
  sessionId,
} from '../src/index.js'

test('intent.power has exactly the two registered values', () => {
  assert.deepEqual([...INTENT_POWER_VALUES], ['on', 'off'])
})

test('observation.power has exactly the two registered values', () => {
  assert.deepEqual([...POWER_VALUES], ['on', 'off'])
})

test('observation.session has exactly the four registered values', () => {
  assert.deepEqual([...SESSION_VALUES], ['pending', 'openable', 'live', 'unusable'])
  assert.equal(SESSION_VALUES.length, 4)
})

test('observation.anchor has exactly the two registered values', () => {
  assert.deepEqual([...ANCHOR_VALUES], ['compatible', 'none'])
})

test('observation.sync has exactly the two registered values', () => {
  assert.deepEqual([...SYNC_VALUES], ['current', 'stale'])
})

test('the verb catalogue is closed with the nine registered verbs', () => {
  assert.deepEqual([...VERBS], ['BUILD', 'TURN_OFF', 'RESTORE', 'START', 'REFILL', 'SET_MODEL', 'SET_EFFORT', 'GRANT', 'REVOKE'])
  assert.equal(VERBS.length, 9)
})

test('observation.construction empty member list is the empty set', () => {
  assert.deepEqual(construction([]), CONSTRUCTION_EMPTY)
  assert.equal(isConstructionEmpty(CONSTRUCTION_EMPTY), true)
})

test('observation.construction one coherent envelope is exactly its digest', () => {
  const single = construction([{ digest: 'digest-a' }])
  assert.deepEqual(single, { kind: 'set', digests: new Set(['digest-a']), incoherent: false })
  assert.equal(isExactlyConstruction(single, 'digest-a'), true)
  assert.equal(isExactlyConstruction(single, 'digest-b'), false)
  assert.equal(isConstructionEmpty(single), false)
})

test('observation.construction duplicate envelopes on the same digest contribute the bottom marker', () => {
  const duplicated = construction([{ digest: 'digest-a' }, { digest: 'digest-a' }])
  assert.equal(duplicated.kind, 'set')
  assert.equal(duplicated.kind === 'set' && duplicated.incoherent, true)
  assert.equal(isExactlyConstruction(duplicated, 'digest-a'), false)
})

test('observation.construction two distinct digests contribute the bottom marker', () => {
  const mixed = construction([{ digest: 'digest-a' }, { digest: 'digest-b' }])
  assert.equal(mixed.kind, 'set')
  assert.equal(mixed.kind === 'set' && mixed.incoherent, true)
  assert.equal(isExactlyConstruction(mixed, 'digest-a'), false)
  assert.equal(isExactlyConstruction(mixed, 'digest-b'), false)
})

test('observation.construction an incomplete component contributes the bottom marker', () => {
  const withBottom = construction([{ digest: 'digest-a' }, { incoherent: true }])
  assert.equal(withBottom.kind === 'set' && withBottom.incoherent, true)
  const bottomOnly = construction([{ incoherent: true }])
  assert.equal(bottomOnly.kind === 'set' && bottomOnly.incoherent && bottomOnly.digests.size === 0, true)
  assert.equal(isExactlyConstruction(withBottom, 'digest-a'), false)
  assert.equal(isConstructionEmpty(withBottom), false)
})

test('branded identifier constructors validate their shape', () => {
  assert.equal(workstreamId('0f0e7d01-3c2d-4e5f-8a9b-1c2d3e4f5a6b'), '0f0e7d01-3c2d-4e5f-8a9b-1c2d3e4f5a6b')
  assert.throws(() => workstreamId('not-a-uuid'), TypeError)
  assert.equal(sessionId('0f0e7d01-3c2d-4e5f-8a9b-1c2d3e4f5a6b'), '0f0e7d01-3c2d-4e5f-8a9b-1c2d3e4f5a6b')
  assert.throws(() => sessionId('nope'), TypeError)
  assert.equal(harnessId('claude-code'), 'claude-code')
  assert.throws(() => harnessId(''), TypeError)
  assert.throws(() => harnessId(' padded '), TypeError)
  assert.equal(capabilityId('workspace.read'), 'workspace.read')
  assert.throws(() => capabilityId(''), TypeError)
  assert.equal(intentSeq(0), 0)
  assert.equal(intentSeq(43), 43)
  assert.throws(() => intentSeq(-1), TypeError)
  assert.throws(() => intentSeq(1.5), TypeError)
  assert.equal(workGeneration(1), 1)
  assert.throws(() => workGeneration(-3), TypeError)
  assert.throws(() => workGeneration(Number.NaN), TypeError)
})
