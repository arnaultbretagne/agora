import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import type pg from 'pg'
import {
  getCommand,
  getMembershipRole,
  getSession,
  getSessionWorkspaceMountRef,
  getWorkstreamDetail,
  listWorkstreamItemsPage,
  listWorkstreamMembershipsWire,
  listWorkstreamsForPrincipal,
  listWorkstreamTurnsPage,
  markWorkstreamDeleting,
  openAdditionalSession,
  patchWorkstreamMetadata,
  putWorkstreamMembership,
  removeWorkstreamMembership,
  createOrReuseCommand,
  createWorkstreamWithFirstSession,
  type WorkstreamRole,
} from '@agora/store-pg'
import { nameBasedUuid, principalId, type PrincipalId, DomainError } from '@agora/domain'
import { getEquipmentCatalogue } from '@agora/equipment-policy'
import { promptSession } from '@agora/acp'
import { HandoffNotReadyError } from '@agora/store-pg'
import { getSessionRuntime, listLaunchableAgents, type SessionRuntimeControlTransport } from '@agora/session-runtime-control'
import type { BrokerGrantClient } from './broker-grant-client.js'
import {
  activateSession,
  cancelSessionCommand,
  closeSession,
  provisionSessionAndPrompt,
  suspendSession,
  switchAgent,
} from './orchestration.js'
import type { SessionConnectionRegistry } from './connections.js'
import { getValidators } from './request-schemas.js'

/**
 * Internal server conforming to `contracts/openapi/product-api.yaml`. Two principal sources
 * (`requirePrincipal`): `Authorization: Bearer <principalId>`, a fixed, honest placeholder for
 * dev/test (the bearer token IS the principal id, no signature) — and, since P11, the real
 * SSO path: oauth2-proxy (Pocket-ID) sits in front of this Service in production and forwards
 * the verified identity as `X-Forwarded-Email`, trusted because the NetworkPolicy admits ingress
 * only from that pod. No per-workstream authorization model beyond membership exists yet (no
 * ADR/spec describes one) — single-operator in practice today.
 *
 * `PUT /sessions/{id}/mode`, `PUT /sessions/{id}/config-options/{id}`,
 * `POST /sessions/{id}/permission-requests/{id}/decision` and
 * `POST /sessions/{id}/elicitation-requests/{id}/response` are intentionally unbound (404) — P03
 * already deferred ACP mode/config methods and no required test here exercises them; a durable
 * pending-request/decision model would be new, speculative scope.
 */
export interface ServerDeps {
  readonly pool: pg.Pool
  readonly controllerTransport: SessionRuntimeControlTransport
  readonly brokerGrantClient: BrokerGrantClient
  readonly connections: SessionConnectionRegistry
  readonly now?: () => Date
}

interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly code: string
  readonly detail?: string
}

function problem(status: number, code: string, title: string, detail?: string): Problem {
  return { type: `https://agora.invalid/problems/${code}`, title, status, code, ...(detail ? { detail } : {}) }
}

function sendJson(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.writeHead(status, { 'content-type': contentType })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

function sendProblem(res: ServerResponse, p: Problem): void {
  sendJson(res, p.status, p, 'application/problem+json')
}

function sendNoContent(res: ServerResponse, status = 204): void {
  res.writeHead(status)
  res.end()
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : undefined
}

function requirePrincipal(req: IncomingMessage): PrincipalId | undefined {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim()
    if (token) {
      try {
        return principalId(token)
      } catch {
        // fall through to the SSO path below
      }
    }
  }
  // P11: the real gate in front of this server (oauth2-proxy, Pocket-ID SSO) forwards the
  // already-verified identity as X-Forwarded-Email (oauth2-proxy's own default with
  // pass-user-headers, on unless disabled) — the Authorization: Bearer <principalId> placeholder
  // above predates any real SSO gate (this file's own module doc: "no owner yet"). This is that
  // follow-up, scoped minimally: trust the header because the NetworkPolicy in front of this
  // Service admits ingress ONLY from the oauth2-proxy pod (apps/agora/networkpolicy.yaml) — same
  // "trust the transport" convention this repo already uses for its mTLS-gated internal servers
  // (apps/broker/src/server.ts's own module doc). A header forged by anything else can never
  // reach this process.
  const forwardedEmail = req.headers['x-forwarded-email']
  const email = Array.isArray(forwardedEmail) ? forwardedEmail[0] : forwardedEmail
  if (email) {
    try {
      return principalId(email)
    } catch {
      return undefined
    }
  }
  return undefined
}

function requireIdempotencyKey(req: IncomingMessage): string | undefined {
  const header = req.headers['idempotency-key']
  const value = Array.isArray(header) ? header[0] : header
  return value && value.length >= 8 && value.length <= 200 ? value : undefined
}

function domainErrorToProblem(error: DomainError): Problem {
  const status = error.code === 'workstream_last_owner_required' || error.code === 'workstream_membership_duplicate' ? 409 : 400
  return problem(status, error.code, error.message)
}

async function requireMembership(pool: pg.Pool, workstreamId: string, principal: string): Promise<WorkstreamRole | undefined> {
  const client = await pool.connect()
  try {
    return await getMembershipRole(client, workstreamId, principal)
  } finally {
    client.release()
  }
}

function canMutate(role: WorkstreamRole): boolean {
  return role === 'owner' || role === 'editor'
}

// ---------- Workstreams ----------

