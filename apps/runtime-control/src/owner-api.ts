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
  const status = pod['status'] as { phase?: string; containerStatuses?: readonly { imageID?: string }[] } | undefined
  const spec = pod['spec'] as { containers?: readonly { image?: string }[] } | undefined
  return send(res, 200, {
    uid: metadata?.uid ?? null,
    imageId: status?.containerStatuses?.[0]?.imageID ?? null,
    admittedDigest: spec?.containers?.[0]?.image ?? null,
    // The seam is the one place a process restart is actually observed (LaunchSeam.processRestart) —
    // a Pod with no seam yet (evidence read before create_pod's ensureSeam) is generation 0, not unknown.
    processGeneration: options.seams.get(name)?.state().processGeneration ?? 0,
    startupDeadlineExpired: isStartupDeadlineExpired(metadata?.creationTimestamp ?? null, status?.phase ?? 'Unknown', new Date().toISOString(), options.settings.startupDeadlineSeconds),
    seam: options.seams.get(name)?.state() ?? null,
  })
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
  if (!seam.release(sessionId)) return { kind: 'unknown', detail: 'seam already bound to another Session' }
  // P4: minted only once release actually succeeds — the incarnation is confirmed real at this point.
  const bridgeToken = mintBridgeToken(request.target.id, options.bridgeAuthSecret)
  return { kind: 'completed', result: { released: true, bridgeToken } }
}

/** Convenience for callers building a request outside the engine's own reservation path (tests). */
export function withDigest(request: Omit<OwnerRequest, 'payloadDigest'>): OwnerRequest {
  return { ...request, payloadDigest: payloadDigest(request.payload) }
}
