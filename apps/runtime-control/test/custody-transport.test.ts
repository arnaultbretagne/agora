import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CustodyTransport, mintPlacementToken } from '../src/custody-transport.js'

const SECRET = 'bridge-auth-secret'
const BYTES = new TextEncoder().encode('{"type":"user","sessionId":"ctx-1"}\n')
const CHECKSUM = 'sha256:deadbeef'

function transport(payloads: Readonly<Record<string, Uint8Array>> = { 'save-1': BYTES, 'save-2': BYTES }): CustodyTransport {
  return new CustodyTransport({ secret: SECRET, readPayload: async (saveId) => payloads[saveId] ?? null })
}

const command = (saveId: string) => ({ podName: 'ws-pod-1', saveId, checksum: CHECKSUM, byteLength: BYTES.byteLength })
const report = (offer: { token: string }) => ({ token: offer.token, checksum: CHECKSUM, byteLength: BYTES.byteLength, path: '/home/agent/.claude/projects/-home-agent-work/ctx-1.jsonl' })

test('staging the same Save twice returns the same offer — a retried RESTORE reopens nothing', () => {
  const custody = transport()
  const first = custody.stage(command('save-1'))
  const second = custody.stage(command('save-1'))
  assert.deepEqual(first, second)
  assert.equal(first.token, mintPlacementToken('ws-pod-1', 'save-1', SECRET))
})

test('the gate stays shut while a placement is staged, and opens once it verifies', async () => {
  const custody = transport()
  const offer = custody.stage(command('save-1'))
  assert.match(custody.gateBlockedReason('ws-pod-1') ?? '', /has not been verified/)

  const outcome = custody.confirm('ws-pod-1', report(offer))

  assert.equal(outcome.kind, 'placed')
  assert.equal(custody.status('ws-pod-1'), 'placed')
  assert.equal(custody.gateBlockedReason('ws-pod-1'), null)
  // Once placed, the Pod is no longer offered the Save: there is nothing left for it to fetch.
  assert.equal(custody.offer('ws-pod-1'), null)
})

test('a Pod with no placement at all is the ordinary START case and the gate never blocks on it', () => {
  const custody = transport()
  assert.equal(custody.status('other-pod'), 'none')
  assert.equal(custody.gateBlockedReason('other-pod'), null)
  assert.equal(custody.offer('other-pod'), null)
})

test('a placement whose checksum disagrees with the Save is rejected and keeps the gate shut', () => {
  const custody = transport()
  const offer = custody.stage(command('save-1'))

  const outcome = custody.confirm('ws-pod-1', { ...report(offer), checksum: 'sha256:something-else' })

  assert.equal(outcome.kind, 'rejected')
  assert.equal(custody.status('ws-pod-1'), 'rejected')
  // Rejected, not forgotten: forgetting it would let the very next gate release succeed against a
  // transcript nobody verified.
  assert.match(custody.gateBlockedReason('ws-pod-1') ?? '', /was rejected/)
})

test('only the holder of the placement token can fetch the bytes or report a placement', async () => {
  const custody = transport()
  custody.stage(command('save-1'))

  assert.deepEqual(await custody.fetch('ws-pod-1', 'not-the-token'), { kind: 'unauthorized' })
  const wrongPod = mintPlacementToken('ws-pod-2', 'save-1', SECRET)
  assert.deepEqual(await custody.fetch('ws-pod-1', wrongPod), { kind: 'unauthorized' })
  const refused = custody.confirm('ws-pod-1', { ...report({ token: wrongPod }) })
  assert.equal(refused.kind, 'rejected')
  assert.equal(custody.status('ws-pod-1'), 'staged', 'a bad token leaves the placement untouched, it does not reject it')

  const fetched = await custody.fetch('ws-pod-1', mintPlacementToken('ws-pod-1', 'save-1', SECRET))
  assert.equal(fetched.kind, 'bytes')
})

test('CONT-008: bytes that are not in the store are an outage, not an incompatibility', async () => {
  const custody = transport({})
  const offer = custody.stage(command('save-1'))

  const fetched = await custody.fetch('ws-pod-1', offer.token)

  assert.deepEqual(fetched, { kind: 'payload_missing', saveId: 'save-1' })
  // Nothing was invalidated and nothing was rejected: the placement is still staged, waiting.
  assert.equal(custody.status('ws-pod-1'), 'staged')
})

test('an unfinished placement can be discarded or restaged; a verified one cannot', () => {
  const custody = transport()
  custody.stage(command('save-1'))
  assert.equal(custody.discard('ws-pod-1'), true)
  assert.equal(custody.status('ws-pod-1'), 'none')

  custody.stage(command('save-1'))
  const restaged = custody.stage(command('save-2'))
  assert.equal(restaged.saveId, 'save-2', 'a partial placement is abandoned wholesale, never merged with the new one')

  const outcome = custody.confirm('ws-pod-1', report(restaged))
  assert.equal(outcome.kind, 'placed')
  assert.equal(custody.discard('ws-pod-1'), false, 'the bytes are the Pod native state now')
  assert.throws(() => custody.stage(command('save-1')), /already has Save save-2 placed/)
})

test('a rejected placement is restageable, so the same attempt can retry without a new Pod', () => {
  const custody = transport()
  const offer = custody.stage(command('save-1'))
  custody.confirm('ws-pod-1', { ...report(offer), byteLength: 3 })
  assert.equal(custody.status('ws-pod-1'), 'rejected')

  // The Pod is still offered the Save while it is unplaced, and a retry that lands correctly clears
  // the rejection rather than needing the placement torn down first.
  const retried = custody.offer('ws-pod-1')
  assert.equal(retried?.saveId, 'save-1')
  assert.equal(custody.confirm('ws-pod-1', report({ token: retried!.token })).kind, 'placed')
  assert.equal(custody.gateBlockedReason('ws-pod-1'), null)
})
