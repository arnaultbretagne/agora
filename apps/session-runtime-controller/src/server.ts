import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AgentNotLaunchableError, resolveLaunchableDefinition, selectLaunchableAgents } from '@agora/agent-registry'
import type { AgentRuntimeDefinition } from '@agora/agent-registry'
import { restoreSnapshot } from '@agora/custody'
import type pg from 'pg'
import type { ACPBridgeEndpoint, MaterializeSessionRuntimeRequest, Problem, SessionRuntimeStatus } from '@agora/session-runtime-control'
import { BrokerActivationDeniedError, type BrokerActivationClient } from './broker-activation-client.js'
import type { BridgeCredentialIssuer } from './bridge-credentials.js'
import { captureCustody, checkRestoreSource, CustodyCaptureError, isReadableFormat } from './custody.js'
import type { KubernetesPods } from './k8s-client.js'
import { podName, serviceAccountName } from './labels.js'
import type { RelayBundle } from './relay-bundle.js'
import { dematerializeSessionRuntime, materializeSessionRuntime, reconcileSessionRuntime, type ReconciledStatus } from './reconciler.js'
import { getMaterializeRequestValidator } from './request-schemas.js'
import { CustodyStreamIssuer } from './restore-credentials.js'

/**
 * Internal server conforming to `contracts/openapi/session-runtime-control.yaml`. `security:
 * mutualTLS` there is a deployment-level policy (cluster mesh/NetworkPolicy terminates and enforces
 * it, same trust boundary as the mounted ServiceAccount token this process already relies on for
 * its OWN outbound k8s API calls) — this listener itself speaks plain HTTP, matching how
 * `k8s-client.ts` trusts its transport rather than re-implementing TLS.
 *
 * `/sessions/{id}/runtime/custody-snapshots` (capture) and the restore-stream Pods pull from are
 * this plan's own additions (plans/06-custody-and-resume.md "Controller capture endpoint" /
 * "restore-before-start flow") — P04 deliberately left capture unbound (404, not a faked 2xx).
 */
