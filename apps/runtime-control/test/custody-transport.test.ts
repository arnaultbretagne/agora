import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { CustodyTransport, mintCaptureToken, mintPlacementToken } from '../src/custody-transport.js'

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

// --- capture (S9 Step 3) --------------------------------------------------------------------

const CAPTURE_REPORT = {
  checksum: `sha256:${'0'.repeat(64)}`,
  formatId: 'claude-code-transcript',
  formatVersion: 1,
  driverRevision: 'claude-code-transcript-1',
  frontierW: 0,
  nativeOrigin: { podUid: 'pod-uid-1' },
  workspaceDeps: {},
}

function captureTransport(): { custody: CustodyTransport; written: { saveId: string; bytes: Uint8Array }[] } {
  const written: { saveId: string; bytes: Uint8Array }[] = []
  const custody = new CustodyTransport({
    secret: SECRET,
    readPayload: async () => null,
    writePayload: async (saveId, bytes) => void written.push({ saveId, bytes }),
    newStagingId: () => 'staging-1',
  })
  return { custody, written }
}

function reportFor(bytes: Uint8Array, token: string): Parameters<CustodyTransport['submitCapture']>[1] {
  return { ...CAPTURE_REPORT, token, checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
}

test('asking for the same capture twice does not restart it, and an answer is not re-asked', async () => {
  const { custody } = captureTransport()
  const first = custody.requestCapture({ podName: 'ws-pod-1', contextId: 'ctx-1', processGeneration: 0 })
  const second = custody.requestCapture({ podName: 'ws-pod-1', contextId: 'ctx-1', processGeneration: 0 })
  assert.deepEqual(first, second)
  assert.deepEqual(custody.captureRequest('ws-pod-1'), first, 'the Pod is told about it until it answers')

  await custody.submitCapture('ws-pod-1', reportFor(BYTES, first.token), BYTES)

  assert.equal(custody.captureRequest('ws-pod-1'), null, 'answered: nothing left to publish to the Pod')
  assert.equal(custody.captureOutcome('ws-pod-1').kind, 'captured')
})

test('SESSION-A06: a capture keyed to a new generation replaces the pending one', () => {
  const { custody } = captureTransport()
  const old = custody.requestCapture({ podName: 'ws-pod-1', contextId: 'ctx-1', processGeneration: 0 })
  const fresh = custody.requestCapture({ podName: 'ws-pod-1', contextId: 'ctx-1', processGeneration: 1 })

  assert.notEqual(fresh.token, old.token)
  // The old cut's process is gone, so its capture can never complete; nothing waits on it.
  assert.equal(custody.captureRequest('ws-pod-1')?.processGeneration, 1)
})

test('a refusal from the driver is an answer, recorded as one', async () => {
  const { custody } = captureTransport()
  const request = custody.requestCapture({ podName: 'ws-pod-1', contextId: 'ctx-1', processGeneration: 0 })

  const outcome = await custody.submitCapture('ws-pod-1', { ...CAPTURE_REPORT, token: request.token, refusedReason: 'the transcript was still changing' }, new Uint8Array())

  assert.deepEqual(outcome, { kind: 'refused', reason: 'the transcript was still changing' })
  assert.equal(custody.captureOutcome('ws-pod-1').kind, 'refused')
})

test('bytes that disagree with the driver\'s own checksum are refused, never stored', async () => {
  const { custody, written } = captureTransport()
  const request = custody.requestCapture({ podName: 'ws-pod-1', contextId: 'ctx-1', processGeneration: 0 })

  const outcome = await custody.submitCapture('ws-pod-1', reportFor(BYTES, request.token), new TextEncoder().encode('something else'))

  assert.equal(outcome.kind, 'refused')
  assert.equal(written.length, 0, 'storing either side of a disagreement would make the Save checksum a lie')
})

test('a capture posted with the wrong token changes nothing', async () => {
  const { custody } = captureTransport()
  custody.requestCapture({ podName: 'ws-pod-1', contextId: 'ctx-1', processGeneration: 0 })

  const outcome = await custody.submitCapture('ws-pod-1', reportFor(BYTES, mintCaptureToken('ws-pod-1', 'ctx-1', 9, SECRET)), BYTES)

  assert.equal(outcome.kind, 'refused')
  assert.equal(custody.captureOutcome('ws-pod-1').kind, 'pending', 'the real capture is still owed')
})

test('the bytes are written only under the Save the control plane committed', async () => {
  const { custody, written } = captureTransport()
  const request = custody.requestCapture({ podName: 'ws-pod-1', contextId: 'ctx-1', processGeneration: 0 })
  await custody.submitCapture('ws-pod-1', reportFor(BYTES, request.token), BYTES)
  assert.equal(written.length, 0, 'nothing is stored while no Save exists to reference')

  assert.equal(await custody.commitCapture('ws-pod-1', 'staging-1', 'save-42'), 'committed')

  assert.equal(written.length, 1)
  assert.equal(written[0]!.saveId, 'save-42')
  assert.deepEqual(written[0]!.bytes, BYTES)
  // Committed and forgotten: a second commit has nothing to write, and says so.
  assert.equal(await custody.commitCapture('ws-pod-1', 'staging-1', 'save-42'), 'no_capture')
})

test('committing a staging id this transport never held is refused rather than assumed', async () => {
  const { custody } = captureTransport()
  const request = custody.requestCapture({ podName: 'ws-pod-1', contextId: 'ctx-1', processGeneration: 0 })
  await custody.submitCapture('ws-pod-1', reportFor(BYTES, request.token), BYTES)

  assert.equal(await custody.commitCapture('ws-pod-1', 'staging-from-another-process', 'save-42'), 'no_capture')
})
