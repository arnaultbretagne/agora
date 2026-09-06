// Custody transport (S9 Step 2 — ADR 0008, continuity.md). Runtime-control is the only component
// that touches Save bytes: it holds the payload-role connection, the Pod holds none. What crosses to
// the Pod is a byte stream over the owner API, and what comes back is a placement report the Pod's
// own driver produced. Runtime-control verifies that report against the Save metadata before the
// launch seam is ever released — a Pod must not start against a half-placed transcript.
//
// The transport deliberately knows nothing about transcripts, paths or formats: those are the
// harness driver's, and the driver runs inside the Pod. This module moves opaque bytes and checks a
// checksum, which is exactly the "core never reads Save bytes" line ADR 0008 draws.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

/** What the payload store hands back, abstracted so this module never owns a pool of its own. */
export type PayloadReader = (saveId: string) => Promise<Uint8Array | null>
/**
 * Where captured bytes are finally written, keyed by the Save the control plane committed. It takes
 * a Save id and not a staging id because `save_payloads` references `saves` — bytes cannot exist in
 * the store before the metadata that describes them, which is the right way round: a payload with no
 * Save is garbage a sweep can drop, a Save with no payload would be a promise nobody can keep.
 */
export type PayloadWriter = (saveId: string, bytes: Uint8Array) => Promise<void>

export interface PlacementCommand {
  readonly podName: string
  readonly saveId: string
  /** From the Save metadata, under the metadata role — never recomputed from the bytes we serve. */
  readonly checksum: string
  readonly byteLength: number
}

export interface PlacementReport {
  readonly token: string
  readonly checksum: string
  readonly byteLength: number
  /** Where the driver says it placed the file; recorded as diagnostics, never trusted as a path to act on. */
  readonly path: string
}

export type PlacementStatus = 'none' | 'staged' | 'placed' | 'rejected'

export interface Placement {
  readonly podName: string
  readonly saveId: string
  readonly checksum: string
  readonly byteLength: number
  readonly status: Exclude<PlacementStatus, 'none'>
  /** Set once the placement is rejected; the reason a gate release will keep refusing. */
  readonly rejection: string | null
  readonly path: string | null
}

/** What the Pod is told over the evidence endpoint so it can fetch and place before the gate opens. */
export interface PlacementOffer {
  readonly saveId: string
  readonly checksum: string
  readonly byteLength: number
  readonly token: string
}

export type ConfirmOutcome =
  | { readonly kind: 'placed'; readonly placement: Placement }
  | { readonly kind: 'rejected'; readonly reason: string }

export type FetchOutcome =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly saveId: string }
  | { readonly kind: 'no_placement' }
  | { readonly kind: 'unauthorized' }
  /** The metadata names a Save whose bytes are not in the store: an outage, not an incompatibility
   * — it invalidates nothing (CONT-008), it just leaves the gate shut. */
  | { readonly kind: 'payload_missing'; readonly saveId: string }

/**
 * A placement token, bound to the exact (Pod, Save) pair and signed with the same secret the bridge
 * token uses. It exists because the bridge token cannot: that one is minted at gate release, and
 * placement happens strictly before. It authorises one thing — reading these bytes for this Pod —
 * and it stops being useful the moment the placement is confirmed or discarded.
 */
export function mintPlacementToken(podName: string, saveId: string, secret: string): string {
  return createHmac('sha256', secret).update(`custody:${podName}:${saveId}`).digest('hex')
}

function checksumOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

interface MutablePlacement {
  podName: string
  saveId: string
  checksum: string
  byteLength: number
  status: Exclude<PlacementStatus, 'none'>
  rejection: string | null
  path: string | null
  token: string
}

/** A capture the control plane asked for, and that the Pod's own driver has not answered yet. */
export interface CaptureRequest {
  readonly podName: string
  readonly contextId: string
  readonly processGeneration: number
  readonly token: string
}

