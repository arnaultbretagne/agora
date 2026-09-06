// The harness-side custody agent (S9 Step 3). It polls the same evidence endpoint the launch seam
// already uses, and when the control plane asks for a capture it runs THIS harness's driver and
// posts the bytes back to runtime-control.
//
// Deliberately not on the bridge. Mixing custody into the ACP relay would put capture behind the
// same connection a shutdown is busy closing, and it would make the protocol surface responsible for
// something that is not protocol. Polling also keeps working while the Pod is being torn down and
// nothing can reach it inbound — which is exactly when a capture is asked for.
import { ClaudeCodeCustodyDriver, CustodyRefusedError } from './driver.js'

export interface CaptureRequest {
  readonly contextId: string
  readonly processGeneration: number
  readonly token: string
}

export interface CustodyAgentOptions {
  readonly evidenceUrl: string
  readonly custodyUrlBase: string
  readonly harnessHome: string
  readonly workspaceRoot: string
  readonly podUid: string
  readonly pollIntervalMs?: number
  readonly onLog?: (message: string) => void
}

interface CustodyEvidence {
  readonly custodyCapture?: CaptureRequest | null
}

/**
 * Answers one capture request. A refusal is reported as an ANSWER — the control plane is on a
 * shutdown budget and needs "the driver looked and could not take a quiescent cut" now, not a
 * silence it has to wait out (OFF-001).
 */
export async function answerCaptureRequest(options: CustodyAgentOptions, request: CaptureRequest): Promise<'captured' | 'refused'> {
  const driver = new ClaudeCodeCustodyDriver({ harnessHome: options.harnessHome, workspaceRoot: options.workspaceRoot })
  try {
    const captured = await driver.capture({
      podUid: options.podUid,
      processGeneration: request.processGeneration,
      contextId: request.contextId,
    })
    await post(options.custodyUrlBase, {
      'x-agora-capture-token': request.token,
      'x-agora-checksum': captured.checksum,
      'x-agora-format-id': captured.formatId,
      'x-agora-format-version': String(captured.formatVersion),
      'x-agora-driver-revision': driver.driverRevision,
      'x-agora-frontier-w': String(captured.frontierW),
      'x-agora-native-origin': JSON.stringify(captured.nativeOrigin ?? {}),
      'x-agora-workspace-deps': JSON.stringify(captured.workspaceDeps ?? {}),
    }, captured.bytes)
    return 'captured'
  } catch (error) {
    if (!(error instanceof CustodyRefusedError)) throw error
    await post(options.custodyUrlBase, { 'x-agora-capture-token': request.token, 'x-agora-refused': error.reason }, new Uint8Array())
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

  void (async () => {
    while (!stopped) {
      try {
        const response = await fetch(options.evidenceUrl)
        if (response.ok) {
          const evidence = (await response.json()) as CustodyEvidence
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
