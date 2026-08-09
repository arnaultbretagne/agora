import type { PoolClient } from 'pg'
import type { CapabilityFact } from '@agora/equipment-policy'
import type { SafeMcpServerDescriptor } from '@agora/equipment-policy'

export interface ExecutionGrant {
  readonly id: string
  readonly sessionId: string
  readonly agentId: string
  readonly principalId: string
  readonly workstreamCategory: 'discussion' | 'invocation'
  readonly policyVersion: string
  readonly capabilityDigest: string
  readonly capabilities: readonly CapabilityFact[]
  readonly mcpServers: readonly SafeMcpServerDescriptor[]
  readonly onecliIdentifier: string
  readonly requestId: string
  readonly state: 'issued' | 'revoked'
  readonly issuedAt: Date
  readonly expiresAt: Date
  readonly revokedAt: Date | null
}

export interface IssueGrantInput {
  readonly id: string
  readonly sessionId: string
  readonly agentId: string
  readonly principalId: string
  readonly workstreamCategory: 'discussion' | 'invocation'
  readonly policyVersion: string
  readonly capabilityDigest: string
  readonly capabilities: readonly CapabilityFact[]
  readonly mcpServers: readonly SafeMcpServerDescriptor[]
  readonly onecliIdentifier: string
  readonly requestId: string
  readonly issuedAt: Date
  readonly expiresAt: Date
}

export class GrantConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrantConflictError'
  }
}

interface GrantRow {
  id: string
  session_id: string
  agent_id: string
  principal_id: string
  workstream_category: 'discussion' | 'invocation'
  policy_version: string
  capability_digest: Buffer
  capabilities: CapabilityFact[]
  mcp_servers: SafeMcpServerDescriptor[]
  onecli_identifier: string
  request_id: string
  state: 'issued' | 'revoked'
  issued_at: Date
  expires_at: Date
  revoked_at: Date | null
}

function hydrate(row: GrantRow): ExecutionGrant {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    principalId: row.principal_id,
    workstreamCategory: row.workstream_category,
    policyVersion: row.policy_version,
    capabilityDigest: row.capability_digest.toString('hex'),
    capabilities: row.capabilities,
    mcpServers: row.mcp_servers,
    onecliIdentifier: row.onecli_identifier,
    requestId: row.request_id,
    state: row.state,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }
}

const GRANT_COLUMNS = `id, session_id, agent_id, principal_id, workstream_category, policy_version, capability_digest,
       capabilities, mcp_servers, onecli_identifier, request_id, state, issued_at, expires_at, revoked_at`

/**
 * docs/specs/10 "Execution grant": ONE grant per Session, cannot be upgraded in place. Idempotent
 * by (session_id, request_id) — a retried issue call with the SAME request_id returns the SAME
 * grant. A DIFFERENT request_id for a Session that already holds a grant is a `GrantConflictError`
 * (docs/specs/10 "Equipment change" opens a new Session instead), not a silent overwrite.
 *
 * The read-then-insert below is racy by nature, so the insert is written to lose that race safely.
 * Two details matter, both found in CI under P13 (8 genuinely concurrent identical issues for one
 * Session; reproduced locally at 11 failures in 12 rounds):
 *
 * - the conflict target must be UNTARGETED. This table has three unique constraints — `id`,
 *   `session_id`, and `(session_id, request_id)` — and concurrent callers each mint their own
 *   random `id`, so they never collide on it. They collide on `session_id`, which
 *   `ON CONFLICT (id)` does not cover, and the raw 23505 escaped to the caller as an unhandled
 *   database error instead of resolving idempotently.
 * - the recovery read must be BY SESSION. The winner committed under its own random id, so
 *   re-reading by ours finds nothing and reports a phantom "vanished immediately" error for what is
 *   really the normal, expected outcome of losing the race.
 */