/** What the Pod's driver reports back — the driver's own metadata, plus the bytes it captured. */
export interface CaptureReport {
  readonly token: string
  readonly checksum: string
  readonly formatId: string
  readonly formatVersion: number
  readonly driverRevision: string
  readonly frontierW: number
  readonly nativeOrigin: unknown
  readonly workspaceDeps: unknown
  /** Set instead of the metadata when the driver refused the cut; never an outage. */
  readonly refusedReason?: string
}

export type CaptureOutcome =
  | { readonly kind: 'captured'; readonly capture: CapturedBytes }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'none' }

export interface CapturedBytes {
  readonly podName: string
  readonly contextId: string
  readonly processGeneration: number
  readonly stagingId: string
  readonly checksum: string
  readonly byteLength: number
  readonly formatId: string
  readonly formatVersion: number
  readonly driverRevision: string
  readonly frontierW: number
  readonly nativeOrigin: unknown
  readonly workspaceDeps: unknown
}

interface MutableCapture {
  request: CaptureRequest
  result: CaptureOutcome
  /**
   * The captured bytes, held here until the control plane commits a Save for them. Memory, not a
   * staging table, because the whole window is one shutdown budget and one payload per Pod: if this
   * process dies inside it, the capture is simply lost and the shutdown records that loss, which is
   * exactly what it would have to do for any other unfinished capture.
   */
  bytes: Uint8Array | null
}

export interface CustodyTransportOptions {
  readonly readPayload: PayloadReader
  /** Absent where no capture is served (a runtime-control that only restores). */
  readonly writePayload?: PayloadWriter
  /** The same BRIDGE_AUTH_SECRET the Pod already holds; no second secret to distribute. */
  readonly secret: string
  /** Test seam for the staging id a capture's bytes are written under. */
  readonly newStagingId?: () => string
}

/**
 * A standing request for the Pod's driver to prove that its live native context incorporated an
 * opening range. Unlike a capture, this is NOT answered once: continuity.md requires *bounded
 * current* evidence, so the Pod re-answers it on every poll and the verdict carries the time it was
 * taken. A verdict older than the reader's own freshness bound is not evidence.
 */
export interface ProofRequest {
  readonly podName: string
  readonly contextId: string
  readonly processGeneration: number
  readonly w: number
  readonly h: number
  readonly handoffDigest: string | null
  readonly token: string
}

export type ProofVerdict = 'incorporated' | 'not_incorporated' | 'unprovable'

export interface ProofReport {
  readonly token: string
  readonly verdict: ProofVerdict
  readonly reason?: string
}

interface MutableProof {
  request: ProofRequest
  verdict: ProofVerdict | null
  reason: string | null
  takenAtMs: number
}

/** A capture token: same secret, different purpose string, so a placement token can never fetch a capture and back. */
export function mintCaptureToken(podName: string, contextId: string, processGeneration: number, secret: string): string {
  return createHmac('sha256', secret).update(`custody-capture:${podName}:${contextId}:${String(processGeneration)}`).digest('hex')
}

export function mintProofToken(podName: string, contextId: string, digest: string | null, secret: string): string {
  return createHmac('sha256', secret).update(`custody-proof:${podName}:${contextId}:${digest ?? 'none'}`).digest('hex')
}

export class CustodyTransport {
  readonly #placements = new Map<string, MutablePlacement>()
  readonly #captures = new Map<string, MutableCapture>()
  readonly #proofs = new Map<string, MutableProof>()
  readonly #options: CustodyTransportOptions

  constructor(options: CustodyTransportOptions) {
    this.#options = options
  }

