// Save metadata (S9 Step 1 — ADR 0008, continuity.md). A Save is immutable: it records what a
// driver actually captured, and nothing about who later restored it (there is deliberately no
// consumer or `restored_into` column). Recording is keyed by the capture key
// `(pod_uid, process_generation, context_id, frontier_w, driver_revision)`: repeating the same
// capture DISCOVERS the same Save instead of writing a second one, and the same key carrying a
// different payload is a conflict rather than a silent overwrite — the same shape the owner request
// protocol already uses for "an idempotent retry versus a different request under a reused key".
import { randomUUID } from 'node:crypto'
import type pg from 'pg'

export type SaveQueryer = pg.Pool | pg.PoolClient

/** The identity of one capture attempt. Two captures agreeing on all five are the same capture. */
export interface CaptureKey {
  readonly podUid: string
  readonly processGeneration: number
  readonly contextId: string
  /**
   * What the driver PROVED was incorporated at the quiescent cut — never a copy of the journal head
   * (CONT-009). A capture that cannot prove incorporation reports a lower frontier, and the Anchor
   * publication below refuses to move backwards because of it.
   */
  readonly frontierW: number
  readonly driverRevision: string
}

export interface SaveMetadata {
  readonly workstreamId: string
  /** The Session that produced the capture. A restore always belongs to a NEW Session (CONT-003). */
  readonly sessionId: string
  readonly harnessId: string
  readonly formatId: string
  readonly formatVersion: number
  readonly imageDigest: string
  readonly byteLength: number
  readonly checksum: string
  readonly seedPolicyRevision: string
  readonly nativeOrigin: unknown
  readonly workspaceDeps: unknown
}

export interface Save extends SaveMetadata, CaptureKey {
  readonly id: string
  readonly createdAt: Date
}

export class CaptureKeyConflictError extends Error {
  readonly code = 'capture_key_conflict'

  constructor(
    readonly existingSaveId: string,
    readonly recordedChecksum: string,
  ) {
    super(`the capture key already holds Save ${existingSaveId} with a different payload (checksum ${recordedChecksum})`)
    this.name = 'CaptureKeyConflictError'
  }
}

export interface RecordedSave {
  readonly save: Save
  /** False when this call discovered a Save an earlier, identical capture had already recorded. */
  readonly created: boolean
}

function toSave(row: Record<string, unknown>): Save {
  return {
    id: row['id'] as string,
    workstreamId: row['workstream_id'] as string,
    sessionId: row['session_id'] as string,
    harnessId: row['harness_id'] as string,
    formatId: row['format_id'] as string,
    formatVersion: row['format_version'] as number,
    driverRevision: row['driver_revision'] as string,
    imageDigest: row['image_digest'] as string,
    byteLength: Number(row['byte_length']),
    checksum: row['checksum'] as string,
    frontierW: Number(row['frontier_w']),
    seedPolicyRevision: row['seed_policy_revision'] as string,
    nativeOrigin: row['native_origin'],
    workspaceDeps: row['workspace_deps'],
    podUid: row['pod_uid'] as string,
    processGeneration: row['process_generation'] as number,
    contextId: row['context_id'] as string,
    createdAt: row['created_at'] as Date,
  }
}

/**
 * Records the Save metadata, or returns the one an identical earlier capture already recorded.
 * The checksum decides which of those it is: the same key with the same checksum is the same
 * capture arriving twice; the same key with a DIFFERENT checksum is a conflict and is refused,
 * because silently keeping either one would make the bytes and the metadata disagree.
 */
export async function recordSave(client: pg.PoolClient, key: CaptureKey, metadata: SaveMetadata): Promise<RecordedSave> {
  const existing = await findSaveByCaptureKey(client, key)
  if (existing !== null) {
    if (existing.checksum !== metadata.checksum) throw new CaptureKeyConflictError(existing.id, existing.checksum)
    return { save: existing, created: false }
  }

  const id = randomUUID()
  const inserted = await client.query(
    `INSERT INTO saves (
       id, workstream_id, session_id, harness_id, format_id, format_version, driver_revision,
       image_digest, byte_length, checksum, frontier_w, seed_policy_revision, native_origin,
       workspace_deps, pod_uid, process_generation, context_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17)
     RETURNING *`,
    [
      id,
      metadata.workstreamId,
      metadata.sessionId,
      metadata.harnessId,
      metadata.formatId,
      metadata.formatVersion,
      key.driverRevision,
      metadata.imageDigest,
      metadata.byteLength,
      metadata.checksum,
      key.frontierW,
      metadata.seedPolicyRevision,
      JSON.stringify(metadata.nativeOrigin ?? {}),
      JSON.stringify(metadata.workspaceDeps ?? {}),
      key.podUid,
      key.processGeneration,
      key.contextId,
    ],
  )
  return { save: toSave(inserted.rows[0]!), created: true }
}

export async function findSaveByCaptureKey(client: SaveQueryer, key: CaptureKey): Promise<Save | null> {
  const result = await client.query(
    `SELECT * FROM saves
     WHERE pod_uid = $1 AND process_generation = $2 AND context_id = $3 AND frontier_w = $4 AND driver_revision = $5`,
    [key.podUid, key.processGeneration, key.contextId, key.frontierW, key.driverRevision],
  )
  return result.rowCount === 0 ? null : toSave(result.rows[0]!)
}

export async function getSave(client: SaveQueryer, saveId: string): Promise<Save | null> {
  const result = await client.query('SELECT * FROM saves WHERE id = $1', [saveId])
  return result.rowCount === 0 ? null : toSave(result.rows[0]!)
}
