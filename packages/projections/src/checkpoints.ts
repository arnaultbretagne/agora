// Carried over from archive/pre-design-cleanup-2026-09-05:packages/store-pg/src/projections.ts
// (commit df00ca4 tree, checkpoint upsert); changes: generic over the S3 checkpoint columns
// (projector, workstream_id, projector_version, through_seq) instead of the retired event model.
import type pg from 'pg'

export interface ProjectorCheckpoint {
  readonly projectorVersion: string
  readonly throughSeq: number
}

export async function getCheckpoint(client: pg.PoolClient, projector: string, workstreamId: string): Promise<ProjectorCheckpoint | null> {
  const result = await client.query<{ projector_version: string; through_seq: number }>(
    'SELECT projector_version, through_seq FROM projection_checkpoints WHERE projector = $1 AND workstream_id = $2',
    [projector, workstreamId],
  )
  const row = result.rows[0]
  return row ? { projectorVersion: row.projector_version, throughSeq: row.through_seq } : null
}

export async function advanceCheckpoint(client: pg.PoolClient, projector: string, workstreamId: string, checkpoint: ProjectorCheckpoint): Promise<void> {
  await client.query(
    `INSERT INTO projection_checkpoints (projector, workstream_id, projector_version, through_seq, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (projector, workstream_id) DO UPDATE SET
       projector_version = EXCLUDED.projector_version,
       through_seq = EXCLUDED.through_seq,
       updated_at = now()`,
    [projector, workstreamId, checkpoint.projectorVersion, checkpoint.throughSeq],
  )
}

export async function deleteCheckpoint(client: pg.PoolClient, projector: string, workstreamId: string): Promise<void> {
  await client.query('DELETE FROM projection_checkpoints WHERE projector = $1 AND workstream_id = $2', [projector, workstreamId])
}
