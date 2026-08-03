import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AgentNotLaunchableError, resolveLaunchableDefinition, selectLaunchableAgents } from '@agora/agent-registry'
import type { AgentRuntimeDefinition } from '@agora/agent-registry'
import type { ACPBridgeEndpoint, MaterializeSessionRuntimeRequest, Problem, SessionRuntimeStatus } from '@agora/session-runtime-control'
import type { BridgeCredentialIssuer } from './bridge-credentials.js'
import type { KubernetesPods } from './k8s-client.js'
import { podName } from './labels.js'
import { fakeRelayBundle } from './relay-bundle.js'
import { dematerializeSessionRuntime, materializeSessionRuntime, reconcileSessionRuntime, type ReconciledStatus } from './reconciler.js'
import { getMaterializeRequestValidator } from './request-schemas.js'

/**
 * Internal server conforming to `contracts/openapi/session-runtime-control.yaml`. `security:
 * mutualTLS` there is a deployment-level policy (cluster mesh/NetworkPolicy terminates and enforces
 * it, same trust boundary as the mounted ServiceAccount token this process already relies on for
 * its OWN outbound k8s API calls) — this listener itself speaks plain HTTP, matching how
 * `k8s-client.ts` trusts its transport rather than re-implementing TLS.
 *
 * `/sessions/{id}/runtime/custody-snapshots` is deliberately UNBOUND: plans/04's own non-goal is
 * "No custody capture until P06" (plans/06-custody-and-resume.md owns "Controller capture
 * endpoint"). Faking a matching 2xx here would be more misleading than a 404.
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
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUNTIME_PATH_RE = /^\/v1\/sessions\/([^/]+)\/runtime$/
const ACP_CONNECTIONS_PATH_RE = /^\/v1\/sessions\/([^/]+)\/runtime\/acp-connections$/

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

  const result = await materializeSessionRuntime(deps.k8s, {
    sessionId,
    definition,
    workspaceMountRef: materializeRequest.workspaceMountRef,
    executionGrantRef: materializeRequest.executionGrantRef,
    relayBundle: fakeRelayBundle(),
    controllerRevision: deps.controllerRevision,
    ...(deps.runAsUser !== undefined ? { runAsUser: deps.runAsUser } : {}),
    ...(deps.runtimeClassName !== undefined ? { runtimeClassName: deps.runtimeClassName } : {}),
    ...(deps.imagePullSecretName !== undefined ? { imagePullSecretName: deps.imagePullSecretName } : {}),
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

  sendProblem(res, problem(404, 'not_found', 'no such route'))
}

export function createServer(deps: ServerDeps): Server {
  return createHttpServer((req, res) => {
    void route(deps, req, res).catch((error: unknown) => {
      sendProblem(res, problem(500, 'internal_error', 'unexpected controller error', error instanceof Error ? error.message : String(error)))
    })
  })
}
