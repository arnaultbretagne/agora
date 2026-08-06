import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { EquipmentRequest } from '@agora/domain'
import { EQUIPMENT_POLICY_VERSION, type PolicyContext, resolveEquipmentPolicy, sha256Hex } from '@agora/equipment-policy'
import { activateGrant as activateGrantRow, ActivationConflictError, getActivationByGrant } from './activations-repository.js'
import { recordAudit } from './audit.js'
import {
  getGrant,
  getGrantBySession,
  GrantConflictError,
  issueGrant as issueGrantRow,
  listActiveGrants,
  renewGrant as renewGrantRow,
  revokeGrant as revokeGrantRow,
} from './grants-repository.js'
import { markOnecliAgentDeleted, ensureOnecliAgentMapping, storeUpstreamAuthority } from './onecli-agents-repository.js'
import { OneCliUnavailableError, type OneCliControlAdapter, type OneCliCredentialStub } from './onecli-adapter.js'
import { compileRoutePolicy } from './route-policy.js'
import type { ExecutionGrant } from './grants-repository.js'
import type { GrantActivation } from './activations-repository.js'

/** Operator-managed, fixed across every Session (relay-bundle.ts's identical concept on the
 * Session Runtime controller side) — what a healthy OneCLI Agent's container config MUST match. */
export interface ExpectedRuntimeBundle {
  readonly caCertificate: string
  readonly credentialStubs: readonly OneCliCredentialStub[]
}

export interface GrantServiceDeps {
  readonly onecli: OneCliControlAdapter
  readonly encryptionKey: Buffer
  readonly expectedRuntimeBundle: ExpectedRuntimeBundle
}

export class RuntimeBundleDriftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeBundleDriftError'
  }
}

const JWT_LIKE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/

/**
 * Found live, P11: OneCLI re-signs an otherwise byte-identical id_token per Agent — verified live
 * that two different OneCLI Agents' own `codex-auth-json` stub decode to the EXACT same claims
 * (sub/email/exp/iat/the whole openai.auth block), only the JWT's signature segment differs. A
 * raw byte compare can therefore never match two different, freshly-created per-session Agents
 * even when they carry the identical underlying account identity — drop just the signature
 * (header.payload survives) before comparing, so genuine drift (a different account, a tampered
 * claim) still trips this, but expected per-Agent re-signing no longer does.
 */
function normalizeJwtLike(value: string): string {
  return JWT_LIKE_RE.test(value) ? value.split('.').slice(0, 2).join('.') : value
}

/**
 * Found live, P11, right after the JWT-signature fix alone still didn't stop the false-positive
 * drift: `getContainerConfig`'s own JSON stub carries a `last_refresh` timestamp that changes on
 * EVERY call, for the SAME Agent, not just across different Agents (verified live: two successive
 * calls one second apart, same agent, two different `last_refresh` values). It's an operational
 * bookkeeping field, not an identity claim — drop it wherever it appears, same best-effort spirit
 * as stripping a JWT signature. `access_token`/`refresh_token`/`account_id` were checked live too
 * and are genuinely stable per Agent, so they're deliberately left alone (real drift there should
 * still trip this check).
 */
const VOLATILE_STUB_KEYS = new Set(['last_refresh'])

function normalizeStubContent(content: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return normalizeJwtLike(content)
  }
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return normalizeJwtLike(value)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([k]) => !VOLATILE_STUB_KEYS.has(k)).map(([k, v]) => [k, walk(v)]))
    }
    return value
  }
  return JSON.stringify(walk(parsed))
}

function stubsMatch(actual: readonly OneCliCredentialStub[], expected: readonly OneCliCredentialStub[]): boolean {
  if (actual.length !== expected.length) return false
  const normalize = (stubs: readonly OneCliCredentialStub[]) =>
    [...stubs].map((s) => `${s.containerPath} ${normalizeStubContent(s.content)}`).sort()
  const a = normalize(actual)
  const b = normalize(expected)
  return a.every((value, index) => value === b[index])
}

export interface IssueGrantRequest {
  readonly sessionId: string
  readonly agentId: string
  readonly principalId: string
  readonly workstreamCategory: 'discussion' | 'invocation'
  readonly runtimeDefinitionVersion: string
  readonly equipment: EquipmentRequest
  readonly requestId: string
}

