import type { PoolClient } from 'pg'

export interface AuditEntry {
  readonly id: string
  readonly actorKind: 'human' | 'service' | 'system'
  readonly actorId: string
  readonly sessionId: string | null
  readonly actionClass: string
  readonly decision: string
  readonly policyVersion: string | null
  /** Operator-reviewed only — never prompt/tool content, tokens or custody bytes (docs/specs/11
   * "Audit"). Callers must pass safe identifiers/decisions only; this function does not scrub. */
  readonly detail: Readonly<Record<string, unknown>> | null
  readonly createdAt: Date
}

const FORBIDDEN_DETAIL_KEY_PATTERN = /token|bearer|secret|credential|password|authorization/i

/**
 * docs/specs/11 "Audit" content-safety gate: rejects (rather than silently writing) any `detail`
 * whose OWN key names look like they carry a secret — a structural backstop against the class of
 * mistake this plan's required tests probe for ("audit/log content-safety under seeded
 * canaries"). It cannot prove the VALUES are safe, only that the shape of the call site isn't
 * obviously wrong.
 */
export async function recordAudit(
  client: PoolClient,
  entry: Omit<AuditEntry, 'id' | 'createdAt'> & { readonly id: string; readonly createdAt: Date },
): Promise<void> {
  if (entry.detail) {
    for (const key of Object.keys(entry.detail)) {
      if (FORBIDDEN_DETAIL_KEY_PATTERN.test(key)) {
        throw new Error(`refusing to write audit detail with a secret-shaped key '${key}'`)
      }
    }
  }
  await client.query(
    `INSERT INTO broker.security_audit (id, actor_kind, actor_id, session_id, action_class, decision, policy_version, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [entry.id, entry.actorKind, entry.actorId, entry.sessionId, entry.actionClass, entry.decision, entry.policyVersion, entry.detail ? JSON.stringify(entry.detail) : null, entry.createdAt],
  )
}