async function handleListWorkstreams(deps: ServerDeps, principal: string, url: URL, res: ServerResponse): Promise<void> {
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam ? Math.min(100, Math.max(1, Number(limitParam))) : 30
  const cursor = url.searchParams.get('cursor') ?? undefined
  const client = await deps.pool.connect()
  try {
    const result = await listWorkstreamsForPrincipal(client, principal, { limit, ...(cursor ? { cursor } : {}) })
    sendJson(res, 200, result)
  } finally {
    client.release()
  }
}

/**
 * docs/specs/03 "New Session" step 1: "Agora resolves agent_id to the controller-authoritative
 * current runtime-definition version" — BEFORE creating anything, not backfilled after. Also lets
 * an unknown/disabled agentId fail fast (`agent_unavailable`) instead of creating a Workstream
 * that can only fail asynchronously later.
 */
async function resolveLaunchableAgent(deps: ServerDeps, agentId: string): Promise<{ readonly runtimeDefinitionVersion: string } | undefined> {
  const definitions = await listLaunchableAgents(deps.controllerTransport)
  const agent = definitions.items.find((a) => a.agentId === agentId && a.availability === 'enabled')
  return agent ? { runtimeDefinitionVersion: agent.runtimeDefinitionVersion } : undefined
}

async function handleCreateWorkstream(deps: ServerDeps, principal: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const idempotencyKey = requireIdempotencyKey(req)
  if (!idempotencyKey) return sendProblem(res, problem(400, 'validation_failed', 'Idempotency-Key header is required (8-200 chars)'))

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    return sendProblem(res, problem(400, 'validation_failed', 'request body is not valid JSON'))
  }
  const validators = await getValidators()
  if (!validators.createWorkstream(body)) {
    return sendProblem(res, problem(400, 'validation_failed', 'request body failed schema validation', JSON.stringify(validators.createWorkstream.errors)))
  }
  const request = body as {
    category: 'discussion' | 'invocation'
    agentId: string
    workspace: { workspaceRef: string }
    equipment: { catalogueVersion: string; resources: readonly unknown[] }
    prompt: readonly { type: string; text?: string }[]
  }

  const agent = await resolveLaunchableAgent(deps, request.agentId)
  if (!agent) return sendProblem(res, problem(409, 'agent_unavailable', `Agent '${request.agentId}' is not launchable`))

  const now = deps.now ?? (() => new Date())
  // `product.commands.workstream_id` is a foreign key — a CreateWorkstream command can only be
  // inserted once its target Workstream row exists, so (unlike every other command type here) the
  // Workstream must be created FIRST. Deriving its id deterministically from (principal,
  // idempotencyKey) — same construction as @agora/domain's own Command-id derivation — is what
  // makes a retry land on the SAME Workstream instead of needing the id back from a prior response
  // it may never have received. Sequential retries (the common case: client times out, resends)
  // are fully idempotent this way; a genuinely simultaneous double-submit of the same key is not
  // closed here (unlike `createOrReuseCommand`'s own `ON CONFLICT` race-safety) — retrofitting
  // that into a multi-table, multi-row atomic create was judged disproportionate to this plan.
  const workstreamId = nameBasedUuid('0275f91b-af79-4893-b3af-434229a5df5f', `${principal}:${idempotencyKey}`)
  const client = await deps.pool.connect()
  let sessionId: string
  let commandId: string
  let isNewWorkstream: boolean
  try {
    const { rows: existingRows } = await client.query<{ id: string }>('SELECT id FROM product.workstreams WHERE id = $1', [workstreamId])
    isNewWorkstream = existingRows.length === 0
    if (existingRows.length > 0) {
      const { rows: existingSessionRows } = await client.query<{ id: string }>(
        'SELECT id FROM product.sessions WHERE workstream_id = $1 AND ordinal = 1',
        [workstreamId],
      )
      sessionId = existingSessionRows[0]?.id ?? ''
    } else {
      const { session } = await createWorkstreamWithFirstSession(client, {
        workstream: { id: workstreamId as never, category: request.category, title: 'Untitled', owner: principalId(principal), createdAt: now() },
        session: {
          id: randomUUID() as never,
          ordinal: 1,
          launchEnvelope: {
            agentId: request.agentId,
            workspaceSpec: { workspaceRef: request.workspace.workspaceRef },
            equipmentRequest: request.equipment as never,
            runtimeDefinitionVersion: agent.runtimeDefinitionVersion,
          },
        },
        runtimeDefinitionVersion: agent.runtimeDefinitionVersion,
      })
      sessionId = session.id as string
    }

    const command = await createOrReuseCommand(client, {
      type: 'CreateWorkstream',
      workstreamId: workstreamId as never,
      actor: { kind: 'human', id: principal as never },
      idempotencyScope: 'create-workstream',
      idempotencyKey,
      acceptedAt: now(),
      request: request as unknown as Record<string, unknown>,
    })
    commandId = command.id as string
  } finally {
    client.release()
  }

  const detailClient = await deps.pool.connect()
  let workstreamWire
  let sessionWire
  try {
    workstreamWire = await getWorkstreamDetail(detailClient, workstreamId, principal)
    sessionWire = await getSession(detailClient, sessionId)
  } finally {
    detailClient.release()
  }
  if (!workstreamWire || !sessionWire) throw new Error('unreachable: just created')

  sendJson(res, 202, {
    command: { commandId, state: 'accepted', acceptedAt: now().toISOString() },
    workstream: workstreamWire,
    session: sessionWire,
  })

  // A retry (same principal+Idempotency-Key) must not re-run provisioning: the Session may already
  // be ready/ACP-bound, and bootstrapSession's write-once binding would throw on a second attempt.
  if (isNewWorkstream) {
    void provisionSessionAndPrompt({
      pool: deps.pool,
      transport: deps.controllerTransport,
      brokerGrantClient: deps.brokerGrantClient,
      connections: deps.connections,
      workstreamId,
      sessionId,
      agentId: request.agentId,
      runtimeDefinitionVersion: agent.runtimeDefinitionVersion,
      workspaceMountRef: request.workspace.workspaceRef,
      initialPrompt: request.prompt as never,
      actor: { kind: 'human', id: principal },
    })
  }
}

