import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'

export interface ProjectorCheckpoint {
  readonly throughWorkstreamSeq: number
  readonly lastEventId: string | null
}

export async function getCheckpoint(
  client: PoolClient,
  projectorName: string,
  workstreamId: string,
): Promise<ProjectorCheckpoint> {
  const { rows } = await client.query<{ through_workstream_seq: number; last_event_id: string | null }>(
    'SELECT through_workstream_seq, last_event_id FROM projection.projector_checkpoints WHERE projector_name = $1 AND workstream_id = $2',
    [projectorName, workstreamId],
  )
  const row = rows[0]
  return row
    ? { throughWorkstreamSeq: row.through_workstream_seq, lastEventId: row.last_event_id }
    : { throughWorkstreamSeq: 0, lastEventId: null }
}

export async function advanceCheckpoint(
  client: PoolClient,
  projectorName: string,
  workstreamId: string,
  projectorVersion: string,
  throughWorkstreamSeq: number,
  lastEventId: string,
  updatedAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO projection.projector_checkpoints
       (projector_name, workstream_id, projector_version, through_workstream_seq, last_event_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (projector_name, workstream_id) DO UPDATE SET
       projector_version = EXCLUDED.projector_version,
       through_workstream_seq = EXCLUDED.through_workstream_seq,
       last_event_id = EXCLUDED.last_event_id,
       updated_at = EXCLUDED.updated_at`,
    [projectorName, workstreamId, projectorVersion, throughWorkstreamSeq, lastEventId, updatedAt],
  )
}

export interface AppendFeedEventInput {
  readonly workstreamId: string
  readonly throughWorkstreamSeq: number
  readonly operation: 'upsert' | 'remove' | 'status' | 'reset'
  readonly itemId?: string
  readonly payload: Record<string, unknown>
  readonly createdAt: Date
}

/** Returns the durable, monotonically increasing feed position (never reused or decreased). */
export async function appendFeedEvent(client: PoolClient, input: AppendFeedEventInput): Promise<number> {
  const { rows } = await client.query<{ position: number }>(
    `INSERT INTO projection.feed_events (workstream_id, through_workstream_seq, operation, item_id, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING position`,
    [input.workstreamId, input.throughWorkstreamSeq, input.operation, input.itemId ?? null, JSON.stringify(input.payload), input.createdAt],
  )
  const row = rows[0]
  if (!row) throw new Error('unreachable: INSERT ... RETURNING always returns one row')
  return row.position
}

/**
 * Truncates ONLY rebuildable projection state (item spine + satellites via cascade, turns,
 * checkpoint) — `projection.feed_events` is never touched, so its position sequence stays
 * monotonic across a rebuild (docs/specs/05-journal-and-projections.md "Rebuild").
 */
export async function resetProjection(client: PoolClient, workstreamId: string): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query('DELETE FROM projection.workstream_items WHERE workstream_id = $1', [workstreamId])
    await client.query('DELETE FROM projection.turns WHERE workstream_id = $1', [workstreamId])
    await client.query('DELETE FROM projection.projector_checkpoints WHERE workstream_id = $1', [workstreamId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

/**
 * A deterministic content hash of a Workstream's rebuildable projection state, ordered so it is
 * independent of physical row order. docs/specs/05: "Production MUST periodically prove rebuild
 * equivalence on a representative snapshot" — this is that equivalence proof's building block.
 */
export async function computeProjectionHash(client: PoolClient, workstreamId: string): Promise<string> {
  const { rows: items } = await client.query<{ id: string; item_kind: string; content_sha256: Buffer }>(
    'SELECT id, item_kind, content_sha256 FROM projection.workstream_items WHERE workstream_id = $1 ORDER BY id',
    [workstreamId],
  )
  const { rows: turns } = await client.query<{ id: string; status: string; stop_reason: string | null }>(
    'SELECT id, status, stop_reason FROM projection.turns WHERE workstream_id = $1 ORDER BY id',
    [workstreamId],
  )
  const hash = createHash('sha256')
  for (const item of items) hash.update(`item:${item.id}:${item.item_kind}:${item.content_sha256.toString('hex')}\n`)
  for (const turn of turns) hash.update(`turn:${turn.id}:${turn.status}:${turn.stop_reason ?? ''}\n`)
  return hash.digest('hex')
}
