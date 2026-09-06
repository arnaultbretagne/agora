// Save invalidations (S9 Step 1 — CONT-008). Append-only evidence that a Save must not be used,
// either at all or only under one driver revision. The distinction this file exists to keep is the
// one CONT-008 names: a VERIFIED incompatibility excludes the exact Save/driver pair forever, while
// a temporary store outage excludes nothing — so a transient failure can never quietly become a
// permanent exclusion. Nothing here ever deletes: an invalidation is evidence, and evidence that
// can be removed is not evidence.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'

export type InvalidationQueryer = pg.Pool | pg.PoolClient

export interface Invalidation {
  readonly id: string
  readonly saveId: string
  /** null invalidates the Save for every driver revision; a value scopes it to that revision only. */
  readonly driverRevision: string | null
  readonly cause: string
  readonly verifier: string
  readonly target: string
  readonly at: Date
}

export interface InvalidateCommand {
  readonly saveId: string
  readonly driverRevision?: string | null
  /** What was actually verified — not "restore failed", but why it can never succeed. */
  readonly cause: string
  /** Who established it (an owner, a driver, an operator): evidence without a source is not evidence. */
  readonly verifier: string
  /** What it was verified against (an image digest, a driver revision, a workspace dependency). */
  readonly target: string
}

function toInvalidation(row: Record<string, unknown>): Invalidation {
  return {
    id: row['id'] as string,
    saveId: row['save_id'] as string,
    driverRevision: (row['driver_revision'] as string | null) ?? null,
    cause: row['cause'] as string,
    verifier: row['verifier'] as string,
    target: row['target'] as string,
    at: row['at'] as Date,
  }
}

export async function invalidate(client: pg.PoolClient, command: InvalidateCommand): Promise<Invalidation> {
  const inserted = await client.query(
    `INSERT INTO save_invalidations (id, save_id, driver_revision, cause, verifier, target)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [randomUUID(), command.saveId, command.driverRevision ?? null, command.cause, command.verifier, command.target],
  )
  return toInvalidation(inserted.rows[0]!)
}

export async function invalidationsFor(client: InvalidationQueryer, saveId: string): Promise<readonly Invalidation[]> {
  const result = await client.query('SELECT * FROM save_invalidations WHERE save_id = $1 ORDER BY at', [saveId])
  return result.rows.map(toInvalidation)
}

/**
 * Whether this exact (Save, driver revision) pair is excluded. A revision-scoped invalidation does
 * NOT exclude the Save under a different driver revision — that is the "exact pair" rule, and it is
 * what lets a fixed driver make an old Save usable again without rewriting history.
 */
export async function isExcluded(client: InvalidationQueryer, saveId: string, driverRevision: string): Promise<boolean> {
  const result = await client.query(
    'SELECT 1 FROM save_invalidations WHERE save_id = $1 AND (driver_revision IS NULL OR driver_revision = $2) LIMIT 1',
    [saveId, driverRevision],
  )
  return (result.rowCount ?? 0) > 0
}