async function handleGetWorkstream(deps: ServerDeps, principal: string, workstreamId: string, res: ServerResponse): Promise<void> {
  const client = await deps.pool.connect()
  try {
    const detail = await getWorkstreamDetail(client, workstreamId, principal)
    if (!detail) return sendProblem(res, problem(404, 'workstream_not_found', 'Workstream not found'))
    sendJson(res, 200, detail)
  } finally {
    client.release()
  }
}

async function handlePatchWorkstream(deps: ServerDeps, principal: string, workstreamId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const idempotencyKey = requireIdempotencyKey(req)
  if (!idempotencyKey) return sendProblem(res, problem(400, 'validation_failed', 'Idempotency-Key header is required (8-200 chars)'))
  const role = await requireMembership(deps.pool, workstreamId, principal)
  if (!role) return sendProblem(res, problem(404, 'workstream_not_found', 'Workstream not found'))
  if (!canMutate(role)) return sendProblem(res, problem(403, 'validation_failed', 'Viewers cannot modify a Workstream'))

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    return sendProblem(res, problem(400, 'validation_failed', 'request body is not valid JSON'))
  }
  const validators = await getValidators()
  if (!validators.patchWorkstream(body)) {
    return sendProblem(res, problem(400, 'validation_failed', 'request body failed schema validation', JSON.stringify(validators.patchWorkstream.errors)))
  }

  const client = await deps.pool.connect()
  try {
    await patchWorkstreamMetadata(client, workstreamId, body as { title?: string; pinned?: boolean })
  } finally {
    client.release()
  }
  await handleGetWorkstreamAsWorkstream(deps, principal, workstreamId, res)
}

async function handleGetWorkstreamAsWorkstream(deps: ServerDeps, principal: string, workstreamId: string, res: ServerResponse): Promise<void> {
  const client = await deps.pool.connect()
  try {
    const detail = await getWorkstreamDetail(client, workstreamId, principal)
    if (!detail) return sendProblem(res, problem(404, 'workstream_not_found', 'Workstream not found'))
    const { sessions: _sessions, projectionHead: _projectionHead, ...workstream } = detail
    sendJson(res, 200, workstream)
  } finally {
    client.release()
  }
}

async function handleDeleteWorkstream(deps: ServerDeps, principal: string, workstreamId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const idempotencyKey = requireIdempotencyKey(req)
  if (!idempotencyKey) return sendProblem(res, problem(400, 'validation_failed', 'Idempotency-Key header is required (8-200 chars)'))
  const role = await requireMembership(deps.pool, workstreamId, principal)
  if (!role) return sendProblem(res, problem(404, 'workstream_not_found', 'Workstream not found'))
  if (!canMutate(role)) return sendProblem(res, problem(403, 'validation_failed', 'Viewers cannot delete a Workstream'))

  const now = deps.now ?? (() => new Date())
  const client = await deps.pool.connect()
  let commandId: string
  try {
    const command = await createOrReuseCommand(client, {
      type: 'DeleteWorkstream',
      workstreamId: workstreamId as never,
      actor: { kind: 'human', id: principal as never },
      idempotencyScope: 'delete-workstream',
      idempotencyKey,
      acceptedAt: now(),
      request: {},
    })
    commandId = command.id as string
    await markWorkstreamDeleting(client, workstreamId, now())
  } finally {
    client.release()
  }
  sendJson(res, 202, { commandId, state: 'accepted', acceptedAt: now().toISOString() })
}

// ---------- Sessions (Workstream-scoped) ----------

