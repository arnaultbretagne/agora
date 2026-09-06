// Runtime-control owner API (S6): inventory, owner requests, evidence, wakes. Every mutation runs
// the shared owner request protocol gate (packages/owner-requests, findings §P5) before touching
// Kubernetes: a stale epoch or a reused attempt key with a different payload never reaches the
// cluster; a reused key with the same payload replays the recorded response. Problem+JSON errors
// carry the Kubernetes Status.message in the detail (findings §4).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { payloadDigest, type OwnerRequest, type OwnerResponse } from '@agora/owner-requests'
import type { K8sClient, HttpError } from './k8s-client.js'
import { distinctLiveWorkstreamIds, inventoryWorkstream, isStartupDeadlineExpired } from './inventory.js'
import type { RuntimeObligationStore } from './retirement.js'
import { LaunchSeam } from './launch-seam.js'
import type { OwnerGate } from '@agora/owner-requests'
import { buildPodSpec, type HarnessDefinition, type RuntimeSettings } from './k8s-pod-spec.js'
import { podName } from './k8s-labels.js'
import { WakeLog, readWakes } from './wakes.js'
import { mintBridgeToken } from '@agora/acp'
import type { CustodyTransport, PlacementReport } from './custody-transport.js'

export interface OwnerApiOptions {
  readonly k8s: K8sClient
  readonly obligations: RuntimeObligationStore
  readonly seams: Map<string, LaunchSeam>
  readonly gate: OwnerGate
  readonly harnesses: readonly HarnessDefinition[]
  readonly settings: RuntimeSettings
  readonly wakes: WakeLog
  /** P4: signs the bridge token minted at gate release — the same secret every harness Pod verifies against. */
  readonly bridgeAuthSecret: string
  /** S9: present only where restores are served; absent, every Pod launches with no placement and the gate behaves exactly as it did in S8. */
  readonly custody?: CustodyTransport
}

