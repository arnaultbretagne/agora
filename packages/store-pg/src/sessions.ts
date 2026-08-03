import type { PoolClient } from 'pg'
import type { SessionPhase } from '@agora/domain'

/** `acp_session_id` is absent before binding and immutable after (enforced by a DB trigger too). */
export async function bindAcpSession(
  client: PoolClient,
  sessionId: string,
  acpSessionId: string,
  boundAt: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE product.sessions SET acp_session_id = $2, bound_at = $3
     WHERE id = $1 AND acp_session_id IS NULL`,
    [sessionId, acpSessionId, boundAt],
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

export async function transitionSessionPhase(
  client: PoolClient,
  sessionId: string,
  to: SessionPhase,
  extra: { readonly failureCode?: string; readonly failureDetail?: string; readonly closedAt?: Date } = {},
): Promise<void> {
  await client.query(
    `UPDATE product.sessions
     SET phase = $2, failure_code = $3, failure_detail = $4, closed_at = COALESCE($5, closed_at)
     WHERE id = $1`,
    [sessionId, to, extra.failureCode ?? null, extra.failureDetail ?? null, extra.closedAt ?? null],
  )
}