async function handleOpenSession(deps: ServerDeps, principal: string, workstreamId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const idempotencyKey = requireIdempotencyKey(req)
  if (!idempotencyKey) return sendProblem(res, problem(400, 'validation_failed', 'Idempotency-Key header is required (8-200 chars)'))
  const role = await requireMembership(deps.pool, workstreamId, principal)
  if (!role) return sendProblem(res, problem(404, 'workstream_not_found', 'Workstream not found'))
  if (!canMutate(role)) return sendProblem(res, problem(403, 'validation_failed', 'Viewers cannot open a Session'))

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    return sendProblem(res, problem(400, 'validation_failed', 'request body is not valid JSON'))
  }
  const validators = await getValidators()
  if (!validators.openSession(body)) {
    return sendProblem(res, problem(400, 'validation_failed', 'request body failed schema validation', JSON.stringify(validators.openSession.errors)))
  }
  const request = body as { agentId: string; workspace: { workspaceRef: string }; equipment: Record<string, unknown>; activate: boolean }

  const agent = await resolveLaunchableAgent(deps, request.agentId)
  if (!agent) return sendProblem(res, problem(409, 'agent_unavailable', `Agent '${request.agentId}' is not launchable`))

  const now = deps.now ?? (() => new Date())
  const client = await deps.pool.connect()
  let commandId: string
  try {
    const command = await createOrReuseCommand(client, {
      type: 'OpenSession',
      workstreamId: workstreamId as never,
      actor: { kind: 'human', id: principal as never },
      idempotencyScope: 'open-session',
      idempotencyKey,
      acceptedAt: now(),
      request: request as unknown as Record<string, unknown>,
    })
    commandId = command.id as string
  } finally {
    client.release()
  }

  let sessionId: string
  if (request.activate) {
    // docs/specs/06 "Choosing a target Session": may resolve to an EXISTING anchored Session for
    // this Agent rather than a freshly created one — switchAgent owns that decision, the missing
    // range computation, and (if non-empty) the Handoff dispatch.
    const result = await switchAgent({
      pool: deps.pool,
      transport: deps.controllerTransport,
      brokerGrantClient: deps.brokerGrantClient,
      connections: deps.connections,
      workstreamId,
      agentId: request.agentId,
      runtimeDefinitionVersion: agent.runtimeDefinitionVersion,
      workspaceMountRef: request.workspace.workspaceRef,
      equipmentRequest: request.equipment,
      actor: { kind: 'human', id: principal },
      idempotencyKey,
      now,
    })
    if (!result.ok) return sendProblem(res, problem(409, result.code, 'Agent could not be activated', result.detail))
    sessionId = result.sessionId
  } else {
    sessionId = randomUUID()
    const openClient = await deps.pool.connect()
    try {
      await openAdditionalSession(openClient, {
        id: sessionId,
        workstreamId,
        launchEnvelope: {
          agentId: request.agentId,
          workspaceSpec: { workspaceRef: request.workspace.workspaceRef },
          equipmentRequest: request.equipment as never,
          runtimeDefinitionVersion: agent.runtimeDefinitionVersion,
        },
        runtimeDefinitionVersion: agent.runtimeDefinitionVersion,
        createdAt: now(),
        activate: false,
      })
    } finally {
      openClient.release()
    }
  }

  const sessionClient = await deps.pool.connect()
  let sessionWire
  try {
    sessionWire = await getSession(sessionClient, sessionId)
  } finally {
    sessionClient.release()
  }
  sendJson(res, 202, { command: { commandId, state: 'accepted', acceptedAt: now().toISOString() }, session: sessionWire })
}

// ---------- Items / Turns ----------

async function handleListItems(deps: ServerDeps, principal: string, workstreamId: string, url: URL, res: ServerResponse): Promise<void> {
  const role = await requireMembership(deps.pool, workstreamId, principal)
  if (!role) return sendProblem(res, problem(404, 'workstream_not_found', 'Workstream not found'))
  const beforeSeqParam = url.searchParams.get('beforeSeq')
  const limitParam = url.searchParams.get('limit')
  const client = await deps.pool.connect()
  try {
    const page = await listWorkstreamItemsPage(client, workstreamId, {
      limit: limitParam ? Math.min(200, Math.max(1, Number(limitParam))) : 100,
      ...(beforeSeqParam ? { beforeSeq: Number(beforeSeqParam) } : {}),
    })
    sendJson(res, 200, page)
  } finally {
    client.release()
  }
}

async function handleListTurns(deps: ServerDeps, principal: string, workstreamId: string, url: URL, res: ServerResponse): Promise<void> {
  const role = await requireMembership(deps.pool, workstreamId, principal)
  if (!role) return sendProblem(res, problem(404, 'workstream_not_found', 'Workstream not found'))
  const beforeSeqParam = url.searchParams.get('beforeSeq')
  const limitParam = url.searchParams.get('limit')
  const client = await deps.pool.connect()
  try {
    const page = await listWorkstreamTurnsPage(client, workstreamId, {
      limit: limitParam ? Math.min(200, Math.max(1, Number(limitParam))) : 100,
      ...(beforeSeqParam ? { beforeSeq: Number(beforeSeqParam) } : {}),
    })
    sendJson(res, 200, page)
  } finally {
    client.release()
  }
}

// ---------- Memberships (owner-only) ----------

async function handleListMemberships(deps: ServerDeps, principal: string, workstreamId: string, res: ServerResponse): Promise<void> {
  const role = await requireMembership(deps.pool, workstreamId, principal)
  if (!role) return sendProblem(res, problem(404, 'workstream_not_found', 'Workstream not found'))
  if (role !== 'owner') return sendProblem(res, problem(403, 'validation_failed', 'Only owners can list memberships'))
  const client = await deps.pool.connect()
  try {
    const items = await listWorkstreamMembershipsWire(client, workstreamId)
    sendJson(res, 200, { items })
  } finally {
    client.release()
  }
}

