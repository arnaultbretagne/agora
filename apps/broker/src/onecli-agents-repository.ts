import type { PoolClient } from 'pg'
import { decryptUpstreamBearer, encryptUpstreamBearer } from './crypto.js'

export interface OnecliAgentRecord {
  readonly sessionId: string
  readonly onecliIdentifier: string
  readonly state: 'active' | 'suspended' | 'deleted'
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface AgentRow {
  session_id: string
  onecli_identifier: string
  onecli_agent_id: string | null
  state: 'active' | 'suspended' | 'deleted'
  created_at: Date
  updated_at: Date
}

function hydrate(row: AgentRow): OnecliAgentRecord {
  return { sessionId: row.session_id, onecliIdentifier: row.onecli_identifier, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }
}

export class OnecliAgentConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OnecliAgentConflictError'
  }
}

/**
 * docs/specs/10 "One Session, one OneCLI Agent": the mapping is created exactly once per Session
 * and never reassigned. Idempotent when the SAME onecliIdentifier is passed again (retry-safe);
 * a DIFFERENT identifier for an already-mapped Session is a bug in the caller, not a case to
 * silently accept — `onecliIdentifier` must be deterministically derived from `sessionId` by the
 * caller, so this only fires if that derivation itself changed.
 */
export async function ensureOnecliAgentMapping(client: PoolClient, sessionId: string, onecliIdentifier: string, now: Date): Promise<OnecliAgentRecord> {
  const { rows } = await client.query<AgentRow>(
    `INSERT INTO broker.onecli_agents (session_id, onecli_identifier, state, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)
     ON CONFLICT (session_id) DO NOTHING
     RETURNING session_id, onecli_identifier, onecli_agent_id, state, created_at, updated_at`,
    [sessionId, onecliIdentifier, now],
  )
  const inserted = rows[0]
  if (inserted) return hydrate(inserted)

  const { rows: existingRows } = await client.query<AgentRow>(
    'SELECT session_id, onecli_identifier, onecli_agent_id, state, created_at, updated_at FROM broker.onecli_agents WHERE session_id = $1',
    [sessionId],
  )
  const existing = existingRows[0]
  if (!existing) throw new Error(`onecli agent mapping for session ${sessionId} vanished immediately after a conflicting concurrent insert`)
  if (existing.onecli_identifier !== onecliIdentifier) {
    throw new OnecliAgentConflictError(`session ${sessionId} is already mapped to onecli agent ${existing.onecli_identifier}, not ${onecliIdentifier}`)
  }
  return hydrate(existing)
}

export async function getOnecliAgentMapping(client: PoolClient, sessionId: string): Promise<OnecliAgentRecord | undefined> {
  const { rows } = await client.query<AgentRow>(
    'SELECT session_id, onecli_identifier, onecli_agent_id, state, created_at, updated_at FROM broker.onecli_agents WHERE session_id = $1',
    [sessionId],
  )
  return rows[0] ? hydrate(rows[0]) : undefined
}

/** Terminal — docs/specs/10 "One Session, one OneCLI Agent": a deleted mapping is never reactivated. */
export async function markOnecliAgentDeleted(client: PoolClient, sessionId: string, now: Date): Promise<void> {
  await client.query(`UPDATE broker.onecli_agents SET state = 'deleted', updated_at = $2 WHERE session_id = $1`, [sessionId, now])
  await client.query('DELETE FROM broker.upstream_authority WHERE session_id = $1', [sessionId])
}

/**
 * docs/specs/10 "Secrets": stores the encrypted upstream OneCLI bearer, never plaintext. Upsert —
 * rotation replaces the ciphertext/nonce/gatewayUrl in place, `rotated_at` records when.
 */
export async function storeUpstreamAuthority(
  client: PoolClient,
  encryptionKey: Buffer,
  sessionId: string,
  bearer: string,
  gatewayUrl: string,
  rotatedAt: Date,
): Promise<void> {
  const { ciphertext, nonce } = encryptUpstreamBearer(encryptionKey, bearer)
  await client.query(
    `INSERT INTO broker.upstream_authority (session_id, encrypted_bearer, encryption_nonce, gateway_url, rotated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id) DO UPDATE SET encrypted_bearer = EXCLUDED.encrypted_bearer, encryption_nonce = EXCLUDED.encryption_nonce, gateway_url = EXCLUDED.gateway_url, rotated_at = EXCLUDED.rotated_at`,
    [sessionId, ciphertext, nonce, gatewayUrl, rotatedAt],
  )
}

export interface UpstreamAuthority {
  readonly bearer: string
  readonly gatewayUrl: string
}

/** Only the access relay (apps/broker/src/relay.ts) may call this — nothing else needs the plaintext bearer. */
export async function readUpstreamAuthority(client: PoolClient, encryptionKey: Buffer, sessionId: string): Promise<UpstreamAuthority | undefined> {
  const { rows } = await client.query<{ encrypted_bearer: Buffer; encryption_nonce: Buffer; gateway_url: string }>(
    'SELECT encrypted_bearer, encryption_nonce, gateway_url FROM broker.upstream_authority WHERE session_id = $1',
    [sessionId],
  )
  const row = rows[0]
  if (!row) return undefined
  return { bearer: decryptUpstreamBearer(encryptionKey, { ciphertext: row.encrypted_bearer, nonce: row.encryption_nonce }), gatewayUrl: row.gateway_url }
}