const GRANT_TTL_MS = 30 * 60 * 1000
const ACTIVATION_TTL_MS = 30 * 60 * 1000

/**
 * Found live, P11: OneCLI's own real API rejects an underscore ("Identifier must be 1-50
 * characters, start with a letter or number, and contain only lowercase letters, numbers, and
 * hyphens") — this format was never valid against the real OneCLI, only the fake test adapter,
 * which doesn't enforce the same validation. Hyphen, not underscore.
 */
function onecliIdentifierFor(sessionId: string): string {
  return `sagt-${sha256Hex(sessionId).slice(0, 40)}`
}

/**
 * docs/specs/12 "grant issue/deny/revoke counts": every denial this function's own body can throw
 * (policy resolution, OneCLI outage, runtime-bundle drift, publish ambiguity) is audited as
 * `execution_grant.issue`/`denied` before propagating — a `GrantConflictError` is NOT a denial (the
 * Session already legitimately holds a distinct grant; nothing new was evaluated) so it is
 * deliberately excluded and re-thrown as-is.
 */
export async function issueExecutionGrant(client: PoolClient, deps: GrantServiceDeps, request: IssueGrantRequest, now: Date): Promise<ExecutionGrant> {
  try {
    return await doIssueExecutionGrant(client, deps, request, now)
  } catch (error) {
    if (error instanceof GrantConflictError) throw error
    if (error instanceof Error) {
      await recordAudit(client, {
        id: randomUUID(),
        actorKind: 'service',
        actorId: request.principalId,
        sessionId: request.sessionId,
        actionClass: 'execution_grant.issue',
        decision: 'denied',
        policyVersion: null,
        detail: { code: error.name },
        createdAt: now,
      })
    }
    throw error
  }
}

/**
 * docs/specs/10 "Execution grant" + "Route-policy compilation", end to end: resolve policy (pure,
 * no OneCLI dependency, throws PolicyDenialError before any mutation), THEN mutate OneCLI (ensure
 * the Session's dedicated selective Agent, pull its container config to capture the upstream
 * bearer into encrypted Broker-private state, recompile and republish the project-wide route
 * policy over ALL active grants), THEN persist the grant row. Idempotent by (sessionId,
 * requestId) — `issueGrantRow` itself enforces that; a retry after a partial OneCLI-side failure
 * re-runs the OneCLI steps (they are themselves idempotent) and then succeeds at the DB step.
 */
