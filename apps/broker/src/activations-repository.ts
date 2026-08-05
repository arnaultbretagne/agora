import type { PoolClient } from 'pg'

export interface GrantActivation {
  readonly id: string
  readonly grantId: string
  readonly sessionId: string
  readonly agentId: string
  readonly workloadIdentity: string
  readonly requestId: string
  readonly activatedAt: Date
  readonly expiresAt: Date
}

export interface ActivateGrantInput {
  readonly id: string
  readonly grantId: string
  readonly sessionId: string
  readonly agentId: string
  readonly workloadIdentity: string
  readonly requestId: string
  readonly activatedAt: Date
  readonly expiresAt: Date
}

export class ActivationConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActivationConflictError'
  }
}

interface ActivationRow {
  id: string
  grant_id: string
  session_id: string
  agent_id: string
  workload_identity: string
  request_id: string
  activated_at: Date
  expires_at: Date
}

function hydrate(row: ActivationRow): GrantActivation {
  return {
    id: row.id,
    grantId: row.grant_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    workloadIdentity: row.workload_identity,
    requestId: row.request_id,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
  }
}

const ACTIVATION_COLUMNS = 'id, grant_id, session_id, agent_id, workload_identity, request_id, activated_at, expires_at'

/**
 * docs/specs/10 "Activation": binds grant + session_id + agent_id + workload_identity EXACTLY
 * ONCE (required test: "a Controller cannot activate the same grant twice for different
 * workloads"). Idempotent retry by (grant_id, request_id); a request that names a DIFFERENT
 * workload_identity for an already-activated grant is rejected, never silently rebound.
 */
export async function activateGrant(client: PoolClient, input: ActivateGrantInput): Promise<GrantActivation> {
  const { rows: existingRows } = await client.query<ActivationRow>(`SELECT ${ACTIVATION_COLUMNS} FROM broker.grant_activations WHERE grant_id = $1 FOR UPDATE`, [
    input.grantId,
  ])
  const existing = existingRows[0]
  if (existing) {
    if (existing.request_id === input.requestId) return hydrate(existing)
    if (existing.workload_identity !== input.workloadIdentity) {
      throw new ActivationConflictError(`grant ${input.grantId} is already activated for a different workload identity`)
    }
    throw new ActivationConflictError(`grant ${input.grantId} is already activated (request_id mismatch)`)
  }

  const { rows } = await client.query<ActivationRow>(
    `INSERT INTO broker.grant_activations (id, grant_id, session_id, agent_id, workload_identity, request_id, activated_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING
     RETURNING ${ACTIVATION_COLUMNS}`,
    [input.id, input.grantId, input.sessionId, input.agentId, input.workloadIdentity, input.requestId, input.activatedAt, input.expiresAt],
  )
  const inserted = rows[0]
  if (inserted) return hydrate(inserted)

  const { rows: retried } = await client.query<ActivationRow>(`SELECT ${ACTIVATION_COLUMNS} FROM broker.grant_activations WHERE grant_id = $1`, [
    input.grantId,
  ])
  const row = retried[0]
  if (!row) throw new Error(`grant activation for ${input.grantId} vanished immediately after a conflicting concurrent insert`)
  if (row.request_id !== input.requestId || row.workload_identity !== input.workloadIdentity) {
    throw new ActivationConflictError(`grant ${input.grantId} is already activated for a different workload identity or request`)
  }
  return hydrate(row)
}

export async function getActivationByGrant(client: PoolClient, grantId: string): Promise<GrantActivation | undefined> {
  const { rows } = await client.query<ActivationRow>(`SELECT ${ACTIVATION_COLUMNS} FROM broker.grant_activations WHERE grant_id = $1`, [grantId])
  return rows[0] ? hydrate(rows[0]) : undefined
}

/**
 * The access relay's ONLY lookup path (apps/broker/src/relay.ts): a CONNECT request carries a
 * `workloadIdentity` claim (trusted the same way apps/session-runtime-controller/src/server.ts
 * trusts its own transport — see relay.ts's module doc), and the relay must find at most one
 * still-issued grant bound to it.
 */
export async function getActivationByWorkloadIdentity(client: PoolClient, workloadIdentity: string): Promise<GrantActivation | undefined> {
  const { rows } = await client.query<ActivationRow>(`SELECT ${ACTIVATION_COLUMNS} FROM broker.grant_activations WHERE workload_identity = $1`, [
    workloadIdentity,
  ])
  return rows[0] ? hydrate(rows[0]) : undefined
}
