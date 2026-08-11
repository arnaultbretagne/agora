import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AgentRuntimeDefinition } from '@agora/agent-registry'
import { selectLaunchableAgents } from '@agora/agent-registry'
import type { EquipmentRequest } from '@agora/domain'
import { getEquipmentCatalogue } from '@agora/equipment-policy'
import type pg from 'pg'
import {
  activateExecutionGrant,
  type GrantServiceDeps,
  issueExecutionGrant,
  releaseSessionAgent,
  renewExecutionGrant,
  revokeExecutionGrant,
  RuntimeBundleDriftError,
} from './grant-service.js'
import { GrantConflictError, GrantDigestChangedError } from './grants-repository.js'
import { ActivationConflictError } from './activations-repository.js'
import { PolicyDenialError } from '@agora/equipment-policy'
import { OneCliUnavailableError } from './onecli-adapter.js'
import { getBrokerRequestValidators } from './request-schemas.js'

/**
 * Internal server conforming to `contracts/openapi/broker-control.yaml`. `security: mutualTLS`
 * there is a deployment-level policy — same "trust the transport" convention as
 * apps/session-runtime-controller/src/server.ts (see that file's own module doc).
 */
export interface BrokerServerDeps extends GrantServiceDeps {
  readonly pool: pg.Pool
  readonly definitions: readonly AgentRuntimeDefinition[]
  readonly registryRevision: string
}

interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly code: string
  readonly detail?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RENEW_PATH_RE = /^\/v1\/execution-grants\/([^/]+)\/renew$/
const RELEASE_PATH_RE = /^\/v1\/execution-grants\/([^/]+)\/release$/
const GRANT_PATH_RE = /^\/v1\/execution-grants\/([^/]+)$/

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

function wireGrant(grant: Awaited<ReturnType<typeof issueExecutionGrant>>) {
  return {
    grantId: grant.id,
    grantRef: grant.id,
    sessionId: grant.sessionId,
    agentId: grant.agentId,
    policyVersion: grant.policyVersion,
    capabilityDigest: grant.capabilityDigest,
    capabilities: grant.capabilities,
    mcpServers: grant.mcpServers,
    expiresAt: grant.expiresAt.toISOString(),
  }
}

async function handleIssueGrant(deps: BrokerServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = requireRequestId(req)
  if (!requestId) return sendProblem(res, problem(400, 'missing_request_id', 'X-Request-Id header is required and must be a UUID'))

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    return sendProblem(res, problem(400, 'invalid_json', 'request body is not valid JSON'))
  }
  const validators = await getBrokerRequestValidators()
  if (!validators.issueGrant(body)) {
    return sendProblem(res, problem(400, 'invalid_request', 'request body failed schema validation', JSON.stringify(validators.issueGrant.errors)))
  }
  const request = body as {
    sessionId: string
    agentId: string
    principalId: string
    workstreamCategory: 'discussion' | 'invocation'
    equipment: EquipmentRequest
  }

  const launchable = selectLaunchableAgents(deps.definitions, deps.registryRevision).items.find((item) => item.agentId === request.agentId)
  if (!launchable) return sendProblem(res, problem(403, 'agent_not_launchable', `agent '${request.agentId}' has no launchable registry definition`))

  const client = await deps.pool.connect()
  try {
    const grant = await issueExecutionGrant(
      client,
      deps,
      {
        sessionId: request.sessionId,
        agentId: request.agentId,
        principalId: request.principalId,
        workstreamCategory: request.workstreamCategory,
        runtimeDefinitionVersion: launchable.runtimeDefinitionVersion,
        equipment: request.equipment,
        requestId,
      },
      new Date(),
    )
    sendJson(res, 201, wireGrant(grant))
  } catch (error) {
    if (error instanceof PolicyDenialError) return sendProblem(res, problem(403, error.code, error.message))
    if (error instanceof GrantConflictError) return sendProblem(res, problem(409, 'grant_conflict', error.message))
    if (error instanceof RuntimeBundleDriftError) return sendProblem(res, problem(503, 'runtime_bundle_drift', error.message))
    if (error instanceof OneCliUnavailableError) return sendProblem(res, problem(503, 'onecli_unavailable', error.message))
    throw error
  } finally {
    client.release()
  }
}

async function handleActivateGrant(deps: BrokerServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = requireRequestId(req)
  if (!requestId) return sendProblem(res, problem(400, 'missing_request_id', 'X-Request-Id header is required and must be a UUID'))

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    return sendProblem(res, problem(400, 'invalid_json', 'request body is not valid JSON'))
  }
  const validators = await getBrokerRequestValidators()
  if (!validators.activateGrant(body)) {
    return sendProblem(res, problem(400, 'invalid_request', 'request body failed schema validation', JSON.stringify(validators.activateGrant.errors)))
  }
  const request = body as { grantRef: string; sessionId: string; agentId: string; workloadIdentity: string }

  const client = await deps.pool.connect()
  try {
    const activation = await activateExecutionGrant(
      client,
      { grantRef: request.grantRef, sessionId: request.sessionId, agentId: request.agentId, workloadIdentity: request.workloadIdentity, requestId },
      new Date(),
    )
    sendJson(res, 201, {
      activationId: activation.id,
      grantId: activation.grantId,
      sessionId: activation.sessionId,
      agentId: activation.agentId,
      workloadIdentity: activation.workloadIdentity,
      expiresAt: activation.expiresAt.toISOString(),
    })
  } catch (error) {
    if (error instanceof ActivationConflictError) return sendProblem(res, problem(409, 'activation_conflict', error.message))
    if (error instanceof Error) return sendProblem(res, problem(403, 'activation_denied', error.message))
    throw error
  } finally {
    client.release()
  }
}

