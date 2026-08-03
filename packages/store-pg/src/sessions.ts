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