async function handlePutMembership(
  deps: ServerDeps,
  principal: string,
  workstreamId: string,
  targetPrincipalId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const idempotencyKey = requireIdempotencyKey(req)
  if (!idempotencyKey) return sendProblem(res, problem(400, 'validation_failed', 'Idempotency-Key header is required (8-200 chars)'))
  const role = await requireMembership(deps.pool, workstreamId, principal)
  if (!role) return sendProblem(res, problem(404, 'workstream_not_found', 'Workstream not found'))
  if (role !== 'owner') return sendProblem(res, problem(403, 'validation_failed', 'Only owners can manage memberships'))

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    return sendProblem(res, problem(400, 'validation_failed', 'request body is not valid JSON'))
  }
  const validators = await getValidators()
  if (!validators.membershipPut(body)) {
    return sendProblem(res, problem(400, 'validation_failed', 'request body failed schema validation', JSON.stringify(validators.membershipPut.errors)))
  }
  const { role: newRole } = body as { role: WorkstreamRole }
  const now = deps.now ?? (() => new Date())

  const client = await deps.pool.connect()
  try {
    await putWorkstreamMembership(client, workstreamId, principalId(targetPrincipalId), newRole, now())
    const memberships = await listWorkstreamMembershipsWire(client, workstreamId)
    const membership = memberships.find((m) => m.principalId === targetPrincipalId)
    if (!membership) throw new Error('unreachable: just upserted')
    sendJson(res, 200, membership)
  } catch (error) {
    if (error instanceof DomainError) return sendProblem(res, domainErrorToProblem(error))
    throw error
  } finally {
    client.release()
  }
}

async function handleDeleteMembership(
  deps: ServerDeps,
  principal: string,
  workstreamId: string,
  targetPrincipalId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const idempotencyKey = requireIdempotencyKey(req)
  if (!idempotencyKey) return sendProblem(res, problem(400, 'validation_failed', 'Idempotency-Key header is required (8-200 chars)'))
  const role = await requireMembership(deps.pool, workstreamId, principal)
  if (!role) return sendProblem(res, problem(404, 'workstream_not_found', 'Workstream not found'))
  if (role !== 'owner') return sendProblem(res, problem(403, 'validation_failed', 'Only owners can manage memberships'))

  const client = await deps.pool.connect()
  try {
    await removeWorkstreamMembership(client, workstreamId, principalId(targetPrincipalId))
    sendNoContent(res, 204)
  } catch (error) {
    if (error instanceof DomainError) return sendProblem(res, domainErrorToProblem(error))
    if (error instanceof Error && error.message.includes('workstream_membership_not_found')) return sendNoContent(res, 204)
    throw error
  } finally {
    client.release()
  }
}

// ---------- Commands / Agents / Equipment ----------

async function handleGetCommand(deps: ServerDeps, principal: string, commandId: string, res: ServerResponse): Promise<void> {
  const client = await deps.pool.connect()
  try {
    const command = await getCommand(client, commandId)
    if (!command) return sendProblem(res, problem(404, 'workstream_not_found', 'Command not found'))
    const role = await getMembershipRole(client, command.workstreamId, principal)
    if (!role) return sendProblem(res, problem(404, 'workstream_not_found', 'Command not found'))
    sendJson(res, 200, command)
  } finally {
    client.release()
  }
}

async function handleListAgents(deps: ServerDeps, res: ServerResponse): Promise<void> {
  const result = await listLaunchableAgents(deps.controllerTransport)
  sendJson(res, 200, { items: result.items.map((a) => ({ agentId: a.agentId, runtimeDefinitionVersion: a.runtimeDefinitionVersion, label: a.label, description: a.description, availability: a.availability })) })
}

/**
 * P11: was a hard-coded `{ version: 'fake-no-broker-v1', resources: [] }` predating the Broker
 * (ADR 0010/P08 shipped it long ago; this stub was never updated) — a real Workstream create,
 * whose own `equipment.catalogueVersion` this response is supposed to inform, then fails Broker
 * grant issuance's own strict version check (`@agora/equipment-policy`'s `resolveEquipmentPolicy`)
 * against whatever the CLIENT happened to hard-code. Same package the Broker itself already uses
 * — this response is now the SAME catalogue the Broker will actually check against.
 */
function handleEquipmentCatalogue(res: ServerResponse): void {
  sendJson(res, 200, getEquipmentCatalogue())
}

// ---------- Sessions ----------

async function handleGetSession(deps: ServerDeps, principal: string, sessionId: string, url: URL, res: ServerResponse): Promise<void> {
  const client = await deps.pool.connect()
  let session
  try {
    session = await getSession(client, sessionId)
  } finally {
    client.release()
  }
  if (!session) return sendProblem(res, problem(404, 'session_not_found', 'Session not found'))
  const role = await requireMembership(deps.pool, session.workstreamId, principal)
  if (!role) return sendProblem(res, problem(404, 'session_not_found', 'Session not found'))

  if (url.searchParams.get('includeLive') === 'true') {
    try {
      const live = await getSessionRuntime(deps.controllerTransport, sessionId as never)
      sendJson(res, 200, { ...session, liveSessionRuntime: { state: live.state, ...(live.podUid ? { podUid: live.podUid } : {}) } })
      return
    } catch {
      sendJson(res, 200, session)
      return
    }
  }
  sendJson(res, 200, session)
}

async function loadSessionAndRole(
  deps: ServerDeps,
  principal: string,
  sessionId: string,
): Promise<{ readonly session: NonNullable<Awaited<ReturnType<typeof getSession>>>; readonly role: WorkstreamRole } | undefined> {
  const client = await deps.pool.connect()
  let session
  try {
    session = await getSession(client, sessionId)
  } finally {
    client.release()
  }
  if (!session) return undefined
  const role = await requireMembership(deps.pool, session.workstreamId, principal)
  if (!role) return undefined
  return { session, role }
}

