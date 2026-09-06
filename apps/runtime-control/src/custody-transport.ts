// Custody transport (S9 Step 2 — ADR 0008, continuity.md). Runtime-control is the only component
// that touches Save bytes: it holds the payload-role connection, the Pod holds none. What crosses to
// the Pod is a byte stream over the owner API, and what comes back is a placement report the Pod's
// own driver produced. Runtime-control verifies that report against the Save metadata before the
// launch seam is ever released — a Pod must not start against a half-placed transcript.
//
// The transport deliberately knows nothing about transcripts, paths or formats: those are the
// harness driver's, and the driver runs inside the Pod. This module moves opaque bytes and checks a
// checksum, which is exactly the "core never reads Save bytes" line ADR 0008 draws.
import { createHmac, timingSafeEqual } from 'node:crypto'

/** What the payload store hands back, abstracted so this module never owns a pool of its own. */
export type PayloadReader = (saveId: string) => Promise<Uint8Array | null>

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

export interface CustodyTransportOptions {
  readonly readPayload: PayloadReader
  /** The same BRIDGE_AUTH_SECRET the Pod already holds; no second secret to distribute. */
  readonly secret: string
}

export class CustodyTransport {
  readonly #placements = new Map<string, MutablePlacement>()
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
