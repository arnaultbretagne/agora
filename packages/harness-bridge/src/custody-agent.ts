// The harness-side custody agent (S9 Step 3, generalized in S10 Step 1). It polls the same evidence
// endpoint the launch seam already uses, and when the control plane asks for a capture, a placement
// or a proof it hands the work to THIS harness's driver and posts the result to runtime-control.
//
// The driver is injected. Everything here — the poll, the endpoints, the headers, the refusal
// semantics — is identical for every harness; what a capture IS differs entirely, and that is the
// only thing each harness supplies.
//
// Deliberately not on the bridge. Mixing custody into the ACP relay would put capture behind the
// same connection a shutdown is busy closing, and it would make the protocol surface responsible for
// something that is not protocol. Polling also keeps working while the Pod is being torn down and
// nothing can reach it inbound — which is exactly when a capture is asked for.
import type { CustodyDriver, OpeningDescriptor } from '@agora/custody'

/**
 * A refusal a driver raises when it looked and could not take a cut. It is an ANSWER, not an error:
 * the control plane is on a shutdown budget and needs to know now (OFF-001). A driver signals one by
 * throwing an error carrying this code — the class itself lives in each harness, because each has
 * its own reasons.
 */
export interface DriverRefusal {
  readonly code: 'capture_refused' | 'restore_refused'
  readonly reason: string
}

function refusalOf(error: unknown): DriverRefusal | null {
  const candidate = error as { code?: unknown; reason?: unknown }
  return (candidate?.code === 'capture_refused' || candidate?.code === 'restore_refused') && typeof candidate.reason === 'string'
    ? { code: candidate.code, reason: candidate.reason }
    : null
}

/** The offer runtime-control publishes when a Save is waiting to be placed for this Pod. */
export interface PlacementOffer {
  readonly saveId: string
  readonly checksum: string
  readonly byteLength: number
  readonly token: string
}

export interface CaptureRequest {
  readonly contextId: string
  readonly processGeneration: number
  readonly token: string
}

export interface CustodyAgentOptions {
  readonly evidenceUrl: string
  readonly custodyUrlBase: string
  /** This harness's own driver — the one thing that is not shared. */
  readonly driver: CustodyDriver
  readonly podUid: string
  readonly pollIntervalMs?: number
  readonly onLog?: (message: string) => void
}

/** A standing request to prove the live context incorporated an opening range (S9 Step 5). */
export interface ProofRequest {
  readonly contextId: string
  readonly processGeneration: number
  readonly w: number
  readonly h: number
  readonly handoffDigest: string | null
  readonly token: string
}

interface CustodyEvidence {
  readonly custody?: PlacementOffer | null
  readonly custodyCapture?: CaptureRequest | null
  readonly custodyProof?: ProofRequest | null
}

/**
 * Answers a standing proof request by asking THIS harness's driver, every time it is asked.
 * Deliberately not cached: continuity.md wants bounded current evidence, and a cached verdict is a
 * stored receipt — exactly what CONT-006 says never becomes live proof.
 */
export async function answerProofRequest(
  options: { readonly custodyUrlBase: string; readonly driver: CustodyDriver },
  request: ProofRequest,
): Promise<'incorporated' | 'not_incorporated' | 'unprovable'> {
  const proof = await options.driver.proveOpening({
    w: request.w,
    h: request.h,
    contextId: request.contextId,
    ...(request.handoffDigest !== null ? { handoffDigest: request.handoffDigest } : {}),
  } satisfies OpeningDescriptor)
  const response = await fetch(`${options.custodyUrlBase}/proof`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: request.token,
      verdict: proof.kind,
      reason: proof.kind === 'incorporated' ? undefined : proof.reason,
    }),
  })
  if (!response.ok) throw new Error(`posting the proof failed: HTTP ${String(response.status)}`)
  return proof.kind
}

/**
 * Fetches an offered Save and places it with this harness's driver, then reports what actually
 * landed on disk. Shared by the launch seam (a restore staged before the gate opens) and by the
 * custody agent (a restore staged by RESTORE after the Pod is already running) — one placement
 * path, so the two can never drift into placing things differently.
 */