function problem(res: ServerResponse, status: number, title: string, detail: string): void {
  res.writeHead(status, { 'content-type': 'application/problem+json' })
  res.end(JSON.stringify({ type: 'about:blank', title, status, detail }))
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createOwnerApi(options: OwnerApiOptions): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const parts = url.pathname.split('/').filter((p) => p.length > 0)

      if (parts[0] === 'v1' && parts[1] === 'workstreams' && parts.length === 3 && req.method === 'GET') {
        const inventory = await inventoryWorkstream(options.k8s, options.obligations, parts[2]!)
        return send(res, 200, inventory)
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 4 && parts[3] === 'evidence' && req.method === 'GET') {
        return handleEvidence(options, res, parts[2]!)
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 4 && parts[3] === 'fence' && req.method === 'POST') {
        // Operator-declared physical fencing (P6): the node has been drained and cordoned by a
        // human, not detected — this is the one discharge path this owner never infers on its own.
        const discharged = await options.obligations.discharge(parts[2]!, 'fenced')
        if (!discharged) return problem(res, 404, 'Not found', `no outstanding retirement obligation for pod ${parts[2]}`)
        return send(res, 200, { fenced: parts[2] })
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 5 && parts[3] === 'custody' && parts[4] === 'payload' && req.method === 'GET') {
        return handleCustodyPayload(options, req, res, parts[2]!)
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 5 && parts[3] === 'custody' && parts[4] === 'placement' && req.method === 'POST') {
        return handleCustodyPlacement(options, res, parts[2]!, (await body(req)) as PlacementReport)
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 5 && parts[3] === 'custody' && parts[4] === 'stage' && req.method === 'POST') {
        // RESTORE asks for a placement. It passes the Save's OWN checksum and byte length, read
        // under the metadata role it holds and this transport does not — which is what makes the
        // later verification a comparison between two independent sources rather than an echo.
        if (options.custody === undefined) return problem(res, 404, 'Not found', 'this runtime-control serves no custody placements')
        const ask = (await body(req)) as { saveId?: unknown; checksum?: unknown; byteLength?: unknown }
        if (typeof ask?.saveId !== 'string' || typeof ask.checksum !== 'string' || typeof ask.byteLength !== 'number') {
          return problem(res, 422, 'Invalid stage request', 'save_id, checksum and byte_length are required')
        }
        try {
          options.custody.stage({ podName: parts[2]!, saveId: ask.saveId, checksum: ask.checksum, byteLength: ask.byteLength })
        } catch (error) {
          return problem(res, 409, 'Placement conflict', error instanceof Error ? error.message : String(error))
        }
        return send(res, 202, { staged: true })
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 5 && parts[3] === 'custody' && parts[4] === 'placement-status' && req.method === 'GET') {
        if (options.custody === undefined) return problem(res, 404, 'Not found', 'this runtime-control serves no custody placements')
        return send(res, 200, { status: options.custody.status(parts[2]!), placement: options.custody.placement(parts[2]!) })
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 5 && parts[3] === 'custody' && parts[4] === 'request-proof' && req.method === 'POST') {
        if (options.custody === undefined) return problem(res, 404, 'Not found', 'this runtime-control serves no custody proofs')
        const ask = (await body(req)) as { contextId?: unknown; processGeneration?: unknown; w?: unknown; h?: unknown; handoffDigest?: unknown }
        if (typeof ask?.contextId !== 'string' || typeof ask.processGeneration !== 'number' || typeof ask.w !== 'number' || typeof ask.h !== 'number') {
          return problem(res, 422, 'Invalid proof request', 'context_id, process_generation, w and h are required')
        }
        options.custody.requestProof({
          podName: parts[2]!,
          contextId: ask.contextId,
          processGeneration: ask.processGeneration,
          w: ask.w,
          h: ask.h,
          handoffDigest: typeof ask.handoffDigest === 'string' ? ask.handoffDigest : null,
        })
        return send(res, 202, { requested: true })
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 5 && parts[3] === 'custody' && parts[4] === 'proof' && req.method === 'POST') {
        if (options.custody === undefined) return problem(res, 404, 'Not found', 'this runtime-control serves no custody proofs')
        const report = (await body(req)) as { token?: unknown; verdict?: unknown; reason?: unknown }
        if (typeof report?.token !== 'string' || (report.verdict !== 'incorporated' && report.verdict !== 'not_incorporated' && report.verdict !== 'unprovable')) {
          return problem(res, 422, 'Invalid proof report', 'token and a verdict of incorporated|not_incorporated|unprovable are required')
        }
        const outcome = options.custody.submitProof(parts[2]!, {
          token: report.token,
          verdict: report.verdict,
          ...(typeof report.reason === 'string' ? { reason: report.reason } : {}),
        })
        if (outcome === 'unauthorized') return problem(res, 403, 'Forbidden', 'the proof token does not match this Pod and descriptor')
        if (outcome === 'no_request') return problem(res, 404, 'Not found', `no proof was requested for pod ${parts[2]}`)
        return send(res, 200, { recorded: true })
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 5 && parts[3] === 'custody' && parts[4] === 'proof-outcome' && req.method === 'GET') {
        if (options.custody === undefined) return problem(res, 404, 'Not found', 'this runtime-control serves no custody proofs')
        const contextId = url.searchParams.get('contextId') ?? ''
        const digestParam = url.searchParams.get('handoffDigest')
        const maxAgeMs = Number(url.searchParams.get('maxAgeMs') ?? '5000')
        return send(res, 200, options.custody.proofOutcome(parts[2]!, { contextId, handoffDigest: digestParam, maxAgeMs }))
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 5 && parts[3] === 'custody' && parts[4] === 'capture' && req.method === 'POST') {
        return handleCustodyCapture(options, req, res, parts[2]!)
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 5 && parts[3] === 'custody' && parts[4] === 'request-capture' && req.method === 'POST') {
        // The control plane asks; it never receives bytes. What comes back is the request the Pod
        // will be told about on its own poll, and later the driver's metadata — never the payload.
        if (options.custody === undefined) return problem(res, 404, 'Not found', 'this runtime-control serves no custody captures')
        const ask = (await body(req)) as { contextId?: unknown; processGeneration?: unknown }
        if (typeof ask?.contextId !== 'string' || typeof ask.processGeneration !== 'number') {
          return problem(res, 422, 'Invalid capture request', 'context_id and process_generation are required')
        }
        options.custody.requestCapture({ podName: parts[2]!, contextId: ask.contextId, processGeneration: ask.processGeneration })
        return send(res, 202, { requested: true })
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 5 && parts[3] === 'custody' && parts[4] === 'capture-outcome' && req.method === 'GET') {
        if (options.custody === undefined) return problem(res, 404, 'Not found', 'this runtime-control serves no custody captures')
        return send(res, 200, options.custody.captureOutcome(parts[2]!))
      }

      if (parts[0] === 'v1' && parts[1] === 'pods' && parts.length === 5 && parts[3] === 'custody' && parts[4] === 'commit' && req.method === 'POST') {
        if (options.custody === undefined) return problem(res, 404, 'Not found', 'this runtime-control serves no custody captures')
        const commit = (await body(req)) as { stagingId?: unknown; saveId?: unknown }
        if (typeof commit?.stagingId !== 'string' || typeof commit.saveId !== 'string') {
          return problem(res, 422, 'Invalid commit', 'staging_id and save_id are required')
        }
        const outcome = await options.custody.commitCapture(parts[2]!, commit.stagingId, commit.saveId)
        if (outcome === 'no_capture') return problem(res, 409, 'No staged capture', `no staged capture ${commit.stagingId} is held for pod ${parts[2]}`)
        return send(res, 200, { committed: true })
      }

      if (parts[0] === 'v1' && parts[1] === 'wakes' && req.method === 'GET') {
        const response = await readWakes(options.wakes, url.searchParams.get('cursor'), () => distinctLiveWorkstreamIds(options.k8s))
        return send(res, 200, response)
      }

      if (parts[0] === 'v1' && parts[1] === 'owner-requests' && req.method === 'POST') {
        return handleOwnerRequest(options, res, (await body(req)) as OwnerRequest)
      }

      return problem(res, 404, 'Not found', `no resource at ${url.pathname}`)
    })().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) problem(res, 500, 'Internal error', detail)
      else res.destroy()
    })
  })
}

