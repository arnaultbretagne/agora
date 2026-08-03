import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'

export interface CaptureSnapshotInput {
  readonly snapshotId: string
  readonly sessionId: string
  readonly generation: number
  readonly captureRequestId: string
  readonly formatId: string
  readonly formatVersion: string
  readonly adapterVersion: string
  readonly syncedThroughSeq: number
  readonly contentType?: string
  readonly payload: Uint8Array
  readonly createdAt: Date
}

/**
 * docs/specs/07-custody.md "Capture contract": idempotent by (session, captureRequestId) — a
 * retry with the same capture request id returns the SAME generation/snapshot rather than
 * creating a second one. Payload + metadata commit atomically; the row is invisible until commit.
 */
export async function captureSnapshot(client: PoolClient, input: CaptureSnapshotInput): Promise<{ snapshotId: string }> {
  const sha256 = createHash('sha256').update(input.payload).digest()
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO custody.snapshots
       (id, session_id, generation, capture_request_id, format_id, format_version, adapter_version,
        synced_through_seq, content_type, payload, payload_sha256, size_bytes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (session_id, capture_request_id) DO NOTHING
     RETURNING id`,
    [
      input.snapshotId,
      input.sessionId,
      input.generation,
      input.captureRequestId,
      input.formatId,
      input.formatVersion,
      input.adapterVersion,
      input.syncedThroughSeq,
      input.contentType ?? 'application/octet-stream',
      Buffer.from(input.payload),
      sha256,
      input.payload.length,
      input.createdAt,
    ],
  )
  const insertedRow = inserted.rows[0]
  if (insertedRow) return { snapshotId: insertedRow.id }

  const existing = await client.query<{ id: string }>(
    'SELECT id FROM custody.snapshots WHERE session_id = $1 AND capture_request_id = $2',
    [input.sessionId, input.captureRequestId],
  )
  const existingRow = existing.rows[0]
  if (!existingRow) throw new Error('unreachable: ON CONFLICT target guarantees a prior row exists')
  return { snapshotId: existingRow.id }
}

export interface RestoredSnapshot {
  readonly payload: Uint8Array
  readonly formatId: string
  readonly formatVersion: string
  readonly sha256: string
}

/** docs/specs/07-custody.md "Restore contract" step 4: stream while verifying size and checksum. */
export async function restoreSnapshot(client: PoolClient, snapshotId: string): Promise<RestoredSnapshot> {
  const { rows } = await client.query<{
    payload: Buffer
    payload_sha256: Buffer
    size_bytes: number
    format_id: string
    format_version: string
  }>('SELECT payload, payload_sha256, size_bytes, format_id, format_version FROM custody.snapshots WHERE id = $1', [
    snapshotId,
  ])
  const row = rows[0]
  if (!row) throw new Error(`snapshot ${snapshotId} not found`)
  if (row.payload.length !== row.size_bytes) {
    throw new Error(`snapshot ${snapshotId} size mismatch: expected ${row.size_bytes}, got ${row.payload.length}`)
  }
  const actualSha256 = createHash('sha256').update(row.payload).digest('hex')
  const expectedSha256 = row.payload_sha256.toString('hex')
  if (actualSha256 !== expectedSha256) {
    throw new Error(`snapshot ${snapshotId} checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`)
  }
  return { payload: row.payload, formatId: row.format_id, formatVersion: row.format_version, sha256: expectedSha256 }
}

export async function invalidateSnapshot(
  client: PoolClient,
  snapshotId: string,
  reason: string,
  invalidatedAt: Date,
): Promise<void> {
  await client.query('UPDATE custody.snapshots SET invalidated_at = $2, invalidation_reason = $3 WHERE id = $1', [
    snapshotId,
    invalidatedAt,
    reason,
  ])
}
