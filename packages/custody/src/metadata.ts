import type { PoolClient } from 'pg'

/**
 * Non-opaque custody metadata only (docs/specs/07-custody.md "Opacity") — deliberately has no
 * `payload` field/column anywhere in this file. Matches the `agora_custody_meta` DB role
 * (contracts/database/002-access.sql), which is granted SELECT on every column except `payload`.
 */
export interface CustodySnapshotMetadata {
  readonly id: string
  readonly sessionId: string
  readonly generation: number
  readonly captureRequestId: string
  readonly formatId: string
  readonly formatVersion: string
  readonly adapterVersion: string
  readonly syncedThroughSeq: number
  readonly contentType: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly createdAt: Date
  readonly invalidatedAt: Date | null
  readonly invalidationReason: string | null
}

interface MetadataRow {
  readonly id: string
  readonly session_id: string
  readonly generation: number
  readonly capture_request_id: string
  readonly format_id: string
  readonly format_version: string
  readonly adapter_version: string
  readonly synced_through_seq: number
  readonly content_type: string
  readonly payload_sha256: Buffer
  readonly size_bytes: number
  readonly created_at: Date
  readonly invalidated_at: Date | null
  readonly invalidation_reason: string | null
}

function hydrate(row: MetadataRow): CustodySnapshotMetadata {
  return {
    id: row.id,
    sessionId: row.session_id,
    generation: row.generation,
    captureRequestId: row.capture_request_id,
    formatId: row.format_id,
    formatVersion: row.format_version,
    adapterVersion: row.adapter_version,
    syncedThroughSeq: row.synced_through_seq,
    contentType: row.content_type,
    sha256: row.payload_sha256.toString('hex'),
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    invalidatedAt: row.invalidated_at,
    invalidationReason: row.invalidation_reason,
  }
}

const METADATA_COLUMNS = `
  id, session_id, generation, capture_request_id, format_id, format_version, adapter_version,
  synced_through_seq, content_type, payload_sha256, size_bytes, created_at, invalidated_at, invalidation_reason
`

export async function getLatestSnapshotMetadata(
  client: PoolClient,
  sessionId: string,
): Promise<CustodySnapshotMetadata | undefined> {
  const { rows } = await client.query<MetadataRow>(
    `SELECT ${METADATA_COLUMNS} FROM custody.snapshots
     WHERE session_id = $1 AND invalidated_at IS NULL
     ORDER BY generation DESC LIMIT 1`,
    [sessionId],
  )
  return rows[0] ? hydrate(rows[0]) : undefined
}

export async function listSnapshotMetadata(client: PoolClient, sessionId: string): Promise<readonly CustodySnapshotMetadata[]> {
  const { rows } = await client.query<MetadataRow>(
    `SELECT ${METADATA_COLUMNS} FROM custody.snapshots WHERE session_id = $1 ORDER BY generation`,
    [sessionId],
  )
  return rows.map(hydrate)
}
