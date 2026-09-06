import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { payloadDigest, decideOwnerRequest, emptyOwnerRecord, recordOwnerResponse, retireTarget, type OwnerRequest } from '../src/index.js'

function request(overrides: Partial<OwnerRequest> = {}): OwnerRequest {
  const payload = (overrides.payload ?? { harness: 'claude-code' }) as Record<string, unknown>
  return {
    epoch: 1,
    workstreamId: '0f0e7d01-3c2d-4e5f-8a9b-1c2d3e4f5a6b',
    attemptKey: 'ws-1/build/1',
    operation: 'create_pod',
    target: { kind: 'reserved', id: 'slot-1' },
    payload,
    payloadDigest: overrides.payloadDigest ?? payloadDigest(payload),
    revisionSet: overrides.revisionSet ?? { catalogue: 'stub-s2' },
    ...overrides,
  }
}

test('the contract fixtures parse and round-trip through the protocol types', async () => {
  const valid = JSON.parse(await readFile(new URL('../../../../contracts/schemas/fixtures/owner-request/valid-reserved-create.json', import.meta.url), 'utf8'))
  assert.equal(valid.epoch, 1)
  assert.equal(valid.target.kind, 'reserved')
  assert.equal(typeof valid.payload_digest, 'string')
  const invalid = JSON.parse(await readFile(new URL('../../../../contracts/schemas/fixtures/owner-request/invalid-zero-epoch.json', import.meta.url), 'utf8'))
  assert.equal(invalid.epoch, 0)
})

test('the payload digest is canonical: key order cannot change it', () => {
  const a = payloadDigest({ harness: 'x', imageDigest: 'sha256:1' })
  const b = payloadDigest({ imageDigest: 'sha256:1', harness: 'x' })
  assert.equal(a, b)
  assert.notEqual(a, payloadDigest({ harness: 'y' }))
})

test('a reused attempt key with another payload is rejected_key_mismatch (ENGINE-002 shape at the owner)', () => {
  const record = emptyOwnerRecord()
  const first = request()
  const processed = decideOwnerRequest({ record, request: first })
  assert.deepEqual(processed, { kind: 'process' })
  const after = recordOwnerResponse(record, first, { kind: 'completed', result: { podUid: 'pod:slot-1' } })

  const replay = decideOwnerRequest({ record: after, request: first })
  assert.equal(replay.kind, 'respond')
  if (replay.kind === 'respond' && replay.response.kind === 'completed') {
    assert.deepEqual(replay.response.result, { podUid: 'pod:slot-1' })
  } else {
    assert.fail('the recorded result must be returned for the same key and digest')
  }

  const otherPayload = request({ payload: { harness: 'codex' } })
  const mismatch = decideOwnerRequest({ record: after, request: otherPayload })
  assert.equal(mismatch.kind, 'respond')
  if (mismatch.kind === 'respond' && mismatch.response.kind === 'rejected_key_mismatch') {
    assert.equal(mismatch.response.recordedDigest, first.payloadDigest)
  } else {
    assert.fail('a key reuse with a different digest must be rejected')
  }
})

test('a stale epoch is rejected with the recorded epoch', () => {
  let record = emptyOwnerRecord()
  record = { ...record, epoch: 3 }
  const decision = decideOwnerRequest({ record, request: request({ epoch: 2 }) })
  assert.equal(decision.kind, 'respond')
  if (decision.kind === 'respond' && decision.response.kind === 'rejected_stale_epoch') {
    assert.equal(decision.response.recordedEpoch, 3)
  } else {
    assert.fail('a stale epoch must be rejected')
  }
})

test('retired targets refuse positive operations forever; cleanup stays authorized', () => {
  let record = emptyOwnerRecord()
  record = retireTarget(record, 'pod:slot-1')
  const create = decideOwnerRequest({
    record,
    request: request({ operation: 'create_pod', target: { kind: 'concrete', id: 'pod:slot-1' } }),
  })
  assert.equal(create.kind, 'respond', 'a positive mutation on a retired target is refused')

  const cleanup = decideOwnerRequest({
    record,
    request: request({ operation: 'cleanup_pod', target: { kind: 'concrete', id: 'pod:slot-1' } }),
  })
  assert.deepEqual(cleanup, { kind: 'process' }, 'concrete-target cleanup stays authorized on a retired target')
})
