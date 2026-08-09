import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandId, eventId, principalId, sessionId, snapshotId, workstreamId } from '../src/ids.js'

test('branded id constructors reject empty strings', () => {
  for (const ctor of [workstreamId, principalId, sessionId, commandId, eventId, snapshotId]) {
    assert.throws(() => ctor(''), TypeError)
  }
})

test('branded id constructors accept opaque values without parsing them', () => {
  assert.equal(workstreamId('not-a-uuid-at-all'), 'not-a-uuid-at-all')
  assert.equal(sessionId('01234'), '01234')
})