/**
 * Suspend's half of the Agent lifecycle: give the OneCLI Agent up, keep the grant renewable.
 *
 * Answers 204 for "released" and for "there was nothing to release" alike — the caller is a
 * Session tear-down that must not be derailed by the Broker's bookkeeping, and re-releasing has
 * no effect worth reporting differently.
 */
async function handleReleaseGrantAgent(deps: BrokerServerDeps, grantId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = requireRequestId(req)
  if (!requestId) return sendProblem(res, problem(400, 'missing_request_id', 'X-Request-Id header is required and must be a UUID'))
  if (!UUID_RE.test(grantId)) return sendProblem(res, problem(400, 'invalid_grant_id', 'grantId must be a UUID'))

  const client = await deps.pool.connect()
  try {
    await releaseSessionAgent(client, deps, grantId, new Date())
    res.writeHead(204).end()
  } catch (error) {
    if (error instanceof OneCliUnavailableError) return sendProblem(res, problem(503, 'onecli_unavailable', error.message))
    throw error
  } finally {
    client.release()
  }
}

async function handleRenewGrant(deps: BrokerServerDeps, grantId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = requireRequestId(req)
  if (!requestId) return sendProblem(res, problem(400, 'missing_request_id', 'X-Request-Id header is required and must be a UUID'))
  if (!UUID_RE.test(grantId)) return sendProblem(res, problem(400, 'invalid_grant_id', 'grantId must be a UUID'))

  const client = await deps.pool.connect()
  try {
    const renewed = await renewExecutionGrant(client, deps, grantId, new Date())
    sendJson(res, 200, wireGrant(renewed))
  } catch (error) {
    if (error instanceof GrantDigestChangedError) return sendProblem(res, problem(409, 'capability_digest_changed', error.message))
    if (error instanceof GrantConflictError) return sendProblem(res, problem(409, 'grant_conflict', error.message))
    if (error instanceof RuntimeBundleDriftError) return sendProblem(res, problem(503, 'runtime_bundle_drift', error.message))
    if (error instanceof OneCliUnavailableError) return sendProblem(res, problem(503, 'onecli_unavailable', error.message))
    if (error instanceof Error) return sendProblem(res, problem(409, 'grant_not_renewable', error.message))
    throw error
  } finally {
    client.release()
  }
}

async function handleRevokeGrant(deps: BrokerServerDeps, grantId: string, res: ServerResponse): Promise<void> {
  if (!UUID_RE.test(grantId)) return sendProblem(res, problem(400, 'invalid_grant_id', 'grantId must be a UUID'))
  const client = await deps.pool.connect()
  try {
    await revokeExecutionGrant(client, deps, grantId, new Date())
    res.writeHead(204).end()
  } finally {
    client.release()
  }
}

export function createBrokerServer(deps: BrokerServerDeps): Server {
  return createHttpServer((req, res) => {
    void route(deps, req, res).catch((error) => {
      sendProblem(res, problem(500, 'internal_error', 'unexpected broker error', error instanceof Error ? error.message : String(error)))
    })
  })
}

async function route(deps: BrokerServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? ''
  const method = req.method ?? 'GET'

  if (method === 'GET' && url === '/v1/equipment-catalogue') {
    return sendJson(res, 200, getEquipmentCatalogue())
  }
  if (method === 'POST' && url === '/v1/execution-grants') {
    return handleIssueGrant(deps, req, res)
  }
  if (method === 'POST' && url === '/v1/execution-grant-activations') {
    return handleActivateGrant(deps, req, res)
  }
  const renewMatch = RENEW_PATH_RE.exec(url)
  if (method === 'POST' && renewMatch) {
    return handleRenewGrant(deps, renewMatch[1]!, req, res)
  }
  const releaseMatch = RELEASE_PATH_RE.exec(url)
  if (method === 'POST' && releaseMatch) {
    return handleReleaseGrantAgent(deps, releaseMatch[1]!, req, res)
  }
  const grantMatch = GRANT_PATH_RE.exec(url)
  if (method === 'DELETE' && grantMatch) {
    return handleRevokeGrant(deps, grantMatch[1]!, res)
  }
  sendProblem(res, problem(404, 'not_found', `no route for ${method} ${url}`))
}

export function randomRequestId(): string {
  return randomUUID()
}
