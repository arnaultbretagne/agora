import type { PoolClient } from 'pg'

export interface UpsertAnchorInput {
  readonly workstreamId: string
  readonly agentId: string
  readonly sessionId: string
  readonly custodySnapshotId: string
  readonly syncedThroughSeq: number
  readonly updatedAt: Date
}

/**
 * The durable pointer for one (workstream, agent) pair. Watermark-cannot-decrease and
 * watermark-cannot-exceed-Workstream-head are enforced by the `agent_anchors_progress_guard`
 * trigger (contracts/database/001-initial.sql) — this function does not duplicate that check, it
 * only performs the atomic upsert and lets the DB reject an illegal one.
 */
export async function upsertAnchor(client: PoolClient, input: UpsertAnchorInput): Promise<void> {
  await client.query(
    `INSERT INTO product.agent_anchors (workstream_id, agent_id, session_id, custody_snapshot_id, synced_through_seq, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workstream_id, agent_id) DO UPDATE SET
       session_id = EXCLUDED.session_id,
       custody_snapshot_id = EXCLUDED.custody_snapshot_id,
       synced_through_seq = EXCLUDED.synced_through_seq,
       updated_at = EXCLUDED.updated_at`,
    [input.workstreamId, input.agentId, input.sessionId, input.custodySnapshotId, input.syncedThroughSeq, input.updatedAt],
  )
}

export interface Anchor {
  readonly workstreamId: string
  readonly agentId: string
  readonly sessionId: string
  readonly custodySnapshotId: string
  readonly syncedThroughSeq: number
  readonly updatedAt: Date
}

export async function getAnchor(client: PoolClient, workstreamId: string, agentId: string): Promise<Anchor | undefined> {
  const { rows } = await client.query<{
    workstream_id: string
    agent_id: string
    session_id: string
    custody_snapshot_id: string
    synced_through_seq: number
    updated_at: Date
  }>('SELECT * FROM product.agent_anchors WHERE workstream_id = $1 AND agent_id = $2', [workstreamId, agentId])
  const row = rows[0]
  if (!row) return undefined
  return {
    workstreamId: row.workstream_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    custodySnapshotId: row.custody_snapshot_id,
    syncedThroughSeq: row.synced_through_seq,
    updatedAt: row.updated_at,
  }
}

export interface RetentionCandidate {
  readonly snapshotId: string
  readonly sessionId: string
  readonly generation: number
  readonly createdAt: Date
}

/**
 * docs/specs/07-custody.md "Retention": every Anchor-referenced snapshot is retained, and so is
 * the newest snapshot per Session; this lists OLDER, un-anchored snapshots eligible for GC after
 * `olderThan`. It only lists candidates — deletion is a separate, deliberate operation.
 *
 * This spans `product.agent_anchors` and `custody.snapshots` metadata, which per
 * contracts/database/002-access.sql no single app role can read together (`agora_custody_meta`
 * has no `product` grant at all; `agora_custody_runtime` cannot read anchors). That is
 * intentional, not an oversight: docs/specs/07-custody.md "Access control" reserves this class of
 * cross-schema maintenance to "operators: audited break-glass access only" — this function must
 * run under that elevated context, never under either standard app role.
 */
export async function listRetentionCandidates(client: PoolClient, olderThan: Date): Promise<readonly RetentionCandidate[]> {
  const { rows } = await client.query<{ id: string; session_id: string; generation: number; created_at: Date }>(
    `SELECT s.id, s.session_id, s.generation, s.created_at
     FROM custody.snapshots s
     WHERE s.created_at < $1
       AND s.invalidated_at IS NULL
       AND s.generation < (SELECT max(generation) FROM custody.snapshots newest WHERE newest.session_id = s.session_id)
       AND NOT EXISTS (SELECT 1 FROM product.agent_anchors a WHERE a.custody_snapshot_id = s.id)
     ORDER BY s.session_id, s.generation`,
    [olderThan],
  )
  return rows.map((row) => ({ snapshotId: row.id, sessionId: row.session_id, generation: row.generation, createdAt: row.created_at }))
}