export interface ServerDeps {
  readonly k8s: KubernetesPods
  readonly definitions: readonly AgentRuntimeDefinition[]
  readonly registryRevision: string
  readonly bridgeIssuer: BridgeCredentialIssuer
  readonly controllerRevision: string
  readonly runAsUser?: number
  readonly runtimeClassName?: string
  readonly imagePullSecretName?: string
  /** `agora_custody_runtime`-role connection — the ONLY place in this deployable that touches Postgres, and only this schema/columns (docs/specs/07 "Access control"). */
  readonly custodyPool: pg.Pool
  readonly restoreIssuer: CustodyStreamIssuer
  /** Fixed, non-secret, cluster-internal DNS name this controller is reachable at — Pods pull their restore stream from here (docs/specs/07 "session-runtime: ... bytes enter through one-time restore/capture streams"), mirroring `relay-bundle.ts`'s fixed-endpoint pattern. */
  readonly custodyControllerBaseUrl: string
  /** P08's own seam: the fixed, credential-free relay endpoint/CA/stub bundle every Session Runtime
   * Pod receives (relay-bundle.ts's own doc comment). Operator-managed, never Session-specific — P04
   * used `fakeRelayBundle()` inline here; P08 supplies the real values through this same shape. */
  readonly relayBundle: RelayBundle
  /** docs/specs/10 "Bind grant + session_id + agent_id + workload_identity exactly once" — called
   * once per materialize, before any Pod is created, so a grant the Broker cannot activate never
   * reaches Kubernetes. */
  readonly brokerActivationClient: BrokerActivationClient
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUNTIME_PATH_RE = /^\/v1\/sessions\/([^/]+)\/runtime$/
const ACP_CONNECTIONS_PATH_RE = /^\/v1\/sessions\/([^/]+)\/runtime\/acp-connections$/
const CUSTODY_SNAPSHOTS_PATH_RE = /^\/v1\/sessions\/([^/]+)\/runtime\/custody-snapshots$/
const CUSTODY_RESTORE_STREAM_PATH_RE = /^\/v1\/sessions\/([^/]+)\/runtime\/custody-restore-stream$/

function sendJson(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.writeHead(status, { 'content-type': contentType })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

function problem(status: number, code: string, title: string, detail?: string): Problem {
  return { type: `https://agora.invalid/problems/${code}`, title, status, code, ...(detail ? { detail } : {}) }
}

function sendProblem(res: ServerResponse, p: Problem): void {
  sendJson(res, p.status, p, 'application/problem+json')
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : undefined
}

function requireRequestId(req: IncomingMessage): string | undefined {
  const header = req.headers['x-request-id']
  const value = Array.isArray(header) ? header[0] : header
  return value && UUID_RE.test(value) ? value : undefined
}

function toWireStatus(sessionId: string, status: ReconciledStatus): SessionRuntimeStatus {
  return {
    sessionId,
    agentId: status.agentId ?? '',
    runtimeDefinitionVersion: status.runtimeDefinitionVersion ?? '',
    state: status.state,
    podUid: status.podUid ?? null,
    failure: status.failure ?? null,
  }
}

function handleListAgents(deps: ServerDeps, res: ServerResponse): void {
  sendJson(res, 200, selectLaunchableAgents(deps.definitions, deps.registryRevision))
}

async function handleMaterialize(deps: ServerDeps, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = requireRequestId(req)
  if (!requestId) return sendProblem(res, problem(400, 'missing_request_id', 'X-Request-Id header is required and must be a UUID'))

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    return sendProblem(res, problem(400, 'invalid_json', 'request body is not valid JSON'))
  }

  // required test: "arbitrary image/command/env fields are schema-rejected" — this is the ONE
  // place a materialize request crosses from "arbitrary JSON" to a trusted shape; buildPodSpec
  // downstream has no parameter that could accept such a field even if this check were skipped.
  const validate = await getMaterializeRequestValidator()
  if (!validate(body)) {
    return sendProblem(res, problem(400, 'invalid_request', 'request body failed schema validation', JSON.stringify(validate.errors)))
  }
  const materializeRequest = body as MaterializeSessionRuntimeRequest

  let definition: AgentRuntimeDefinition
  try {
    definition = resolveLaunchableDefinition(deps.definitions, materializeRequest.agentId, materializeRequest.runtimeDefinitionVersion)
  } catch (error) {
    if (error instanceof AgentNotLaunchableError) return sendProblem(res, problem(409, error.code, error.message))
    throw error
  }

  // docs/specs/10: a grant the Broker will not activate must never reach Kubernetes. The
  // per-Session ServiceAccount name IS this Session Runtime's "Controller-created authenticated
  // identity" (ActivateGrantRequest.workloadIdentity's own doc) — the same identity a real mesh
  // sidecar authenticates via mTLS/SPIFFE before the Broker's access relay ever trusts it
  // (relay.ts's own module doc). Idempotent: re-activating an already-bound grant on a retried
  // materialize PUT is a safe no-op at the Broker.
  const workloadIdentity = serviceAccountName(sessionId)
  try {
    await deps.brokerActivationClient.activate({
      grantRef: materializeRequest.executionGrantRef,
      sessionId,
      agentId: definition.agentId,
      workloadIdentity,
      requestId,
    })
  } catch (error) {
    if (error instanceof BrokerActivationDeniedError) {
      return sendProblem(res, problem(error.status, error.code, 'Broker denied execution-grant activation for this Session Runtime', error.message))
    }
    throw error
  }

  let restoreFrom: { readonly url: string; readonly credential: string } | undefined
  if (materializeRequest.restoreFrom) {
    const snapshotId = materializeRequest.restoreFrom
    const source = await checkRestoreSource(deps.custodyPool, snapshotId)
    if (!source || source.sessionId !== sessionId) {
      return sendProblem(res, problem(409, 'custody_snapshot_not_found', 'restoreFrom does not name a snapshot owned by this Session'))
    }
    if (source.invalidatedAt) {
      return sendProblem(res, problem(422, 'custody_snapshot_invalidated', 'restoreFrom names an invalidated snapshot'))
    }
    if (!isReadableFormat(definition.custody.readFormats, source.formatId, source.formatVersion)) {
      return sendProblem(
        res,
        problem(422, 'custody_format_incompatible', `Agent '${definition.agentId}@${definition.version}' cannot read format '${source.formatId}@${source.formatVersion}'`),
      )
    }
    const credential = deps.restoreIssuer.mint(sessionId, snapshotId)
    const url = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/runtime/custody-restore-stream`, deps.custodyControllerBaseUrl).toString()
    restoreFrom = { url, credential }
  }

  const result = await materializeSessionRuntime(deps.k8s, {
    sessionId,
    definition,
    workspaceMountRef: materializeRequest.workspaceMountRef,
    executionGrantRef: materializeRequest.executionGrantRef,
    relayBundle: deps.relayBundle,
    controllerRevision: deps.controllerRevision,
    ...(deps.runAsUser !== undefined ? { runAsUser: deps.runAsUser } : {}),
    ...(deps.runtimeClassName !== undefined ? { runtimeClassName: deps.runtimeClassName } : {}),
    ...(deps.imagePullSecretName !== undefined ? { imagePullSecretName: deps.imagePullSecretName } : {}),
    ...(restoreFrom ? { restoreFrom } : {}),
  })
  sendJson(res, result.httpStatus, toWireStatus(sessionId, result.status))
}

async function handleGetStatus(deps: ServerDeps, sessionId: string, res: ServerResponse): Promise<void> {
  const status = await reconcileSessionRuntime(deps.k8s, sessionId)
  if (status.state === 'absent') {
    return sendProblem(res, problem(404, 'session_runtime_not_materialized', 'the Session Runtime is currently not materialized'))
  }
  sendJson(res, 200, toWireStatus(sessionId, status))
}

async function handleDematerialize(deps: ServerDeps, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = requireRequestId(req)
  if (!requestId) return sendProblem(res, problem(400, 'missing_request_id', 'X-Request-Id header is required and must be a UUID'))

  const result = await dematerializeSessionRuntime(deps.k8s, sessionId)
  // docs/specs/08: "Revoke bridge/grant during dematerialization" — unconditional and idempotent,
  // whether or not this Session ever minted a bridge connection.
  deps.bridgeIssuer.revokeSession(sessionId)
  deps.restoreIssuer.revokeSession(sessionId)
  if (result.httpStatus === 204) {
    res.writeHead(204)
    res.end()
    return
  }
  sendJson(res, 202, toWireStatus(sessionId, result.status))
}

async function handleOpenAcpConnection(deps: ServerDeps, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = requireRequestId(req)
  if (!requestId) return sendProblem(res, problem(400, 'missing_request_id', 'X-Request-Id header is required and must be a UUID'))

  const status = await reconcileSessionRuntime(deps.k8s, sessionId)
  if (status.state !== 'ready') {
    return sendProblem(res, problem(409, 'session_runtime_not_ready', `Session Runtime state is '${status.state}', not 'ready'`))
  }
  const definition = deps.definitions.find((d) => d.agentId === status.agentId && d.version === status.runtimeDefinitionVersion)
  const pod = await deps.k8s.getPod(podName(sessionId))
  const podIp = (pod?.status as { podIP?: string } | undefined)?.podIP
  if (!definition || !podIp) {
    return sendProblem(res, problem(409, 'session_runtime_not_ready', 'Session Runtime Pod has no address yet'))
  }

  const scheme = definition.bridge.transport === 'websocket' ? 'ws' : 'http'
  const endpoint = `${scheme}://${podIp}:${definition.bridge.listenPort}/`
  const minted = deps.bridgeIssuer.mint(sessionId, requestId, () => endpoint)
  const response: ACPBridgeEndpoint = {
    transport: definition.bridge.transport,
    url: minted.url,
    credential: minted.credential,
    expiresAt: minted.expiresAt,
  }
  sendJson(res, 201, response)
}

function isValidCaptureBody(body: unknown): body is { syncedThroughSeq: number } {
  if (typeof body !== 'object' || body === null) return false
  const keys = Object.keys(body)
  if (keys.some((k) => k !== 'syncedThroughSeq')) return false
  const value = (body as { syncedThroughSeq?: unknown }).syncedThroughSeq
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** docs/specs/07 "Capture contract" (plans/06 "Controller capture endpoint"). */
async function handleCaptureCustody(deps: ServerDeps, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = requireRequestId(req)
  if (!requestId) return sendProblem(res, problem(400, 'missing_request_id', 'X-Request-Id header is required and must be a UUID'))

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    return sendProblem(res, problem(400, 'invalid_json', 'request body is not valid JSON'))
  }
  if (!isValidCaptureBody(body)) {
    return sendProblem(res, problem(400, 'invalid_request', 'request body must be { syncedThroughSeq: integer >= 0 }'))
  }

  const status = await reconcileSessionRuntime(deps.k8s, sessionId)
  if (status.state !== 'ready') {
    return sendProblem(res, problem(409, 'session_runtime_not_ready', `Session Runtime state is '${status.state}', not 'ready'`))
  }
  const definition = deps.definitions.find((d) => d.agentId === status.agentId && d.version === status.runtimeDefinitionVersion)
  const pod = await deps.k8s.getPod(podName(sessionId))
  const podIp = (pod?.status as { podIP?: string } | undefined)?.podIP
  if (!definition || !podIp) {
    return sendProblem(res, problem(409, 'session_runtime_not_ready', 'Session Runtime Pod has no address yet'))
  }

  try {
    const ref = await captureCustody(deps.custodyPool, {
      sessionId,
      captureRequestId: requestId,
      syncedThroughSeq: body.syncedThroughSeq,
      podIp,
      bridgePort: definition.bridge.listenPort,
      definition,
    })
    sendJson(res, 201, ref)
  } catch (error) {
    if (error instanceof CustodyCaptureError) {
      return sendProblem(res, problem(422, error.code, error.message))
    }
    throw error
  }
}

/** Pod-initiated pull (docs/specs/07 "Restore contract" step 4) — never the payload itself over any other channel. */
async function handleRestoreStream(deps: ServerDeps, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = req.headers.authorization
  const credential = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined
  if (!credential) return sendProblem(res, problem(401, 'missing_credential', 'Authorization: Bearer <credential> is required'))

  const consumed = deps.restoreIssuer.consume(sessionId, credential)
  if (!consumed) return sendProblem(res, problem(403, 'invalid_or_used_credential', 'restore credential is invalid, expired or already used'))

  const client = await deps.custodyPool.connect()
  try {
    const restored = await restoreSnapshot(client, consumed.snapshotId)
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(restored.payload.length),
      'x-agora-format-id': restored.formatId,
      'x-agora-format-version': restored.formatVersion,
      'x-agora-sha256': restored.sha256,
    })
    res.end(Buffer.from(restored.payload))
  } catch (error) {
    sendProblem(res, problem(500, 'restore_failed', 'could not read snapshot', error instanceof Error ? error.message : String(error)))
  } finally {
    client.release()
  }
}

