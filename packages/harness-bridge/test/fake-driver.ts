import { createHash } from 'node:crypto'
import type { CapturedSave, CustodyDriver, OpeningDescriptor, OpeningProof, QuiescentCut, RestorePlacement } from '@agora/custody'

function checksumOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * A driver that does nothing but record what it was asked. The bridge package's job is the protocol
 * around a driver — the poll, the endpoints, the headers, what a refusal means — and testing that
 * against a real harness's driver would test the harness instead.
 */
export class FakeDriver implements CustodyDriver {
  readonly harnessId = 'fake'
  readonly driverRevision = 'fake-1'
  readonly formatId = 'fake-format'
  readonly formatVersion = 1

  readonly captured: QuiescentCut[] = []
  readonly restored: Uint8Array[] = []
  readonly proved: OpeningDescriptor[] = []

  constructor(
    private readonly behaviour: {
      readonly bytes?: Uint8Array
      /** Thrown as a driver refusal — the shape the agent recognises as an answer, not a failure. */
      readonly refuseCapture?: string
      readonly proof?: OpeningProof
      readonly placedPath?: string
    } = {},
  ) {}

  async capture(cut: QuiescentCut): Promise<CapturedSave> {
    this.captured.push(cut)
    if (this.behaviour.refuseCapture !== undefined) {
      throw Object.assign(new Error(this.behaviour.refuseCapture), { code: 'capture_refused', reason: this.behaviour.refuseCapture })
    }
    const bytes = this.behaviour.bytes ?? new TextEncoder().encode('captured')
    return {
      bytes,
      checksum: checksumOf(bytes),
      formatId: this.formatId,
      formatVersion: this.formatVersion,
      frontierW: 0,
      nativeOrigin: { podUid: cut.podUid, processGeneration: cut.processGeneration, contextId: cut.contextId },
      workspaceDeps: {},
    }
  }

  async restore(bytes: Uint8Array): Promise<RestorePlacement> {
    this.restored.push(bytes)
    // A real digest of what it was handed: a driver that reported a constant would let a test pass
    // where the real verification (report against Save metadata) would have failed.
    return { path: this.behaviour.placedPath ?? '/fake/placed.jsonl', byteLength: bytes.byteLength, checksum: checksumOf(bytes) }
  }

  async proveOpening(descriptor: OpeningDescriptor): Promise<OpeningProof> {
    this.proved.push(descriptor)
    return this.behaviour.proof ?? { kind: 'unprovable', reason: 'the fake driver proves nothing' }
  }
}
