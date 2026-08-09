import type { PoolClient } from 'pg'
import { canTransitionSessionPhase, TERMINAL_SESSION_PHASES, type SessionPhase } from '@agora/domain'

/**
 * `acp_session_id` is absent before binding and immutable after (enforced by a DB trigger too).
 * docs/specs/04-acp-integration.md "Connection bootstrap": negotiated protocol version/capabilities
 * are persisted as Session facts at the same point (they are ALSO journaled verbatim as the
 * `initialize` response event — spec allows either; this additionally caches them for cheap
 * querying without replaying the journal).
 */
export async function bindAcpSession(
  client: PoolClient,
  sessionId: string,
  acpSessionId: string,
  boundAt: Date,
  negotiated?: { readonly protocolVersion: number; readonly capabilities: unknown },
): Promise<void> {
  const result = await client.query(
    `UPDATE product.sessions
     SET acp_session_id = $2, bound_at = $3, acp_protocol_version = $4, negotiated_capabilities = $5
     WHERE id = $1 AND acp_session_id IS NULL`,
    [
      sessionId,
      acpSessionId,
      boundAt,
      negotiated?.protocolVersion ?? null,
      negotiated ? JSON.stringify(negotiated.capabilities) : null,
    ],
  )
  if (result.rowCount === 0) {
    throw new Error('acp_binding_conflict: Session not found or already ACP-bound')
  }
}

/** The capability policy version/digest are bound once, before provisioning, and cannot change. */
export async function bindCapabilities(
  client: PoolClient,
  sessionId: string,
  policyVersion: string,
  digest: Uint8Array,
): Promise<void> {
  if (digest.length !== 32) throw new Error('capability_digest_invalid: digest must be 32 bytes (SHA-256)')
  const result = await client.query(
    `UPDATE product.sessions SET capability_policy_version = $2, capability_digest = $3
     WHERE id = $1 AND capability_digest IS NULL`,
    [sessionId, policyVersion, Buffer.from(digest)],
  )
  if (result.rowCount === 0) {
    throw new Error('capability_binding_already_bound: Session not found or already capability-bound')
  }
}

/**
 * Found live, P11: apps/web's own real Broker grant wiring — the grantRef obtained at issuance
 * must survive to a later resume (`broker.execution_grants.session_id` is UNIQUE, so resume
 * RENEWS this same grant rather than issuing a new one; see 005-add-session-execution-grant-ref
 * .sql's own doc comment). Write-once, same shape as `bindCapabilities` above: both are bound
 * once, from the same Broker issue response, before provisioning continues.
 */
export async function bindExecutionGrantRef(client: PoolClient, sessionId: string, executionGrantRef: string): Promise<void> {
  // Tolerates a retry that re-binds the SAME grantRef (e.g. `activateSession`'s 'requested'-phase
  // reattach path re-running `provisionSessionAndPrompt` after a crash between a successful Broker
  // issue and this bind — the Broker's own issue is idempotent by (sessionId, requestId) and would
  // return the identical grantRef) — only a DIFFERENT value already bound is a genuine conflict.
  const result = await client.query(
    `UPDATE product.sessions SET execution_grant_ref = $2
     WHERE id = $1 AND (execution_grant_ref IS NULL OR execution_grant_ref = $2)`,
    [sessionId, executionGrantRef],
  )
  if (result.rowCount === 0) {
    throw new Error('execution_grant_ref_conflict: Session not found or already bound to a different grant')
  }
}

/** Undefined for a Session whose grant was never persisted (e.g. pre-P11 data, or provisioning failed before this point) — the caller (resume) must fail closed rather than materialize with no grant. */
export async function getExecutionGrantRef(client: PoolClient, sessionId: string): Promise<string | undefined> {
  const { rows } = await client.query<{ execution_grant_ref: string | null }>(
    'SELECT execution_grant_ref FROM product.sessions WHERE id = $1',
    [sessionId],
  )
  return rows[0]?.execution_grant_ref ?? undefined
}

/**
 * No DB trigger enforces the Session phase transition table (unlike e.g. the ACP-binding
 * write-once guard) — @agora/domain's `canTransitionSessionPhase` is the only place that table
 * lives, so this repository function must call it before persisting, or an illegal transition
 * would silently succeed. Locks the row first so the read-then-check-then-write is atomic.
 */
export async function transitionSessionPhase(
  client: PoolClient,
  sessionId: string,
  to: SessionPhase,
  extra: { readonly failureCode?: string; readonly failureDetail?: string; readonly closedAt?: Date } = {},
): Promise<void> {
  await client.query('BEGIN')
  try {
    const { rows } = await client.query<{ phase: SessionPhase }>(
      'SELECT phase FROM product.sessions WHERE id = $1 FOR UPDATE',
      [sessionId],
    )
    const current = rows[0]
    if (!current) throw new Error(`session ${sessionId} not found`)
    if (!canTransitionSessionPhase(current.phase, to)) {
      const code = TERMINAL_SESSION_PHASES.has(current.phase) ? 'terminal_session_transition' : 'illegal_session_transition'
      throw new Error(`${code}: Session cannot move from ${current.phase} to ${to}`)
    }
    await client.query(
      `UPDATE product.sessions
       SET phase = $2, failure_code = $3, failure_detail = $4, closed_at = COALESCE($5, closed_at)
       WHERE id = $1`,
      [sessionId, to, extra.failureCode ?? null, extra.failureDetail ?? null, extra.closedAt ?? null],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
