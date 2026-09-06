// The control plane's side of a capture (S9 Step 3). It asks runtime-control to ask the Pod, then
// waits for the answer within the shutdown's remaining budget — and the ONLY thing it ever receives
// is the driver's metadata. The bytes stay on runtime-control's side of the wire from the moment the
// Pod posts them to the moment they are written under a committed Save id (ADR 0008: core never
// reads Save bytes; here that is a property of the transport, not a rule anyone has to remember).
import type { CaptureAttempt, CaptureSource } from './verbs/turn-off.js'

export interface RuntimeControlCaptureOptions {
  readonly runtimeControlBaseUrl: string
  /** How often to ask whether the Pod has answered. The Pod's own poll sets the floor here. */
  readonly pollIntervalMs?: number
  readonly logger?: (message: string) => void
}

interface OutcomeBody {
  readonly kind: 'captured' | 'refused' | 'pending' | 'none'
  readonly reason?: string
  readonly capture?: {
    readonly stagingId: string
    readonly checksum: string
    readonly byteLength: number
    readonly formatId: string
    readonly formatVersion: number
    readonly driverRevision: string
    readonly frontierW: number
    readonly nativeOrigin: unknown
    readonly workspaceDeps: unknown
    readonly contextId: string
    readonly processGeneration: number
  }
}

/**
 * The Pod's name comes from runtime-control's own inventory, never from re-deriving the naming rule
 * here. That rule already produced one silent mismatch in S8 when two call sites disagreed about how
 * an incarnation is shortened; asking the owner what its Pod is called cannot drift.
 */
async function podNameFor(baseUrl: string, workstreamId: string, incarnation: string): Promise<string | undefined> {
  const response = await fetch(`${baseUrl}/v1/workstreams/${workstreamId}`)
  if (!response.ok) return undefined
  const inventory = (await response.json()) as { pods: readonly { name: string; incarnation: string | null }[] }
  return inventory.pods.find((pod) => pod.incarnation === incarnation)?.name
}

export function createRuntimeControlCaptureSource(options: RuntimeControlCaptureOptions): CaptureSource {
  const pollIntervalMs = options.pollIntervalMs ?? 500
  const log = options.logger ?? (() => {})

  return {
    async attemptCapture(request): Promise<CaptureAttempt> {
      const podName = await podNameFor(options.runtimeControlBaseUrl, request.workstreamId, request.incarnation)
      if (podName === undefined) return { kind: 'unavailable', reason: `no Pod for incarnation ${request.incarnation} is in runtime-control's inventory` }
      const base = `${options.runtimeControlBaseUrl}/v1/pods/${podName}/custody`
      const asked = await fetch(`${base}/request-capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contextId: request.contextId, processGeneration: request.processGeneration }),
      })
      if (!asked.ok) return { kind: 'unavailable', reason: `runtime-control refused the capture request: HTTP ${String(asked.status)}` }

      // Waits out the budget and no longer. Returning `unavailable` at the deadline is what lets
      // TURN_OFF terminate on time with the loss recorded, instead of a hung capture holding a
      // shutdown open (OFF-001).
      const deadline = Date.now() + request.budgetMs
      for (;;) {
        const response = await fetch(`${base}/capture-outcome`)
        if (response.ok) {
          const outcome = (await response.json()) as OutcomeBody
          if (outcome.kind === 'refused') return { kind: 'refused', reason: outcome.reason ?? 'the driver refused the cut' }
          if (outcome.kind === 'none') return { kind: 'unavailable', reason: 'runtime-control holds no capture for this Pod' }
          // The driver revision comes from the driver itself. That is not the Pod asserting an
          // identity it could choose: the image is pinned by digest, so the revision is a property
          // of reviewed code, and it is what an invalidation later needs to name (CONT-008).
          if (outcome.kind === 'captured' && outcome.capture !== undefined) return { kind: 'captured', capture: outcome.capture }
        }
        if (Date.now() >= deadline) {
          log(`capture for ${request.incarnation} did not answer within its ${String(request.budgetMs)}ms budget`)
          return { kind: 'unavailable', reason: `the Pod did not answer within its ${String(request.budgetMs)}ms budget` }
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      }
    },

    async commitPayload(request): Promise<void> {
      const podName = await podNameFor(options.runtimeControlBaseUrl, request.workstreamId, request.incarnation)
      if (podName === undefined) throw new Error(`no Pod for incarnation ${request.incarnation} is in runtime-control's inventory`)
      const response = await fetch(`${options.runtimeControlBaseUrl}/v1/pods/${podName}/custody/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stagingId: request.stagingId, saveId: request.saveId }),
      })
      if (!response.ok) throw new Error(`committing the payload for Save ${request.saveId} failed: HTTP ${String(response.status)}`)
    },
  }
}
