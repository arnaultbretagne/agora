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
  GrantDigestChangedError,
  issueGrant as issueGrantRow,
  renewGrant as renewGrantRow,
  revokeGrant as revokeGrantRow,
} from './grants-repository.js'
import { deleteOnecliAgentMapping, ensureOnecliAgentMapping, storeUpstreamAuthority } from './onecli-agents-repository.js'
import type { AttachedCredentials, OneCliControlAdapter, OneCliCredentialStub } from './onecli-adapter.js'
import { compileSessionCredentialGrants, type DesiredCredentialGrants } from './credential-policy.js'
import { compileSessionEgressAllowList } from './route-policy.js'
import type { ExecutionGrant } from './grants-repository.js'
import type { GrantActivation } from './activations-repository.js'

/**
 * Operator-managed, fixed across every Session (relay-bundle.ts's identical concept on the
 * Session Runtime controller side) — what a healthy OneCLI Agent's container config is checked
 * against.
 *
 * `caCertificate` is matched exactly: it is the trust anchor every Session Runtime Pod pins, and
 * any change to it is drift by definition.
 *
 * `credentialStubs` is the reviewed **superset** of stub material OneCLI may return, not an exact
 * expectation — see `stubsWithinPinnedSet`.
 */
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

/**
 * Found live, P11: a YAML `|` literal block scalar (how the operator-pinned CA is stored,
 * infra-k8s ConfigMaps) always appends a trailing newline; OneCLI's own JSON API response for the
 * live CA does not — 639 vs 638 bytes, verified live, otherwise byte-identical. An exact `!==`
 * treats that as drift on every single grant. Whitespace at the edges was never the security
 * property this check protects; trim it.
 */
function normalizeCa(ca: string): string {
  return ca.trim()
}

/**
 * docs/specs/10: "verify returned CA/stub material against P04's operator-managed runtime bundle
 * and fail closed on drift". The property that check protects is **"OneCLI never returns stub
 * material the operator has not reviewed"**, and that is exactly what this enforces: every stub
 * OneCLI returns must appear, byte-identical after normalization, in the operator-pinned set.
 *
 * It is a subset check rather than set equality since ADR 0015, for a reason grants created:
 * OneCLI's container config is now grants-dependent (verified by reading the real 1.45.0 server
 * bundle — it resolves the Agent's accessible credentials first, and only emits the Codex
 * `auth.json` stub for an Agent that actually holds the OpenAI credential). Under the old
 * `secretMode: all` world every Agent got every credential, so exact equality happened to hold;
 * with real per-Session isolation a Claude Session's Agent legitimately returns NO Codex stub and
 * a Codex Session's Agent returns one. Requiring equality would fail one of them by construction.
 *
 * Nothing is lost by dropping the "a pinned stub must be present" half: absence of a credential is
 * fail-closed by nature, and the presence Agora actually depends on is asserted directly and more
 * precisely against OneCLI's own oracle in `verifyGrantsEffective` below.
 */
