// The resumable feed: an append-only per-Workstream position stream. Reads resume from after a
// position without gaps; a rebuild never truncates positions.
import type pg from 'pg'

export interface FeedRow {
  readonly position: number
  readonly workstreamId: string
  readonly throughSeq: number
  readonly operation: 'upsert' | 'remove' | 'status' | 'reset'
  readonly itemId: string | null
  readonly payload: Record<string, unknown>
  readonly createdAt: Date
}

export async function feedAfter(client: pg.PoolClient | pg.Pool, workstreamId: string, after: number, limit = 500): Promise<readonly FeedRow[]> {
  const result = await client.query(
    `SELECT position, workstream_id, through_seq, operation, item_id, payload, created_at
     FROM feed_events WHERE workstream_id = $1 AND position > $2 ORDER BY position LIMIT $3`,
    [workstreamId, after, limit],
  )
  return result.rows.map((row) => ({
    position: row['position'],
    workstreamId: row['workstream_id'],
    throughSeq: row['through_seq'],
    operation: row['operation'],
    itemId: row['item_id'],
    payload: row['payload'],
    createdAt: row['created_at'],
  }))
}