export async function issueGrant(client: PoolClient, input: IssueGrantInput): Promise<ExecutionGrant> {
  const existingBySession = await client.query<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM broker.execution_grants WHERE session_id = $1`, [
    input.sessionId,
  ])
  const existing = existingBySession.rows[0]
  if (existing) {
    if (existing.request_id === input.requestId) return hydrate(existing)
    throw new GrantConflictError(`session ${input.sessionId} already holds execution grant ${existing.id} — a Session cannot be upgraded in place`)
  }

  const { rows } = await client.query<GrantRow>(
    `INSERT INTO broker.execution_grants
       (id, session_id, agent_id, principal_id, workstream_category, policy_version, capability_digest,
        capabilities, mcp_servers, onecli_identifier, request_id, state, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'issued', $12, $13)
     ON CONFLICT DO NOTHING
     RETURNING ${GRANT_COLUMNS}`,
    [
      input.id,
      input.sessionId,
      input.agentId,
      input.principalId,
      input.workstreamCategory,
      input.policyVersion,
      Buffer.from(input.capabilityDigest, 'hex'),
      JSON.stringify(input.capabilities),
      JSON.stringify(input.mcpServers),
      input.onecliIdentifier,
      input.requestId,
      input.issuedAt,
      input.expiresAt,
    ],
  )
  const inserted = rows[0]
  if (inserted) return hydrate(inserted)

  // Lost the race to a concurrent insert — re-read and apply the same idempotency check. Re-read by
  // SESSION, not by id: the winner is a different concurrent call, so it committed under ITS own
  // random id and a lookup by ours would find nothing and report a phantom "vanished" error.
  const { rows: retried } = await client.query<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM broker.execution_grants WHERE session_id = $1`, [input.sessionId])
  const row = retried[0]
  if (!row) throw new Error(`execution grant for session ${input.sessionId} vanished immediately after a conflicting concurrent insert`)
  if (row.request_id !== input.requestId) {
    throw new GrantConflictError(`session ${input.sessionId} already holds execution grant ${row.id} — a Session cannot be upgraded in place`)
  }
  return hydrate(row)
}

export async function getGrant(client: PoolClient, grantId: string): Promise<ExecutionGrant | undefined> {
  const { rows } = await client.query<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM broker.execution_grants WHERE id = $1`, [grantId])
  return rows[0] ? hydrate(rows[0]) : undefined
}

export async function getGrantBySession(client: PoolClient, sessionId: string): Promise<ExecutionGrant | undefined> {
  const { rows } = await client.query<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM broker.execution_grants WHERE session_id = $1`, [sessionId])
  return rows[0] ? hydrate(rows[0]) : undefined
}

export class GrantDigestChangedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrantDigestChangedError'
  }
}

/**
 * docs/specs/10 "Renewal": extends `expires_at` only — the capability digest, capabilities and
 * mcpServers are immutable for a grant's lifetime, and `POST .../renew` (contracts/openapi/
 * broker-control.yaml) carries no request body at all, so there is no caller-supplied digest to
 * compare against. The check this function CAN make, and does: the grant's `policy_version` must
 * still equal the currently-active `EQUIPMENT_POLICY_VERSION` (@agora/equipment-policy). A policy
 * version bump means the digest formula/rules underneath the stored digest are no longer known to
 * be current — a grant issued under a retired policy version is refused renewal (required test:
 * "renewal rejects a changed capability digest") and must be re-issued through a fresh policy
 * resolution instead.
 */
export async function renewGrant(client: PoolClient, grantId: string, currentPolicyVersion: string, expiresAt: Date): Promise<ExecutionGrant> {
  const { rows } = await client.query<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM broker.execution_grants WHERE id = $1 FOR UPDATE`, [grantId])
  const row = rows[0]
  if (!row) throw new Error(`execution grant ${grantId} does not exist`)
  if (row.state !== 'issued') throw new GrantConflictError(`execution grant ${grantId} is ${row.state}, not renewable`)
  if (row.policy_version !== currentPolicyVersion) {
    throw new GrantDigestChangedError(`execution grant ${grantId} was issued under policy version '${row.policy_version}', not the current '${currentPolicyVersion}' — renewal refused`)
  }
  const { rows: updated } = await client.query<GrantRow>(
    `UPDATE broker.execution_grants SET expires_at = $2 WHERE id = $1 RETURNING ${GRANT_COLUMNS}`,
    [grantId, expiresAt],
  )
  return hydrate(updated[0]!)
}

/** Idempotent: revoking an already-revoked (or absent) grant is a no-op success, not an error. */
export async function revokeGrant(client: PoolClient, grantId: string, revokedAt: Date): Promise<void> {
  await client.query(`UPDATE broker.execution_grants SET state = 'revoked', revoked_at = $2 WHERE id = $1 AND state = 'issued'`, [grantId, revokedAt])
}

export interface ActiveGrantSummary {
  readonly id: string
  readonly agentId: string
  readonly onecliIdentifier: string
  readonly capabilities: readonly CapabilityFact[]
}

/** Every currently-issued, unexpired grant — the route-policy compiler needs the UNION of all of
 * these (see apps/broker/src/onecli-real.ts's class doc: OneCLI route policy in this SDK version
 * is project-wide, not per-Agent). */
export async function listActiveGrants(client: PoolClient, now: Date): Promise<readonly ActiveGrantSummary[]> {
  const { rows } = await client.query<{ id: string; agent_id: string; onecli_identifier: string; capabilities: CapabilityFact[] }>(
    `SELECT id, agent_id, onecli_identifier, capabilities FROM broker.execution_grants WHERE state = 'issued' AND expires_at > $1`,
    [now],
  )
  return rows.map((row) => ({ id: row.id, agentId: row.agent_id, onecliIdentifier: row.onecli_identifier, capabilities: row.capabilities }))
}