async function doIssueExecutionGrant(client: PoolClient, deps: GrantServiceDeps, request: IssueGrantRequest, now: Date): Promise<ExecutionGrant> {
  const context: PolicyContext = {
    principalId: request.principalId,
    workstreamCategory: request.workstreamCategory,
    agentId: request.agentId,
    runtimeDefinitionVersion: request.runtimeDefinitionVersion,
  }
  // Pure, no side effects — a PolicyDenialError here means NO OneCLI call has happened yet.
  const resolved = resolveEquipmentPolicy(request.equipment, context)

  const existing = await getGrantBySession(client, request.sessionId)
  if (existing && existing.requestId === request.requestId) return existing

  const onecliIdentifier = onecliIdentifierFor(request.sessionId)
  await deps.onecli.ensureSelectiveAgent(onecliIdentifier, `agora-session-${request.sessionId}`)
  await ensureOnecliAgentMapping(client, request.sessionId, onecliIdentifier, now)

  const containerConfig = await deps.onecli.getContainerConfig(onecliIdentifier)
  // docs/specs/10: "Verify returned CA/stub material against P04's operator-managed runtime bundle
  // and fail closed on drift; do not add it to the activation response." — the Pod's own bundle
  // (relay-bundle.ts) is fixed and operator-managed, never sourced per-Session from this response;
  // this call's ONLY job is to confirm OneCLI has not silently drifted from it before this Session's
  // upstream bearer is trusted at all.
  if (
    containerConfig.caCertificate !== deps.expectedRuntimeBundle.caCertificate ||
    !stubsMatch(containerConfig.credentialStubs, deps.expectedRuntimeBundle.credentialStubs)
  ) {
    throw new RuntimeBundleDriftError(
      `OneCLI Agent ${onecliIdentifier}'s container config does not match the operator-pinned runtime bundle — refusing to issue`,
    )
  }
  await storeUpstreamAuthority(client, deps.encryptionKey, request.sessionId, containerConfig.upstreamBearer, containerConfig.gatewayUrl, now)

  const grantId = randomUUID()
  const activeGrants = await listActiveGrants(client, now)
  const prospective = [...activeGrants, { id: grantId, agentId: request.agentId, onecliIdentifier, capabilities: resolved.capabilities }]
  const compiled = compileRoutePolicy(prospective)
  const published = await deps.onecli.publishRoutePolicy(compiled.routes)
  // onecli-adapter.ts's own doc: "the compiler's own publish-then-verify step (docs/specs/10
  // 'verify post-publication ordering/effective state')" — a publish this Broker cannot confirm
  // took effect must not be trusted to protect a brand-new grant.
  const effectiveGeneration = await deps.onecli.getPublishedGeneration()
  if (effectiveGeneration !== published.generation) {
    throw new OneCliUnavailableError(
      `route policy publish for session ${request.sessionId} is ambiguous: published generation ${published.generation} but effective generation reads back as ${String(effectiveGeneration)}`,
    )
  }

  const grant = await issueGrantRow(client, {
    id: grantId,
    sessionId: request.sessionId,
    agentId: request.agentId,
    principalId: request.principalId,
    workstreamCategory: request.workstreamCategory,
    policyVersion: resolved.policyVersion,
    capabilityDigest: resolved.capabilityDigest,
    capabilities: resolved.capabilities,
    mcpServers: resolved.mcpServers,
    onecliIdentifier,
    requestId: request.requestId,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + GRANT_TTL_MS),
  })

  await recordAudit(client, {
    id: randomUUID(),
    actorKind: 'service',
    actorId: request.principalId,
    sessionId: request.sessionId,
    actionClass: 'execution_grant.issue',
    decision: 'approved',
    policyVersion: resolved.policyVersion,
    detail: { grantId: grant.id, capabilityCount: resolved.capabilities.length, routeSetVersion: compiled.routeSetVersion },
    createdAt: now,
  })

  return grant
}

export interface ActivateGrantRequest {
  readonly grantRef: string
  readonly sessionId: string
  readonly agentId: string
  readonly workloadIdentity: string
  readonly requestId: string
}

/**
 * "grantRef" (docs/specs/10 "exposes one transient activation reference") is the grant's own id —
 * opaque to the Browser/Controller caller (it is never combined with a bearer), but this function
 * still requires it match the grant it claims to activate, so a stale/forged ref cannot bind an
 * unrelated grant. Every denial is audited as `execution_grant.activate`/`denied` (docs/specs/12
 * "grant issue/deny/revoke counts"), EXCEPT `ActivationConflictError` — a different workload
 * failing to rebind an already-bound grant is the binding invariant working as designed, not a
 * denial of intent.
 */
export async function activateExecutionGrant(client: PoolClient, request: ActivateGrantRequest, now: Date): Promise<GrantActivation> {
  try {
    return await doActivateExecutionGrant(client, request, now)
  } catch (error) {
    if (error instanceof ActivationConflictError) throw error
    if (error instanceof Error) {
      await recordAudit(client, {
        id: randomUUID(),
        actorKind: 'service',
        actorId: request.workloadIdentity,
        sessionId: request.sessionId,
        actionClass: 'execution_grant.activate',
        decision: 'denied',
        policyVersion: null,
        detail: { grantId: request.grantRef, code: error.name },
        createdAt: now,
      })
    }
    throw error
  }
}

async function doActivateExecutionGrant(client: PoolClient, request: ActivateGrantRequest, now: Date): Promise<GrantActivation> {
  const grant = await getGrant(client, request.grantRef)
  if (!grant || grant.sessionId !== request.sessionId || grant.agentId !== request.agentId) {
    throw new Error(`no matching issued grant for session ${request.sessionId}/${request.agentId}`)
  }
  if (grant.state !== 'issued' || grant.expiresAt <= now) {
    throw new Error(`grant ${grant.id} is not activatable (state=${grant.state}, expiresAt=${grant.expiresAt.toISOString()})`)
  }

  const activation = await activateGrantRow(client, {
    id: randomUUID(),
    grantId: grant.id,
    sessionId: request.sessionId,
    agentId: request.agentId,
    workloadIdentity: request.workloadIdentity,
    requestId: request.requestId,
    activatedAt: now,
    expiresAt: new Date(Math.min(now.getTime() + ACTIVATION_TTL_MS, grant.expiresAt.getTime())),
  })

  await recordAudit(client, {
    id: randomUUID(),
    actorKind: 'service',
    actorId: request.workloadIdentity,
    sessionId: request.sessionId,
    actionClass: 'execution_grant.activate',
    decision: 'approved',
    policyVersion: grant.policyVersion,
    detail: { grantId: grant.id, activationId: activation.id },
    createdAt: now,
  })

  return activation
}