async function handleEvidence(options: OwnerApiOptions, res: ServerResponse, name: string): Promise<void> {
  const pod = await options.k8s.getPod(name)
  if (pod === undefined) return problem(res, 404, 'Not found', `pod ${name} is gone`)
  const metadata = pod['metadata'] as { uid?: string; creationTimestamp?: string } | undefined
  const status = pod['status'] as { phase?: string; containerStatuses?: readonly { imageID?: string; restartCount?: number }[] } | undefined
  const spec = pod['spec'] as { containers?: readonly { image?: string }[] } | undefined
  const seam = options.seams.get(name)
  // The seam is the one place a process restart is actually observed (LaunchSeam.processRestart) —
  // a Pod with no seam yet (evidence read before create_pod's ensureSeam) is generation 0, not
  // unknown. The kubelet's own restartCount is the real signal: catch the seam up to it here, on
  // every evidence read, rather than trusting a separate poller never to miss one (SESSION-A06).
  const liveRestartCount = status?.containerStatuses?.[0]?.restartCount ?? 0
  if (seam !== undefined) {
    while (seam.state().processGeneration < liveRestartCount) seam.processRestart()
  }
  return send(res, 200, {
    uid: metadata?.uid ?? null,
    imageId: status?.containerStatuses?.[0]?.imageID ?? null,
    admittedDigest: spec?.containers?.[0]?.image ?? null,
    processGeneration: seam?.state().processGeneration ?? 0,
    startupDeadlineExpired: isStartupDeadlineExpired(metadata?.creationTimestamp ?? null, status?.phase ?? 'Unknown', new Date().toISOString(), options.settings.startupDeadlineSeconds),
    seam: seam?.state() ?? null,
    // S9: the Pod learns here that a Save is waiting for it, on the endpoint it already polls while
    // held at the seam. The offer carries no bytes — only what it takes to fetch and verify them.
    custody: options.custody?.offer(name) ?? null,
    // And, at shutdown, what the control plane is asking this Pod's own driver to capture. It
    // arrives on the same poll: nothing is pushed into a Pod that may be moments from termination.
    custodyCapture: options.custody?.captureRequest(name) ?? null,
    // And the standing proof request, re-answered on every poll: continuity.md wants bounded
    // CURRENT evidence, so a verdict is only worth what its age says it is.
    custodyProof: options.custody?.proofRequest(name) ?? null,
  })
}

/**
 * Takes the driver's captured bytes. The body is the raw payload; the driver's own metadata rides in
 * headers so the bytes never have to be re-encoded into JSON — and so this side can stream them into
 * the payload store without parsing anything it is not supposed to read.
 */