async function handleActivateSession(deps: ServerDeps, principal: string, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const idempotencyKey = requireIdempotencyKey(req)
  if (!idempotencyKey) return sendProblem(res, problem(400, 'validation_failed', 'Idempotency-Key header is required (8-200 chars)'))
  const loaded = await loadSessionAndRole(deps, principal, sessionId)
  if (!loaded) return sendProblem(res, problem(404, 'session_not_found', 'Session not found'))
  if (!canMutate(loaded.role)) return sendProblem(res, problem(403, 'validation_failed', 'Viewers cannot activate a Session'))

  // docs/specs/02: Agent version is frozen at Session creation — activate/resume MUST reuse the
  // Session's own recorded `runtimeDefinitionVersion`, never silently upgrade to whatever the
  // registry currently resolves to (that would launch a Pod the Session was never bound to).
  const now = deps.now ?? (() => new Date())
  const workspaceClient = await deps.pool.connect()
  let workspaceMountRef: string | undefined
  try {
    workspaceMountRef = await getSessionWorkspaceMountRef(workspaceClient, sessionId)
  } finally {
    workspaceClient.release()
  }
  if (!workspaceMountRef) {
    return sendProblem(res, problem(500, 'validation_failed', 'Session has no recorded workspace reference'))
  }
  const result = await activateSession({
    pool: deps.pool,
    transport: deps.controllerTransport,
    brokerGrantClient: deps.brokerGrantClient,
    connections: deps.connections,
    workstreamId: loaded.session.workstreamId,
    sessionId,
    agentId: loaded.session.agentId,
    runtimeDefinitionVersion: loaded.session.runtimeDefinitionVersion,
    workspaceMountRef,
    actor: { kind: 'human', id: principal },
  })
  if (!result.ok) return sendProblem(res, problem(409, result.code, 'Session cannot be activated', result.detail))
  sendJson(res, 202, { commandId: randomUUID(), state: 'accepted', acceptedAt: now().toISOString() })
}

async function handlePromptSession(deps: ServerDeps, principal: string, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const idempotencyKey = requireIdempotencyKey(req)
  if (!idempotencyKey) return sendProblem(res, problem(400, 'validation_failed', 'Idempotency-Key header is required (8-200 chars)'))
  const loaded = await loadSessionAndRole(deps, principal, sessionId)
  if (!loaded) return sendProblem(res, problem(404, 'session_not_found', 'Session not found'))
  if (!canMutate(loaded.role)) return sendProblem(res, problem(403, 'validation_failed', 'Viewers cannot prompt a Session'))
  if (!loaded.session.current) return sendProblem(res, problem(409, 'session_not_current', 'Session is not the current Session for its Workstream'))

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    return sendProblem(res, problem(400, 'validation_failed', 'request body is not valid JSON'))
  }
  const validators = await getValidators()
  if (!validators.promptRequest(body)) {
    return sendProblem(res, problem(400, 'validation_failed', 'request body failed schema validation', JSON.stringify(validators.promptRequest.errors)))
  }
  const live = deps.connections.get(sessionId)
  if (!live) return sendProblem(res, problem(409, 'runtime_unavailable', 'Session has no live ACP connection'))

  const now = deps.now ?? (() => new Date())
  const result = await promptSession({
    pool: deps.pool,
    workstreamId: loaded.session.workstreamId,
    sessionId,
    connection: live.connection,
    storePersist: live.storePersist,
    acpSessionId: live.acpSessionId,
    prompt: (body as { content: never[] }).content,
    purpose: 'user',
    actor: { kind: 'human', id: principal },
    idempotencyKey,
    now,
  })
  if (result.outcome === 'unknown') return sendProblem(res, problem(202, 'prompt_delivery_unknown', 'Prompt delivery is unknown'))
  sendJson(res, 202, { commandId: randomUUID(), state: 'accepted', acceptedAt: now().toISOString() })
}

async function handleSuspendSession(deps: ServerDeps, principal: string, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const idempotencyKey = requireIdempotencyKey(req)
  if (!idempotencyKey) return sendProblem(res, problem(400, 'validation_failed', 'Idempotency-Key header is required (8-200 chars)'))
  const loaded = await loadSessionAndRole(deps, principal, sessionId)
  if (!loaded) return sendProblem(res, problem(404, 'session_not_found', 'Session not found'))
  if (!canMutate(loaded.role)) return sendProblem(res, problem(403, 'validation_failed', 'Viewers cannot suspend a Session'))

  const now = deps.now ?? (() => new Date())
  void suspendSession({ pool: deps.pool, transport: deps.controllerTransport, connections: deps.connections, sessionId, idempotencyKey, now })
  sendJson(res, 202, { commandId: randomUUID(), state: 'accepted', acceptedAt: now().toISOString() })
}

async function handleCancelSession(deps: ServerDeps, principal: string, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const idempotencyKey = requireIdempotencyKey(req)
  if (!idempotencyKey) return sendProblem(res, problem(400, 'validation_failed', 'Idempotency-Key header is required (8-200 chars)'))
  const loaded = await loadSessionAndRole(deps, principal, sessionId)
  if (!loaded) return sendProblem(res, problem(404, 'session_not_found', 'Session not found'))
  if (!canMutate(loaded.role)) return sendProblem(res, problem(403, 'validation_failed', 'Viewers cannot cancel a Session'))

  const now = deps.now ?? (() => new Date())
  await cancelSessionCommand({ connections: deps.connections, sessionId })
  sendJson(res, 202, { commandId: randomUUID(), state: 'accepted', acceptedAt: now().toISOString() })
}

