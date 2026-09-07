import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeSync, type SyncEvidence } from '../src/sync.js'

const nonEmpty = { w: 0, h: 12 }

function evidence(overrides: Partial<SyncEvidence> = {}): SyncEvidence {
  return { descriptor: nonEmpty, delivery: 'responded', proof: 'incorporated', lineageIntact: true, ...overrides }
}

test('CONT-002: the empty range is current without any proof at all — there is nothing to incorporate', () => {
  assert.equal(normalizeSync({ descriptor: { w: 0, h: 0 }, delivery: 'none', proof: 'unprovable', lineageIntact: false }), 'current')
})

test('current needs BOTH a delivered command and the driver finding it in the live context', () => {
  assert.equal(normalizeSync(evidence()), 'current')
  assert.equal(normalizeSync(evidence({ delivery: 'dispatched' })), null, 'a turn still in flight proves nothing yet')
  assert.equal(normalizeSync(evidence({ proof: 'unprovable' })), null, 'a recorded response is not native proof')
})

test('CONT-004: a responded command whose input the driver cannot find is not current', () => {
  // The URI is present but the payload differs, or the turn never completed. Either way the exact
  // input and completed incorporation are not established, so no value is produced.
  assert.equal(normalizeSync(evidence({ proof: 'unprovable' })), null)
  assert.equal(normalizeSync(evidence({ proof: 'not_incorporated' })), null, 'not stale either: a responded command may still have been accepted')
})

test('stale needs positive absence AND nothing outstanding that may already have been accepted', () => {
  assert.equal(normalizeSync(evidence({ proof: 'not_incorporated', delivery: 'none' })), 'stale')
  assert.equal(normalizeSync(evidence({ proof: 'not_incorporated', delivery: 'rejected_before_acceptance' })), 'stale', 'provably never sent is real absence')
})

test('CONT-005: an unknown delivery never becomes stale, however absent the range looks', () => {
  // Possibly accepted, response lost. Calling this stale would authorize a resend of a prompt the
  // context may already have acted on.
  assert.equal(normalizeSync(evidence({ proof: 'not_incorporated', delivery: 'unknown' })), null)
  assert.equal(normalizeSync(evidence({ proof: 'unprovable', delivery: 'unknown' })), null)
})

test('CONT-006: broken lineage invalidates evidence — a stored receipt never becomes live proof', () => {
  assert.equal(normalizeSync(evidence({ lineageIntact: false })), null)
  assert.equal(normalizeSync(evidence({ lineageIntact: false, proof: 'not_incorporated', delivery: 'none' })), null, 'and it does not fall through to stale')
})

test('no descriptor is no value', () => {
  assert.equal(normalizeSync(null), null)
  assert.equal(normalizeSync(evidence({ descriptor: null })), null)
})

test('S13: a non-empty opening range with no Handoff at all is stale, and REFILL is what unblocks it', () => {
  // Live: a fresh Session on a Workstream that already had history sat at
  // `acquisition:observation.sync` for ever. The range was non-empty, no Handoff had been rendered
  // for it, and the driver — asked to look for a digest that does not exist — could only answer
  // `unprovable`. The one verb that could have fixed it, REFILL, needs `stale`.
  //
  // The control plane knows what the driver cannot: whether a Handoff exists at all. When none does
  // and nothing is outstanding, `not_incorporated` is a fact about the record.
  assert.equal(
    normalizeSync({ descriptor: { w: 0, h: 3145 }, delivery: 'none', proof: 'not_incorporated', lineageIntact: true }),
    'stale',
  )

  // And the safety half is untouched: a Handoff that MIGHT have been accepted keeps it undecidable,
  // whatever the driver says, so nothing is ever resent (CONT-005).
  assert.equal(normalizeSync({ descriptor: { w: 0, h: 3145 }, delivery: 'unknown', proof: 'not_incorporated', lineageIntact: true }), null)
  assert.equal(normalizeSync({ descriptor: { w: 0, h: 3145 }, delivery: 'dispatched', proof: 'not_incorporated', lineageIntact: true }), null)
})