function stubsWithinPinnedSet(actual: readonly OneCliCredentialStub[], pinned: readonly OneCliCredentialStub[]): boolean {
  const reviewed = new Set(pinned.map((stub) => `${stub.containerPath} ${normalizeStubContent(stub.content)}`))
  return actual.every((stub) => reviewed.has(`${stub.containerPath} ${normalizeStubContent(stub.content)}`))
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
export async function ensureExecutionGrant(client: PoolClient, deps: GrantServiceDeps, request: IssueGrantRequest, now: Date): Promise<ExecutionGrant> {
  try {
    return await doEnsureExecutionGrant(client, deps, request, now)
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

export class GrantsNotEffectiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrantsNotEffectiveError'
  }
}

/**
 * The grants-effect verification that replaced the retired route-policy publish-then-verify
 * (docs/specs/10 "verify post-publication ordering/effective state"; ADR 0015). Grants take effect
 * immediately on ≥1.44 — there is no generation to compare — so the check is against OneCLI's own
 * ground-truth oracle, `GET /v1/agents/{id}/effective-credentials`, and it is exact in BOTH
 * directions:
 *
 * - every credential Agora attached must come back `usable`, or the Session would start with a
 *   credential it believes it has and does not;
 * - nothing else may come back at all. That is the required upgrade check ("verify each Session
 *   Agent ends with exactly its intended grants, not the whole pool"): the ≥1.44 boot converter
 *   materializes an existing `secretMode: all` Agent's whole pool as explicit grants, and an Agent
 *   that came through that conversion with more than it was issued must never be trusted.
 */
function verifyGrantsEffective(identifier: string, attached: AttachedCredentials, effective: { readonly secrets: readonly { readonly id: string; readonly status: string }[]; readonly connections: readonly { readonly id: string; readonly status: string }[] }): void {
  const compare = (kind: string, intended: readonly string[], actual: readonly { readonly id: string; readonly status: string }[]): void => {
    const usable = actual.filter((entry) => entry.status === 'usable').map((entry) => entry.id).sort()
    const wanted = [...intended].sort()
    const unusable = actual.filter((entry) => entry.status !== 'usable').map((entry) => entry.id)
    if (unusable.length > 0) {
      throw new GrantsNotEffectiveError(`onecli agent ${identifier} reports non-usable ${kind} grant(s) ${unusable.join(', ')} — refusing to issue against a credential set OneCLI will not honor`)
    }
    if (usable.length !== wanted.length || usable.some((id, index) => id !== wanted[index])) {
      throw new GrantsNotEffectiveError(
        `onecli agent ${identifier} effective ${kind} set [${usable.join(', ')}] does not match the intended grant set [${wanted.join(', ')}]`,
      )
    }
  }
  compare('secret', attached.secretIds, effective.secrets)
  compare('connection', attached.connectionIds, effective.connections)
}

/**
 * docs/specs/10 "Execution grant" + "Route-policy compilation" as amended by ADR 0015, end to end:
 * resolve policy (pure, no OneCLI dependency, throws PolicyDenialError before any mutation), THEN
 * mutate OneCLI — ensure the Session's dedicated Agent, attach exactly this Session's resolved
 * credential grants, verify they took effect, and only then pull the container config to capture
 * the upstream bearer into encrypted Broker-private state — THEN persist the grant row.
 *
 * The grant-attach step comes BEFORE `getContainerConfig` deliberately: OneCLI's container config
 * is grants-dependent (an Agent with no OpenAI grant gets no Codex `auth.json` stub), so pulling
 * it first would capture the config of a zero-credential Agent and check drift against the wrong
 * thing.
 *
 * There is no project-wide route policy to compile or republish any more: network egress is
 * enforced per Session at the relay, from an allow-list compiled on the fly from this same grant.
 * Compiling it HERE too is not redundant — it fails the issue closed if this Session's
 * Agent/capabilities have no reviewed egress mapping, rather than letting the Session start and
 * discover it as a 403 on its first CONNECT.
 *
 * Idempotent by (sessionId, requestId) — `issueGrantRow` itself enforces that; a retry after a
 * partial OneCLI-side failure re-runs the OneCLI steps (they are themselves idempotent) and then
 * succeeds at the DB step.
 */
async function doEnsureExecutionGrant(client: PoolClient, deps: GrantServiceDeps, request: IssueGrantRequest, now: Date): Promise<ExecutionGrant> {
  const context: PolicyContext = {
    principalId: request.principalId,
    workstreamCategory: request.workstreamCategory,
    agentId: request.agentId,
    runtimeDefinitionVersion: request.runtimeDefinitionVersion,
  }
  // Pure, no side effects — a PolicyDenialError here means NO OneCLI call has happened yet.
  const resolved = resolveEquipmentPolicy(request.equipment, context)

  // One operation, whether this Session has a grant yet or not. `renew` used to be a second route
  // doing the same thing to the Agent; the create-vs-extend distinction is a fact about the LEASE,
  // not about provisioning, so it lives here as a branch rather than in the API surface.
  //
  // The retry short-circuit that used to sit here (same requestId -> return early) is gone: it
  // existed to avoid re-provisioning, and provisioning is idempotent now. What it must NOT become
  // is a way to change what a Session is entitled to — that guard moved to the digest check below,
  // which is the property that actually matters (docs/specs/10 "renewal rejects a changed
  // capability digest"), rather than the request id, which merely correlates an attempt.
  const existing = await getGrantBySession(client, request.sessionId)

  // Both compilers are pure and run before any OneCLI mutation: an Agent or capability/access
  // level with no reviewed entry denies the issue here, not halfway through provisioning.
  const desiredCredentials = compileSessionCredentialGrants({ agentId: request.agentId, capabilities: resolved.capabilities })
  const egress = compileSessionEgressAllowList({ agentId: request.agentId, capabilities: resolved.capabilities })

  if (existing) {
    if (existing.state !== 'issued') {
      throw new GrantConflictError(`execution grant ${existing.id} is ${existing.state}; a Session whose entitlement was revoked cannot be granted another`)
    }
    if (existing.capabilityDigest !== resolved.capabilityDigest) {
      throw new GrantDigestChangedError(
        `Session ${request.sessionId} already holds a grant for capability digest ${existing.capabilityDigest}; ensuring it with ${resolved.capabilityDigest} would change what it is entitled to — refused`,
      )
    }
  }

  const onecliIdentifier = onecliIdentifierFor(request.sessionId)
  const attached = await provisionSessionAgent(client, deps, { sessionId: request.sessionId, onecliIdentifier, desiredCredentials }, now)

  // docs/specs/10 "rotate/extend private authority": a fresh upstream bearer every time this runs,
  // which shrinks the live window of any single token without touching capability digest, route
  // policy or Agent identity. Uniform across create and extend — that uniformity is the point of
  // there being one operation.
  await deps.onecli.rotateAgentAuthority(onecliIdentifier)

  const containerConfig = await deps.onecli.getContainerConfig(onecliIdentifier)
  // docs/specs/10: "Verify returned CA/stub material against P04's operator-managed runtime bundle
  // and fail closed on drift; do not add it to the activation response." — the Pod's own bundle
  // (relay-bundle.ts) is fixed and operator-managed, never sourced per-Session from this response;
  // this call's ONLY job is to confirm OneCLI has not silently drifted from it before this Session's
  // upstream bearer is trusted at all.
  if (
    normalizeCa(containerConfig.caCertificate) !== normalizeCa(deps.expectedRuntimeBundle.caCertificate) ||
    !stubsWithinPinnedSet(containerConfig.credentialStubs, deps.expectedRuntimeBundle.credentialStubs)
  ) {
    throw new RuntimeBundleDriftError(
      `OneCLI Agent ${onecliIdentifier}'s container config does not match the operator-pinned runtime bundle — refusing to issue`,
    )
  }
  await storeUpstreamAuthority(client, deps.encryptionKey, request.sessionId, containerConfig.upstreamProxyCredential, containerConfig.gatewayUrl, now)

  // Extending an existing lease, or opening one. Either way the Agent above is already provisioned
  // and the upstream authority below is refreshed, so the two cases differ only in this row.
  const grant = existing
    ? await renewGrantRow(client, existing.id, EQUIPMENT_POLICY_VERSION, new Date(now.getTime() + GRANT_TTL_MS))
    : await issueGrantRow(client, {
    id: randomUUID(),
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
    // The lease's own vocabulary survives here, where it is the true thing being described.
    actionClass: existing ? 'execution_grant.renew' : 'execution_grant.issue',
    decision: 'approved',
    policyVersion: resolved.policyVersion,
    detail: {
      grantId: grant.id,
      capabilityCount: resolved.capabilities.length,
      egressSetVersion: egress.egressSetVersion,
      egressHostCount: egress.hosts.length,
      // Deliberately named without the word "credential": audit.ts rejects any detail key matching
      // /token|bearer|secret|credential|…/, a structural backstop this call site must respect
      // rather than work around. Counts and a version string only — never which credentials.
      grantSetVersion: desiredCredentials.credentialSetVersion,
      attachedGrantCount: attached.secretIds.length + attached.connectionIds.length,
    },
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

interface ProvisionSessionAgentInput {
  readonly sessionId: string
  readonly onecliIdentifier: string
  readonly desiredCredentials: DesiredCredentialGrants
}

/**
 * Brings this Session's OneCLI Agent into existence holding exactly the credentials it is owed.
 *
 * Shared by `issue` (first time) and `renew` (after a suspend released it) precisely so the two
 * cannot drift: a resumed Session must come back with the same authority a fresh one gets, and the
 * surest way to guarantee that is for there to be one implementation of "provisioned".
 *
 * Every step is idempotent — `ensureSelectiveAgent` returns the existing Agent, the mapping insert
 * is a no-op on conflict, and `syncCredentialGrants` converges rather than appends — so calling
 * this on an Agent that is already correct changes nothing.
 */
async function provisionSessionAgent(
  client: PoolClient,
  deps: GrantServiceDeps,
  input: ProvisionSessionAgentInput,
  now: Date,
): Promise<AttachedCredentials> {
  await deps.onecli.ensureSelectiveAgent(input.onecliIdentifier, `agora-session-${input.sessionId}`)
  await ensureOnecliAgentMapping(client, input.sessionId, input.onecliIdentifier, now)

  const attached = await deps.onecli.syncCredentialGrants(input.onecliIdentifier, input.desiredCredentials)
  verifyGrantsEffective(input.onecliIdentifier, attached, await deps.onecli.getEffectiveCredentials(input.onecliIdentifier))
  return attached
}

/**
 * Decommissions this Session's OneCLI Agent without ending its grant — what a suspend does.
 *
 * A Session Runtime that has been dematerialised must not leave a standing Agent access token
 * attached to real provider credentials behind it: same lifecycle, same gesture. The grant itself
 * survives as `issued`, which is what lets `renew` provision a new Agent under the same identifier
 * when the Session comes back.
 *
 * Deliberately NOT `revoke`: revocation is terminal and marks the mapping `deleted`, a state a
 * Session never returns from. Releasing is reversible, and the schema had a state for it
 * (`suspended`) from the start that nothing had ever written.
 *
 * Idempotent, and ordered so it cannot half-happen in the direction that hurts: the row goes
 * FIRST, then OneCLI is told.
 *
 * That ordering is the opposite of what it looks like it should be, and the reason is the reaper.
 * A row is a claim of ownership, and the reaper only reclaims Agents nothing claims. If OneCLI is
 * unreachable and we have already dropped the row, the Agent is unclaimed and the backstop deletes
 * it on a later pass. Do it the other way round and a failed OneCLI call leaves a fully
 * credentialed Agent that we still claim — so nothing ever cleans it up. Dropping the row first
 * costs nothing when OneCLI succeeds, because provisioning is idempotent and re-creates it.
 */
export async function decommissionSessionAgent(client: PoolClient, deps: GrantServiceDeps, grantId: string, now: Date): Promise<void> {
  const grant = await getGrant(client, grantId)
  if (!grant) return

  await deleteOnecliAgentMapping(client, grant.sessionId)
  await deps.onecli.deleteAgent(grant.onecliIdentifier)

  await recordAudit(client, {
    id: randomUUID(),
    actorKind: 'service',
    actorId: grant.principalId,
    sessionId: grant.sessionId,
    actionClass: 'onecli_agent.decommission',
    decision: 'approved',
    policyVersion: grant.policyVersion,
    detail: { grantId: grant.id, onecliIdentifier: grant.onecliIdentifier },
    createdAt: now,
  })
}

export async function revokeExecutionGrant(client: PoolClient, deps: GrantServiceDeps, grantId: string, now: Date): Promise<void> {
  const grant = await getGrant(client, grantId)
  if (!grant) return
  await revokeGrantRow(client, grantId, now)
  // Same decommissioning as a suspend, same ordering and for the same reason: revocation
  // deliberately does not depend on OneCLI succeeding, so the row must go first or an unreachable
  // OneCLI leaves a credentialed Agent that we still claim and nothing ever reclaims. What makes
  // revocation terminal is the GRANT moving to `revoked`, which refuses any later renew — the
  // Agent side needs no tombstone of its own.
  await deleteOnecliAgentMapping(client, grant.sessionId)
  await deps.onecli.deleteAgent(grant.onecliIdentifier)

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