async function handleCloseSession(deps: ServerDeps, principal: string, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const idempotencyKey = requireIdempotencyKey(req)
  if (!idempotencyKey) return sendProblem(res, problem(400, 'validation_failed', 'Idempotency-Key header is required (8-200 chars)'))
  const loaded = await loadSessionAndRole(deps, principal, sessionId)
  if (!loaded) return sendProblem(res, problem(404, 'session_not_found', 'Session not found'))
  if (!canMutate(loaded.role)) return sendProblem(res, problem(403, 'validation_failed', 'Viewers cannot close a Session'))

  const now = deps.now ?? (() => new Date())
  void closeSession({ pool: deps.pool, transport: deps.controllerTransport, connections: deps.connections, sessionId, now })
  sendJson(res, 202, { commandId: randomUUID(), state: 'accepted', acceptedAt: now().toISOString() })
}

// ---------- Feed (resumable SSE) ----------

const FEED_POLL_INTERVAL_MS = 300

async function handleFeed(deps: ServerDeps, principal: string, workstreamId: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const role = await requireMembership(deps.pool, workstreamId, principal)
  if (!role) return sendProblem(res, problem(404, 'workstream_not_found', 'Workstream not found'))

  const afterParam = url.searchParams.get('after')
  let cursor = afterParam ? Number(afterParam) : 0

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  let closed = false
  req.on('close', () => {
    closed = true
  })

  const client = await deps.pool.connect()
  try {
    const { rows: maxRows } = await client.query<{ max: number | null }>('SELECT MAX(position) AS max FROM projection.feed_events WHERE workstream_id = $1', [
      workstreamId,
    ])
    const currentMax = maxRows[0]?.max ?? 0
    if (cursor > currentMax) {
      res.write(
        `data: ${JSON.stringify({ workstreamId, position: currentMax, throughWorkstreamSeq: 0, operation: 'reset', payload: { reason: 'retention_gap', refetch: true } })}\n\n`,
      )
      cursor = currentMax
    }

    while (!closed) {
      const { rows } = await client.query<{
        position: number
        through_workstream_seq: number
        operation: string
        payload: Record<string, unknown>
      }>(
        `SELECT position, through_workstream_seq, operation, payload FROM projection.feed_events
         WHERE workstream_id = $1 AND position > $2 ORDER BY position ASC LIMIT 200`,
        [workstreamId, cursor],
      )
      for (const row of rows) {
        if (closed) break
        res.write(
          `data: ${JSON.stringify({
            workstreamId,
            position: row.position,
            throughWorkstreamSeq: row.through_workstream_seq,
            operation: row.operation,
            payload: row.payload,
          })}\n\n`,
        )
        cursor = row.position
      }
      if (closed) break
      await sleep(FEED_POLL_INTERVAL_MS)
    }
  } finally {
    client.release()
    if (!res.writableEnded) res.end()
  }
}

// ---------- Static assets (the Web UI shell — public, unauthenticated: the page loads freely,
// only the API calls it makes from the browser carry the Authorization header) ----------

const PUBLIC_DIR = new URL('../../public/', import.meta.url)
const CLIENT_DIR = new URL('../client/', import.meta.url)

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

async function sendStaticFile(res: ServerResponse, base: URL, relativePath: string): Promise<boolean> {
  if (relativePath.includes('..')) return false
  const ext = relativePath.slice(relativePath.lastIndexOf('.'))
  const contentType = CONTENT_TYPES[ext]
  if (!contentType) return false
  try {
    const body = await readFile(new URL(relativePath, base))
    res.writeHead(200, { 'content-type': contentType })
    res.end(body)
    return true
  } catch {
    return false
  }
}

async function handleStaticAsset(path: string, res: ServerResponse): Promise<boolean> {
  if (path === '/') return sendStaticFile(res, PUBLIC_DIR, 'index.html')
  if (path === '/styles.css') return sendStaticFile(res, PUBLIC_DIR, 'styles.css')
  if (path.startsWith('/client/')) return sendStaticFile(res, CLIENT_DIR, path.slice('/client/'.length))
  return false
}

// ---------- Router ----------

const WORKSTREAMS_PATH = /^\/v1\/workstreams$/
const WORKSTREAM_PATH = /^\/v1\/workstreams\/([^/]+)$/
const WORKSTREAM_SESSIONS_PATH = /^\/v1\/workstreams\/([^/]+)\/sessions$/
const WORKSTREAM_FEED_PATH = /^\/v1\/workstreams\/([^/]+)\/feed$/
const WORKSTREAM_ITEMS_PATH = /^\/v1\/workstreams\/([^/]+)\/items$/
const WORKSTREAM_TURNS_PATH = /^\/v1\/workstreams\/([^/]+)\/turns$/
const WORKSTREAM_MEMBERSHIPS_PATH = /^\/v1\/workstreams\/([^/]+)\/memberships$/
const WORKSTREAM_MEMBERSHIP_PATH = /^\/v1\/workstreams\/([^/]+)\/memberships\/([^/]+)$/
const COMMAND_PATH = /^\/v1\/commands\/([^/]+)$/
const AGENTS_PATH = /^\/v1\/agents$/
const EQUIPMENT_CATALOGUE_PATH = /^\/v1\/equipment-catalogue$/
const SESSION_PATH = /^\/v1\/sessions\/([^/]+)$/
const SESSION_ACTIVATE_PATH = /^\/v1\/sessions\/([^/]+)\/activate$/
const SESSION_PROMPTS_PATH = /^\/v1\/sessions\/([^/]+)\/prompts$/
const SESSION_SUSPEND_PATH = /^\/v1\/sessions\/([^/]+)\/suspend$/
const SESSION_CANCEL_PATH = /^\/v1\/sessions\/([^/]+)\/cancel$/
const SESSION_CLOSE_PATH = /^\/v1\/sessions\/([^/]+)\/close$/