async function route(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal')
  const method = req.method ?? 'GET'

  if (url.pathname === '/v1/agents' && method === 'GET') return handleListAgents(deps, res)

  const runtimeMatch = RUNTIME_PATH_RE.exec(url.pathname)
  if (runtimeMatch?.[1]) {
    const sessionId = decodeURIComponent(runtimeMatch[1])
    if (!UUID_RE.test(sessionId)) return sendProblem(res, problem(400, 'invalid_session_id', 'sessionId must be a UUID'))
    if (method === 'PUT') return handleMaterialize(deps, sessionId, req, res)
    if (method === 'GET') return handleGetStatus(deps, sessionId, res)
    if (method === 'DELETE') return handleDematerialize(deps, sessionId, req, res)
  }

  const acpMatch = ACP_CONNECTIONS_PATH_RE.exec(url.pathname)
  if (acpMatch?.[1] && method === 'POST') {
    const sessionId = decodeURIComponent(acpMatch[1])
    if (!UUID_RE.test(sessionId)) return sendProblem(res, problem(400, 'invalid_session_id', 'sessionId must be a UUID'))
    return handleOpenAcpConnection(deps, sessionId, req, res)
  }

  const captureMatch = CUSTODY_SNAPSHOTS_PATH_RE.exec(url.pathname)
  if (captureMatch?.[1] && method === 'POST') {
    const sessionId = decodeURIComponent(captureMatch[1])
    if (!UUID_RE.test(sessionId)) return sendProblem(res, problem(400, 'invalid_session_id', 'sessionId must be a UUID'))
    return handleCaptureCustody(deps, sessionId, req, res)
  }

  const restoreMatch = CUSTODY_RESTORE_STREAM_PATH_RE.exec(url.pathname)
  if (restoreMatch?.[1] && method === 'GET') {
    const sessionId = decodeURIComponent(restoreMatch[1])
    if (!UUID_RE.test(sessionId)) return sendProblem(res, problem(400, 'invalid_session_id', 'sessionId must be a UUID'))
    return handleRestoreStream(deps, sessionId, req, res)
  }

  sendProblem(res, problem(404, 'not_found', 'no such route'))
}

export function createServer(deps: ServerDeps): Server {
  return createHttpServer((req, res) => {
    void route(deps, req, res).catch((error: unknown) => {
      sendProblem(res, problem(500, 'internal_error', 'unexpected controller error', error instanceof Error ? error.message : String(error)))
    })
  })
}