  /**
   * Stages a placement for a Pod that has not launched yet. Idempotent for the same (Pod, Save):
   * a repeated stage returns the same offer and, crucially, does NOT reset a placement that already
   * verified — RESTORE retrying after a crash must not reopen a finished placement.
   *
   * Staging a DIFFERENT Save over an unfinished placement is how a partial placement is cleaned:
   * the previous attempt's bytes are abandoned wholesale (the driver's staging file is its own to
   * overwrite) rather than merged with the new one, because a mixture of two transcripts is not a
   * transcript. Restaging over a placement that already verified is refused instead — that decision
   * belongs to whoever ends the Session, not to a retry.
   */
  stage(command: PlacementCommand): PlacementOffer {
    const existing = this.#placements.get(command.podName)
    if (existing !== undefined && existing.saveId === command.saveId) {
      return { saveId: existing.saveId, checksum: existing.checksum, byteLength: existing.byteLength, token: existing.token }
    }
    if (existing !== undefined && existing.status === 'placed') {
      throw new Error(`pod ${command.podName} already has Save ${existing.saveId} placed; a different Save needs a new Pod`)
    }

    const token = mintPlacementToken(command.podName, command.saveId, this.#options.secret)
    this.#placements.set(command.podName, {
      podName: command.podName,
      saveId: command.saveId,
      checksum: command.checksum,
      byteLength: command.byteLength,
      status: 'staged',
      rejection: null,
      path: null,
      token,
    })
    return { saveId: command.saveId, checksum: command.checksum, byteLength: command.byteLength, token }
  }

  /** What the evidence endpoint publishes: the offer while it is still to be placed, else nothing. */
  offer(podName: string): PlacementOffer | null {
    const placement = this.#placements.get(podName)
    if (placement === undefined || placement.status === 'placed') return null
    return { saveId: placement.saveId, checksum: placement.checksum, byteLength: placement.byteLength, token: placement.token }
  }

  /** Streams the staged Save's bytes to the holder of the placement token, and to nobody else. */
  async fetch(podName: string, token: string): Promise<FetchOutcome> {
    const placement = this.#placements.get(podName)
    if (placement === undefined) return { kind: 'no_placement' }
    if (!tokenMatches(placement.token, token)) return { kind: 'unauthorized' }
    const bytes = await this.#options.readPayload(placement.saveId)
    if (bytes === null) return { kind: 'payload_missing', saveId: placement.saveId }
    return { kind: 'bytes', bytes, saveId: placement.saveId }
  }

  /**
   * Verifies the driver's placement report against the Save metadata. The checksum is the whole
   * point: the Pod computed it over what actually landed on its disk, and this side compares it to
   * what the Save says it should be. A mismatch leaves the placement REJECTED rather than deleting
   * it — the state is what keeps the gate shut, and clearing it silently would let the next gate
   * release succeed against a transcript nobody verified.
   */
  confirm(podName: string, report: PlacementReport): ConfirmOutcome {
    const placement = this.#placements.get(podName)
    if (placement === undefined) return { kind: 'rejected', reason: `no placement is staged for pod ${podName}` }
    if (!tokenMatches(placement.token, report.token)) return { kind: 'rejected', reason: 'the placement token does not match this Pod and Save' }

    if (report.checksum !== placement.checksum || report.byteLength !== placement.byteLength) {
      placement.status = 'rejected'
      placement.rejection = `placed ${String(report.byteLength)} bytes with checksum ${report.checksum}, the Save records ${String(placement.byteLength)} bytes with ${placement.checksum}`
      return { kind: 'rejected', reason: placement.rejection }
    }

    placement.status = 'placed'
    placement.rejection = null
    placement.path = report.path
    return { kind: 'placed', placement: { ...placement } }
  }

  /**
   * Abandons an unfinished placement, so the same attempt can restage without inheriting a partial
   * one. A verified placement is never discarded here: the bytes are already the Pod's native state,
   * and forgetting that fact would make the next gate release lie about what the Pod is resuming.
   */
  discard(podName: string): boolean {
    const placement = this.#placements.get(podName)
    if (placement === undefined || placement.status === 'placed') return false
    this.#placements.delete(podName)
    return true
  }

  status(podName: string): PlacementStatus {
    return this.#placements.get(podName)?.status ?? 'none'
  }

  placement(podName: string): Placement | null {
    const placement = this.#placements.get(podName)
    if (placement === undefined) return null
    const { token: _token, ...rest } = placement
    return rest
  }

  /**
   * Asks the Pod's own driver for a capture at this cut. Nothing is pushed: the Pod learns about it
   * on the endpoint it already polls, does the work with its own driver, and posts the bytes back.
   * That keeps custody out of the ACP bridge entirely, and it keeps working while the Pod is being
   * torn down and nothing can reach it inbound.
   *
   * Idempotent per (Pod, context, generation): asking again returns the same request, and asking
   * again after an answer returns the answer rather than restarting the capture. A capture keyed to
   * a DIFFERENT generation replaces a pending one — the old cut's process is gone, so its capture
   * can never complete (SESSION-A06).
   */
  requestCapture(request: Omit<CaptureRequest, 'token'>): CaptureRequest {
    const existing = this.#captures.get(request.podName)
    if (
      existing !== undefined &&
      existing.request.contextId === request.contextId &&
      existing.request.processGeneration === request.processGeneration
    ) {
      return existing.request
    }
    const full: CaptureRequest = { ...request, token: mintCaptureToken(request.podName, request.contextId, request.processGeneration, this.#options.secret) }
    this.#captures.set(request.podName, { request: full, result: { kind: 'pending' }, bytes: null })
    return full
  }

  /** What the Pod is told to capture, while it still owes an answer. */
  captureRequest(podName: string): CaptureRequest | null {
    const capture = this.#captures.get(podName)
    return capture === undefined || capture.result.kind !== 'pending' ? null : capture.request
  }

  /**
   * Records the driver's answer. A refusal is an ANSWER, not a failure of this transport: the driver
   * looked and could not take a quiescent cut, and the caller needs to know that within its budget
   * rather than waiting out the clock.
   */
  async submitCapture(podName: string, report: CaptureReport, bytes: Uint8Array): Promise<CaptureOutcome> {
    const capture = this.#captures.get(podName)
    if (capture === undefined) return { kind: 'none' }
    if (!tokenMatches(capture.request.token, report.token)) return { kind: 'refused', reason: 'the capture token does not match this Pod, context and generation' }

    if (typeof report.refusedReason === 'string') {
      capture.result = { kind: 'refused', reason: report.refusedReason }
      return capture.result
    }
    if (checksumOfBytes(bytes) !== report.checksum) {
      // The bytes and the driver's own metadata disagree: something went wrong in transit, and
      // storing either one would make the Save's checksum a lie.
      capture.result = { kind: 'refused', reason: 'the posted bytes do not match the checksum the driver reported' }
      return capture.result
    }
    if (this.#options.writePayload === undefined) {
      capture.result = { kind: 'refused', reason: 'this runtime-control serves no capture payload store' }
      return capture.result
    }

    const stagingId = (this.#options.newStagingId ?? randomUUID)()
    capture.bytes = bytes
    capture.result = {
      kind: 'captured',
      capture: {
        podName,
        contextId: capture.request.contextId,
        processGeneration: capture.request.processGeneration,
        stagingId,
        checksum: report.checksum,
        byteLength: bytes.byteLength,
        formatId: report.formatId,
        formatVersion: report.formatVersion,
        driverRevision: report.driverRevision,
        frontierW: report.frontierW,
        nativeOrigin: report.nativeOrigin,
        workspaceDeps: report.workspaceDeps,
      },
    }
    return capture.result
  }

  /** The answer so far: `pending` until the Pod reports, and the caller's own budget decides how long that is worth waiting for. */
  captureOutcome(podName: string): CaptureOutcome {
    return this.#captures.get(podName)?.result ?? { kind: 'none' }
  }

  /**
   * Writes the staged bytes under the Save the control plane just committed, then forgets them.
   * Idempotent through the store's own `ON CONFLICT DO NOTHING`: a retried commit for the same Save
   * writes nothing new, and a commit for a capture this process no longer holds says so rather than
   * pretending the bytes are safe.
   */
  async commitCapture(podName: string, stagingId: string, saveId: string): Promise<'committed' | 'no_capture'> {
    const capture = this.#captures.get(podName)
    if (capture === undefined || capture.result.kind !== 'captured' || capture.bytes === null) return 'no_capture'
    if (capture.result.capture.stagingId !== stagingId) return 'no_capture'
    if (this.#options.writePayload === undefined) return 'no_capture'
    await this.#options.writePayload(saveId, capture.bytes)
    this.#captures.delete(podName)
    return 'committed'
  }

  /** Forgets a capture the control plane has given up on. */
  discardCapture(podName: string): boolean {
    return this.#captures.delete(podName)
  }

  /**
   * Stands up (or refreshes) the proof request for this Pod. Asking for a DIFFERENT descriptor
   * replaces the standing one and discards its verdict: a verdict about another range is not
   * weaker evidence about this one, it is evidence about something else.
   */
  requestProof(request: Omit<ProofRequest, 'token'>, nowMs = Date.now()): ProofRequest {
    const existing = this.#proofs.get(request.podName)
    if (
      existing !== undefined &&
      existing.request.contextId === request.contextId &&
      existing.request.processGeneration === request.processGeneration &&
      existing.request.handoffDigest === request.handoffDigest &&
      existing.request.w === request.w &&
      existing.request.h === request.h
    ) {
      return existing.request
    }
    const full: ProofRequest = { ...request, token: mintProofToken(request.podName, request.contextId, request.handoffDigest, this.#options.secret) }
    this.#proofs.set(request.podName, { request: full, verdict: null, reason: null, takenAtMs: nowMs })
    return full
  }

  /** What the Pod is asked to prove, published on the evidence endpoint it already polls. */
  proofRequest(podName: string): ProofRequest | null {
    return this.#proofs.get(podName)?.request ?? null
  }

  submitProof(podName: string, report: ProofReport, nowMs = Date.now()): 'recorded' | 'unauthorized' | 'no_request' {
    const proof = this.#proofs.get(podName)
    if (proof === undefined) return 'no_request'
    if (!tokenMatches(proof.request.token, report.token)) return 'unauthorized'
    proof.verdict = report.verdict
    proof.reason = report.reason ?? null
    proof.takenAtMs = nowMs
    return 'recorded'
  }

  /**
   * The verdict, if one was taken recently enough and about exactly this descriptor. Returns null
   * otherwise — an absent or stale verdict is "cannot tell", never "not incorporated".
   */
  proofOutcome(
    podName: string,
    descriptor: { readonly contextId: string; readonly handoffDigest: string | null; readonly maxAgeMs: number },
    nowMs = Date.now(),
  ): { readonly verdict: ProofVerdict; readonly reason: string | null } | null {
    const proof = this.#proofs.get(podName)
    if (proof === undefined || proof.verdict === null) return null
    if (proof.request.contextId !== descriptor.contextId || proof.request.handoffDigest !== descriptor.handoffDigest) return null
    if (nowMs - proof.takenAtMs > descriptor.maxAgeMs) return null
    return { verdict: proof.verdict, reason: proof.reason }
  }

  /**
   * Whether the launch seam may be released. A Pod with no placement is the ordinary START case and
   * is free to go; a Pod whose placement is staged or rejected is not, because releasing the gate
   * would let the adapter open a context that either has no restored transcript or has an unverified
   * one — and both of those would then be indistinguishable from a genuine resume.
   */
  gateBlockedReason(podName: string): string | null {
    const placement = this.#placements.get(podName)
    if (placement === undefined || placement.status === 'placed') return null
    if (placement.status === 'rejected') return `the restore placement for Save ${placement.saveId} was rejected: ${placement.rejection ?? 'unknown reason'}`
    return `the restore placement for Save ${placement.saveId} has not been verified yet`
  }
}