async function handleCustodyCapture(options: OwnerApiOptions, req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  if (options.custody === undefined) return problem(res, 404, 'Not found', 'this runtime-control serves no custody captures')
  const header = (key: string): string => (Array.isArray(req.headers[key]) ? (req.headers[key] as string[])[0] ?? '' : (req.headers[key] as string | undefined) ?? '')
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const refusedReason = header('x-agora-refused')

  const report = {
    token: header('x-agora-capture-token'),
    checksum: header('x-agora-checksum'),
    formatId: header('x-agora-format-id'),
    formatVersion: Number(header('x-agora-format-version')),
    driverRevision: header('x-agora-driver-revision'),
    frontierW: Number(header('x-agora-frontier-w')),
    nativeOrigin: parseJsonHeader(header('x-agora-native-origin')),
    workspaceDeps: parseJsonHeader(header('x-agora-workspace-deps')),
    ...(refusedReason.length > 0 ? { refusedReason } : {}),
  }
  const outcome = await options.custody.submitCapture(name, report, new Uint8Array(Buffer.concat(chunks)))
  switch (outcome.kind) {
    case 'captured':
      return send(res, 200, { captured: true, byteLength: outcome.capture.byteLength })
    case 'refused':
      // The driver looked and could not take a quiescent cut. That is an answer, not an error on
      // this side: recording it is what lets TURN_OFF stop waiting and terminate on time.
      return send(res, 200, { captured: false, reason: outcome.reason })
    case 'none':
      return problem(res, 404, 'Not found', `no capture was requested for pod ${name}`)
    case 'pending':
      return problem(res, 500, 'Internal error', 'the capture is still pending after its own submission')
  }
}

function parseJsonHeader(value: string): unknown {
  if (value.length === 0) return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

/** Streams the staged Save's bytes to the Pod holding the placement token. The store stays on this side. */
async function handleCustodyPayload(options: OwnerApiOptions, req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  if (options.custody === undefined) return problem(res, 404, 'Not found', 'this runtime-control serves no custody placements')
  const url = new URL(req.url ?? '/', 'http://localhost')
  const outcome = await options.custody.fetch(name, url.searchParams.get('token') ?? '')
  switch (outcome.kind) {
    case 'bytes':
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(outcome.bytes.byteLength) })
      return void res.end(Buffer.from(outcome.bytes))
    case 'no_placement':
      return problem(res, 404, 'Not found', `no custody placement is staged for pod ${name}`)
    case 'unauthorized':
      return problem(res, 403, 'Forbidden', 'the placement token does not match this Pod and Save')
    case 'payload_missing':
      // An outage, not an incompatibility: nothing is invalidated, and the gate simply stays shut.
      return problem(res, 503, 'Payload unavailable', `the payload for Save ${outcome.saveId} could not be read`)
  }
}

/** Records the driver's placement report and verifies it against the Save metadata. */
function handleCustodyPlacement(options: OwnerApiOptions, res: ServerResponse, name: string, report: PlacementReport): void {
  if (options.custody === undefined) return problem(res, 404, 'Not found', 'this runtime-control serves no custody placements')
  if (typeof report?.token !== 'string' || typeof report.checksum !== 'string' || typeof report.byteLength !== 'number') {
    return problem(res, 422, 'Invalid placement report', 'token, checksum and byte_length are required')
  }
  const outcome = options.custody.confirm(name, report)
  if (outcome.kind === 'rejected') return problem(res, 409, 'Placement rejected', outcome.reason)
  return send(res, 200, { placed: true, saveId: outcome.placement.saveId })
}

async function handleOwnerRequest(options: OwnerApiOptions, res: ServerResponse, request: OwnerRequest): Promise<void> {
  if (typeof request.operation !== 'string' || typeof request.attemptKey !== 'string' || request.target === undefined) {
    return problem(res, 422, 'Invalid owner request', 'operation, attempt_key and target are required')
  }

  const decision = await options.gate.decide(request)
  if (decision.kind === 'respond') return send(res, 200, decision.response)

  let response: OwnerResponse
  switch (request.operation) {
    case 'create_pod':
      response = await createPod(options, request)
      break
    case 'cleanup_pod':
      response = await cleanupPod(options, request)
      break
    case 'gate_release':
      response = gateRelease(options, request)
      break
    default:
      return problem(res, 422, 'Unknown operation', `operation "${request.operation}" is not a runtime-control operation`)
  }

  await options.gate.record(request, response)
  return send(res, 200, response)
}

