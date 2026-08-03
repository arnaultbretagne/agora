import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionId } from '../src/ids.js'
import { executionGrantReference, redactExecutionGrantActivation } from '../src/grants.js'

test('an execution grant reference must not be empty', () => {
  assert.throws(() => executionGrantReference(''), TypeError)
})

test('redaction never leaks the opaque grant reference', () => {
  const activation = {
    sessionId: sessionId('s-1'),
    reference: executionGrantReference('super-secret-reference'),
    capabilityDigest: new Uint8Array(32),
    expiresAt: new Date('2026-08-03T01:00:00Z'),
  }
  const redacted = redactExecutionGrantActivation(activation)
  assert.equal(redacted.reference, '[redacted]')
  assert.equal(JSON.stringify(redacted).includes('super-secret-reference'), false)
})
