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

/**
 * Every OneCLI Agent identifier this Broker still considers ITS OWN — the orphan reaper's
 * protection set (`onecli-agent-reaper.ts`).
 *
 * It is exactly the `active` mappings, and deliberately nothing cleverer.
 *
 * WHAT THIS REPLACED, AND WHY. This used to protect an Agent only while its grant was unexpired
 * (plus a 24h slack), reasoning that "a Session whose newest grant expired cannot be resumed
 * anyway". **That reasoning was wrong.** `renewGrant` checks the grant's STATE and policy version,
 * never its expiry, so resuming a long-suspended Session renews its grant perfectly happily — and
 * then fails on `rotateAgentAuthority` because this reaper had already deleted the Agent
 * underneath it. Measured on the real instance 2026-08-11: 17 Agents reaped, and ALL 14 suspended
 * Sessions left unresumable, each failing resume with `no onecli agent found`.
 *
 * The fix is not a better heuristic here. An Agent's life is now bound to its Session Runtime's:
 * `issue`/`renew` provision one, `release` (suspend) gives it up, `revoke` (close/fail) ends it —
 * the same component that decides a Runtime's fate decides its Agent's. This function therefore
 * only has to answer "does a Session currently believe it owns a live Agent", which is one column.
 *
 * That leaves the reaper the job it was actually built for: Agents stranded by a Broker crash
 * mid-provision. There are two shapes of that, and `active` alone only covers one of them —
 *
 * - the mapping insert never landed: no row here at all, so unprotected from the start, and the
 *   reaper's creation-time grace window is what keeps a concurrent issue safe;
 * - the mapping landed but the grant insert did not: an `active` row that no Session lifecycle
 *   will ever move, because no grant reference exists for anything to release or revoke. Those are
 *   protected only while young (`ungrantedStaleBefore`), or they would leak forever.
 *
 * A mapping WITH a grant is never reaped on age, whatever that grant's expiry says. That is the
 * whole correction: expiry describes a credential's freshness, not a Session's mortality.
 */
export async function listLiveOnecliAgentIdentifiers(client: PoolClient, ungrantedStaleBefore: Date): Promise<readonly string[]> {
  const { rows } = await client.query<{ onecli_identifier: string }>(
    `SELECT a.onecli_identifier
       FROM broker.onecli_agents a
      WHERE a.state = 'active'
        AND (
          EXISTS (SELECT 1 FROM broker.execution_grants g WHERE g.session_id = a.session_id)
          OR a.created_at > $1
        )`,
    [ungrantedStaleBefore],
  )
  return rows.map((row) => row.onecli_identifier)
}

/**
 * `released`, in the schema's `suspended` state: the OneCLI Agent is gone, but this Session can
 * come back and will be given one again under the SAME identifier.
 *
 * This is the state the schema always had (`CHECK (state IN ('active','suspended','deleted'))`) and
 * that nothing ever wrote. It exists because "the Agent is absent" and "this Session is finished"
 * are different facts: `deleted` is terminal, `suspended` is a Runtime that was dematerialised.
 *
 * The upstream authority is dropped with it — it authenticates against an Agent that no longer
 * exists, so keeping it would only preserve a dead secret. `renew` stores a fresh one when it
 * re-provisions.
 */
export async function markOnecliAgentReleased(client: PoolClient, sessionId: string, now: Date): Promise<void> {
  await client.query(`UPDATE broker.onecli_agents SET state = 'suspended', updated_at = $2 WHERE session_id = $1 AND state <> 'deleted'`, [
    sessionId,
    now,
  ])
  await client.query('DELETE FROM broker.upstream_authority WHERE session_id = $1', [sessionId])
}

/** Back from `suspended` after a resume re-provisioned the Agent. Never resurrects a `deleted` mapping. */
export async function markOnecliAgentActive(client: PoolClient, sessionId: string, now: Date): Promise<void> {
  await client.query(`UPDATE broker.onecli_agents SET state = 'active', updated_at = $2 WHERE session_id = $1 AND state = 'suspended'`, [
    sessionId,
    now,
  ])
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
  /** The `username:token` proxy userinfo pair OneCLI's gateway authenticates via HTTP Basic — see `OneCliContainerConfig.upstreamProxyCredential`'s own doc for why this is deliberately not called a "bearer". (The DB column keeps its `encrypted_bearer` name: renaming a live column would need a migration for zero functional gain.) */
  readonly proxyCredential: string
  readonly gatewayUrl: string
}

/** Only the access relay (apps/broker/src/relay.ts) may call this — nothing else needs the plaintext credential. */
export async function readUpstreamAuthority(client: PoolClient, encryptionKey: Buffer, sessionId: string): Promise<UpstreamAuthority | undefined> {
  const { rows } = await client.query<{ encrypted_bearer: Buffer; encryption_nonce: Buffer; gateway_url: string }>(
    'SELECT encrypted_bearer, encryption_nonce, gateway_url FROM broker.upstream_authority WHERE session_id = $1',
    [sessionId],
  )
  const row = rows[0]
  if (!row) return undefined
  return { proxyCredential: decryptUpstreamBearer(encryptionKey, { ciphertext: row.encrypted_bearer, nonce: row.encryption_nonce }), gatewayUrl: row.gateway_url }
}
