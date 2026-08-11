import type { PoolClient } from 'pg'
import { decryptUpstreamBearer, encryptUpstreamBearer } from './crypto.js'

/**
 * A row means exactly one thing: an Agent has been provisioned for this Session and not
 * decommissioned. There is no state, because there is no state worth keeping — see
 * `contracts/database/009-onecli-agent-mapping-presence-only.sql`.
 */
export interface OnecliAgentRecord {
  readonly sessionId: string
  readonly onecliIdentifier: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface AgentRow {
  session_id: string
  onecli_identifier: string
  created_at: Date
  updated_at: Date
}

function hydrate(row: AgentRow): OnecliAgentRecord {
  return { sessionId: row.session_id, onecliIdentifier: row.onecli_identifier, createdAt: row.created_at, updatedAt: row.updated_at }
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
    `INSERT INTO broker.onecli_agents (session_id, onecli_identifier, created_at, updated_at)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (session_id) DO NOTHING
     RETURNING session_id, onecli_identifier, created_at, updated_at`,
    [sessionId, onecliIdentifier, now],
  )
  const inserted = rows[0]
  if (inserted) return hydrate(inserted)

  const { rows: existingRows } = await client.query<AgentRow>(
    'SELECT session_id, onecli_identifier, created_at, updated_at FROM broker.onecli_agents WHERE session_id = $1',
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
    'SELECT session_id, onecli_identifier, created_at, updated_at FROM broker.onecli_agents WHERE session_id = $1',
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
 * the same component that decides a Runtime's fate decides its Agent's.
 *
 * So the question this answers is just "is there a row" — presence, not state. What is left for the
 * reaper is the job it was actually built for: Agents stranded by a Broker crash mid-provision, in
 * two shapes —
 *
 * - the mapping insert never landed: no row at all, unprotected from the start, and the reaper's
 *   creation-time grace window is what keeps a concurrent issue safe;
 * - the mapping landed but the grant insert did not: a row no Session lifecycle will ever remove,
 *   because there is no grant reference for anything to decommission through. Those are protected
 *   only while young (`ungrantedStaleBefore`), or they would leak forever.
 *
 * A mapping WITH a grant is never reaped on age, whatever that grant's expiry says: expiry
 * describes a credential's freshness, not a Session's mortality.
 */
export async function listLiveOnecliAgentIdentifiers(client: PoolClient, ungrantedStaleBefore: Date): Promise<readonly string[]> {
  const { rows } = await client.query<{ onecli_identifier: string }>(
    `SELECT a.onecli_identifier
       FROM broker.onecli_agents a
      WHERE EXISTS (SELECT 1 FROM broker.execution_grants g WHERE g.session_id = a.session_id)
         OR a.created_at > $1`,
    [ungrantedStaleBefore],
  )
  return rows.map((row) => row.onecli_identifier)
}

/**
 * Decommissioned: the Agent is gone, so its row goes with it.
 *
 * Deleting rather than tombstoning is the whole point. A tombstone would be a claim about OneCLI's
 * contents that this database cannot keep true — the previous design kept three such claims and all
 * of them were false in production. Absence of a row is not "we lost track"; it is the accurate
 * statement that we have nothing provisioned, which is exactly what makes the next provisioning
 * unconditional and idempotent.
 *
 * The upstream authority goes too: it authenticates against an Agent that no longer exists.
 */
export async function deleteOnecliAgentMapping(client: PoolClient, sessionId: string): Promise<void> {
  await client.query('DELETE FROM broker.onecli_agents WHERE session_id = $1', [sessionId])
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