export async function placeOfferedSave(
  options: { readonly custodyUrlBase: string; readonly driver: CustodyDriver },
  offer: PlacementOffer,
  log: (message: string) => void,
): Promise<void> {
  const payload = await fetch(`${options.custodyUrlBase}/payload?token=${encodeURIComponent(offer.token)}`)
  if (!payload.ok) throw new Error(`fetching Save ${offer.saveId} failed: HTTP ${String(payload.status)}`)
  const bytes = new Uint8Array(await payload.arrayBuffer())

  const placement = await options.driver.restore(bytes)
  log(`placed Save ${offer.saveId} at ${placement.path} (${String(placement.byteLength)} bytes)`)

  // The report carries what the driver measured on disk, not what the offer claimed: runtime-control
  // compares it against the Save metadata, and that comparison is what authorises the resume.
  const report = await fetch(`${options.custodyUrlBase}/placement`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: offer.token, checksum: placement.checksum, byteLength: placement.byteLength, path: placement.path }),
  })
  if (!report.ok) throw new Error(`placement report for Save ${offer.saveId} was refused: HTTP ${String(report.status)}`)
}

/**
 * Answers one capture request. A refusal is reported as an ANSWER — the control plane is on a
 * shutdown budget and needs "the driver looked and could not take a quiescent cut" now, not a
 * silence it has to wait out (OFF-001).
 */
export async function answerCaptureRequest(
  options: { readonly custodyUrlBase: string; readonly driver: CustodyDriver; readonly podUid: string },
  request: CaptureRequest,
): Promise<'captured' | 'refused'> {
  try {
    const captured = await options.driver.capture({
      podUid: options.podUid,
      processGeneration: request.processGeneration,
      contextId: request.contextId,
    })
    await post(options.custodyUrlBase, {
      'x-agora-capture-token': request.token,
      'x-agora-checksum': captured.checksum,
      'x-agora-format-id': captured.formatId,
      'x-agora-format-version': String(captured.formatVersion),
      'x-agora-driver-revision': options.driver.driverRevision,
      'x-agora-frontier-w': String(captured.frontierW),
      'x-agora-native-origin': JSON.stringify(captured.nativeOrigin ?? {}),
      'x-agora-workspace-deps': JSON.stringify(captured.workspaceDeps ?? {}),
    }, captured.bytes)
    return 'captured'
  } catch (error) {
    const refusal = refusalOf(error)
    if (refusal === null) throw error
    await post(options.custodyUrlBase, { 'x-agora-capture-token': request.token, 'x-agora-refused': refusal.reason }, new Uint8Array())
    return 'refused'
  }
}

async function post(base: string, headers: Record<string, string>, bytes: Uint8Array): Promise<void> {
  const response = await fetch(`${base}/capture`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    // A Buffer view: the DOM typings do not accept a bare Uint8Array as a body, and copying the
    // payload again just to satisfy them would double the memory of a 32 MiB capture.
    body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as unknown as BodyInit,
  })
  if (!response.ok) throw new Error(`posting the capture failed: HTTP ${String(response.status)}`)
}

/**
 * Polls for capture requests until stopped. Each request is answered exactly once — a request that
 * has already been answered stops being published, so the loop has nothing to de-duplicate beyond
 * not answering the same token twice while a slow capture is still running.
 */
export function startCustodyAgent(options: CustodyAgentOptions): { stop: () => void } {
  const log = options.onLog ?? (() => {})
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  let stopped = false
  let answering: string | null = null
  let placed: string | null = null

  void (async () => {
    while (!stopped) {
      try {
        const response = await fetch(options.evidenceUrl)
        if (response.ok) {
          const evidence = (await response.json()) as CustodyEvidence
          // A RESTORE staged after this Pod launched: the seam is long since open, so this loop is
          // the only thing that will place it. The adapter reads the transcript at `session/resume`,
          // not at launch, so placing it now is exactly as good as placing it before the gate.
          const offer = evidence.custody ?? null
          if (offer !== null && offer.saveId !== placed) {
            await placeOfferedSave(options, offer, log)
            placed = offer.saveId
          }
          const proof = evidence.custodyProof ?? null
          if (proof !== null) await answerProofRequest(options, proof)
          const request = evidence.custodyCapture ?? null
          if (request !== null && request.token !== answering) {
            answering = request.token
            const outcome = await answerCaptureRequest(options, request)
            log(`capture request for context ${request.contextId}: ${outcome}`)
          }
        }
      } catch (error) {
        log(`custody poll failed, retrying: ${error instanceof Error ? error.message : String(error)}`)
        answering = null
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  })()

  return {
    stop: () => {
      stopped = true
    },
  }
}