export async function getActivationForGrant(client: PoolClient, grantId: string): Promise<GrantActivation | undefined> {
  return getActivationByGrant(client, grantId)
}

/**
 * docs/specs/10 "Grant renewal MUST preserve the same capability digest" — `renewGrantRow` itself
 * enforces this against the currently-active policy version (see its own doc comment; the API
 * carries no request body to compare a caller-supplied digest against). docs/specs/10 "Renew:
 * preserve capability digest and rotate/extend private authority" — renewal also rotates the
 * Session's upstream OneCLI bearer behind the SAME binding (same OneCLI Agent, same grant, same
 * activation), shrinking the live window of any single upstream token without ever touching the
 * capability digest, route policy or Agent identity a renewal must leave untouched.
 */
export async function renewExecutionGrant(client: PoolClient, deps: GrantServiceDeps, grantId: string, now: Date): Promise<ExecutionGrant> {
  const renewed = await renewGrantRow(client, grantId, EQUIPMENT_POLICY_VERSION, new Date(now.getTime() + GRANT_TTL_MS))

  await deps.onecli.rotateAgentAuthority(renewed.onecliIdentifier)
  const containerConfig = await deps.onecli.getContainerConfig(renewed.onecliIdentifier)
  if (
    containerConfig.caCertificate !== deps.expectedRuntimeBundle.caCertificate ||
    !stubsMatch(containerConfig.credentialStubs, deps.expectedRuntimeBundle.credentialStubs)
  ) {
    throw new RuntimeBundleDriftError(`OneCLI Agent ${renewed.onecliIdentifier}'s container config does not match the operator-pinned runtime bundle — refusing to renew`)
  }
  await storeUpstreamAuthority(client, deps.encryptionKey, renewed.sessionId, containerConfig.upstreamBearer, containerConfig.gatewayUrl, now)

  await recordAudit(client, {
    id: randomUUID(),
    actorKind: 'service',
    actorId: renewed.principalId,
    sessionId: renewed.sessionId,
    actionClass: 'execution_grant.renew',
    decision: 'approved',
    policyVersion: renewed.policyVersion,
    detail: { grantId: renewed.id },
    createdAt: now,
  })
  return renewed
}

/**
 * docs/specs/10 "revocable" + "Terminal Session/Workstream cleanup deletes it after revocation":
 * revokes the DB row FIRST (so the relay stops trusting it immediately, before any OneCLI round
 * trip), then deletes the OneCLI Agent (terminal — never reused), then republishes the route
 * policy without this grant's contribution. If the OneCLI delete or republish fails, the grant is
 * already revoked and unusable either way — the relay's own revocation check does not depend on
 * OneCLI succeeding.
 */
export async function revokeExecutionGrant(client: PoolClient, deps: GrantServiceDeps, grantId: string, now: Date): Promise<void> {
  const grant = await getGrant(client, grantId)
  if (!grant) return
  await revokeGrantRow(client, grantId, now)
  await markOnecliAgentDeleted(client, grant.sessionId, now)
  await deps.onecli.deleteAgent(grant.onecliIdentifier)

  const activeGrants = await listActiveGrants(client, now)
  const compiled = compileRoutePolicy(activeGrants)
  await deps.onecli.publishRoutePolicy(compiled.routes)

  await recordAudit(client, {
    id: randomUUID(),
    actorKind: 'service',
    actorId: grant.principalId,
    sessionId: grant.sessionId,
    actionClass: 'execution_grant.revoke',
    decision: 'approved',
    policyVersion: grant.policyVersion,
    detail: { grantId: grant.id },
    createdAt: now,
  })
}