async function createPod(options: OwnerApiOptions, request: OwnerRequest): Promise<OwnerResponse> {
  if (request.target.kind !== 'reserved') {
    return { kind: 'unknown', detail: 'create_pod targets a reserved slot, not a concrete Pod' }
  }
  const harnessId = (request.payload as { harnessId?: unknown }).harnessId
  const harness = options.harnesses.find((h) => h.harnessId === harnessId)
  if (typeof harnessId !== 'string' || harness === undefined) {
    return { kind: 'unknown', detail: `harnessId "${String(harnessId)}" is not in the reviewed catalogue` }
  }
  const name = podName(request.workstreamId, request.target.id)
  const spec = buildPodSpec({ workstreamId: request.workstreamId, attemptKey: request.attemptKey, incarnation: request.target.id, harnessId }, harness, options.settings)
  try {
    const created = await options.k8s.createPod(spec)
    const uid = (created['metadata'] as { uid?: string } | undefined)?.uid ?? null
    ensureSeam(options, name, request.target.id)
    return { kind: 'completed', result: { podName: name, podUid: uid } }
  } catch (error) {
    if ((error as HttpError).status === 409) {
      // Crash between dispatch and settle: the reserved target is already discoverable by its
      // pre-recorded correlation (the deterministic name) — no blind resend (engine.md).
      const existing = await options.k8s.getPod(name)
      if (existing !== undefined) {
        const uid = (existing['metadata'] as { uid?: string } | undefined)?.uid ?? null
        ensureSeam(options, name, request.target.id)
        return { kind: 'completed', result: { podName: name, podUid: uid } }
      }
    }
    throw error
  }
}

/** One seam per Pod, keyed the same way evidence/gate_release look it up — never replaced once created (a seam already mid-release must not reset). */
function ensureSeam(options: OwnerApiOptions, podName: string, incarnation: string): void {
  if (!options.seams.has(podName)) options.seams.set(podName, new LaunchSeam(incarnation))
}

async function cleanupPod(options: OwnerApiOptions, request: OwnerRequest): Promise<OwnerResponse> {
  const name = podName(request.workstreamId, request.target.id)
  const existing = await options.k8s.getPod(name)
  const nodeName = (existing?.['spec'] as { nodeName?: string } | undefined)?.nodeName ?? null
  const deadline = new Date(Date.now() + options.settings.terminationGraceSeconds * 1000 + 60_000)
  await options.obligations.record({ podName: name, workstreamId: request.workstreamId, reason: 'cleanup_pod', deadline, nodeName })
  await options.k8s.deletePod(name, options.settings.terminationGraceSeconds)
  await options.gate.retire(request.workstreamId, request.target.id)
  return { kind: 'completed', result: { retired: name, deadline: deadline.toISOString() } }
}

function gateRelease(options: OwnerApiOptions, request: OwnerRequest): OwnerResponse {
  const sessionId = (request.payload as { sessionId?: string }).sessionId
  const name = podName(request.workstreamId, request.target.id)
  const seam = options.seams.get(name)
  if (seam === undefined || typeof sessionId !== 'string') {
    return { kind: 'unknown', detail: 'seam not established' }
  }
  // S9: a Pod that is restoring must have its transcript verified in place before the adapter is
  // allowed to open a context on it — an unverified or half-placed restore that resumed would be
  // indistinguishable from a genuine one afterwards.
  const blocked = options.custody?.gateBlockedReason(name) ?? null
  if (blocked !== null) return { kind: 'unknown', detail: blocked }
  if (!seam.release(sessionId)) return { kind: 'unknown', detail: 'seam already bound to another Session' }
  // P4: minted only once release actually succeeds — the incarnation is confirmed real at this point.
  const bridgeToken = mintBridgeToken(request.target.id, options.bridgeAuthSecret)
  return { kind: 'completed', result: { released: true, bridgeToken } }
}

/** Convenience for callers building a request outside the engine's own reservation path (tests). */
export function withDigest(request: Omit<OwnerRequest, 'payloadDigest'>): OwnerRequest {
  return { ...request, payloadDigest: payloadDigest(request.payload) }
}