async function route(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal')
  const method = req.method ?? 'GET'
  const path = url.pathname

  if (method === 'GET' && !path.startsWith('/v1/')) {
    if (await handleStaticAsset(path, res)) return
  }

  if (path === '/v1/agents' && method === 'GET') return handleListAgents(deps, res)
  if (AGENTS_PATH.test(path) && method !== 'GET') return sendProblem(res, problem(405, 'validation_failed', 'method not allowed'))
  if (EQUIPMENT_CATALOGUE_PATH.test(path) && method === 'GET') return handleEquipmentCatalogue(res)

  const principal = requirePrincipal(req)
  if (!principal) return sendProblem(res, problem(401, 'validation_failed', 'a valid Authorization: Bearer <principal> header is required'))

  if (WORKSTREAMS_PATH.test(path)) {
    if (method === 'GET') return handleListWorkstreams(deps, principal, url, res)
    if (method === 'POST') return handleCreateWorkstream(deps, principal, req, res)
  }

  const workstreamMembershipMatch = WORKSTREAM_MEMBERSHIP_PATH.exec(path)
  if (workstreamMembershipMatch?.[1] && workstreamMembershipMatch[2]) {
    const workstreamId = workstreamMembershipMatch[1]
    const targetPrincipal = decodeURIComponent(workstreamMembershipMatch[2])
    if (method === 'PUT') return handlePutMembership(deps, principal, workstreamId, targetPrincipal, req, res)
    if (method === 'DELETE') return handleDeleteMembership(deps, principal, workstreamId, targetPrincipal, req, res)
  }

  const workstreamMembershipsMatch = WORKSTREAM_MEMBERSHIPS_PATH.exec(path)
  if (workstreamMembershipsMatch?.[1] && method === 'GET') return handleListMemberships(deps, principal, workstreamMembershipsMatch[1], res)

  const feedMatch = WORKSTREAM_FEED_PATH.exec(path)
  if (feedMatch?.[1] && method === 'GET') return handleFeed(deps, principal, feedMatch[1], url, req, res)

  const itemsMatch = WORKSTREAM_ITEMS_PATH.exec(path)
  if (itemsMatch?.[1] && method === 'GET') return handleListItems(deps, principal, itemsMatch[1], url, res)

  const turnsMatch = WORKSTREAM_TURNS_PATH.exec(path)
  if (turnsMatch?.[1] && method === 'GET') return handleListTurns(deps, principal, turnsMatch[1], url, res)

  const sessionsMatch = WORKSTREAM_SESSIONS_PATH.exec(path)
  if (sessionsMatch?.[1] && method === 'POST') return handleOpenSession(deps, principal, sessionsMatch[1], req, res)

  const workstreamMatch = WORKSTREAM_PATH.exec(path)
  if (workstreamMatch?.[1]) {
    if (method === 'GET') return handleGetWorkstream(deps, principal, workstreamMatch[1], res)
    if (method === 'PATCH') return handlePatchWorkstream(deps, principal, workstreamMatch[1], req, res)
    if (method === 'DELETE') return handleDeleteWorkstream(deps, principal, workstreamMatch[1], req, res)
  }

  const commandMatch = COMMAND_PATH.exec(path)
  if (commandMatch?.[1] && method === 'GET') return handleGetCommand(deps, principal, commandMatch[1], res)

  const activateMatch = SESSION_ACTIVATE_PATH.exec(path)
  if (activateMatch?.[1] && method === 'POST') return handleActivateSession(deps, principal, activateMatch[1], req, res)

  const promptsMatch = SESSION_PROMPTS_PATH.exec(path)
  if (promptsMatch?.[1] && method === 'POST') return handlePromptSession(deps, principal, promptsMatch[1], req, res)

  const suspendMatch = SESSION_SUSPEND_PATH.exec(path)
  if (suspendMatch?.[1] && method === 'POST') return handleSuspendSession(deps, principal, suspendMatch[1], req, res)

  const cancelMatch = SESSION_CANCEL_PATH.exec(path)
  if (cancelMatch?.[1] && method === 'POST') return handleCancelSession(deps, principal, cancelMatch[1], req, res)

  const closeMatch = SESSION_CLOSE_PATH.exec(path)
  if (closeMatch?.[1] && method === 'POST') return handleCloseSession(deps, principal, closeMatch[1], req, res)

  const sessionMatch = SESSION_PATH.exec(path)
  if (sessionMatch?.[1] && method === 'GET') return handleGetSession(deps, principal, sessionMatch[1], url, res)

  return sendProblem(res, problem(404, 'workstream_not_found', 'no such route'))
}

export function createServer(deps: ServerDeps): Server {
  return createHttpServer((req, res) => {
    void route(deps, req, res).catch((error: unknown) => {
      if (error instanceof DomainError) return sendProblem(res, domainErrorToProblem(error))
      if (error instanceof HandoffNotReadyError) {
        return sendProblem(
          res,
          problem(409, 'handoff_not_ready', 'the projector has not yet caught up to the Handoff source range; retry shortly', error.message),
        )
      }
      if (!res.headersSent) sendProblem(res, problem(500, 'validation_failed', 'unexpected error', error instanceof Error ? error.message : String(error)))
    })
  })
}
