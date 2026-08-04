import process from 'node:process'
import type pg from 'pg'
import { listRetentionCandidates } from './anchors.js'
import { createPool, requireDatabaseUrl } from './db.js'

export interface RetentionSweepResult {
  readonly deletedSnapshotIds: readonly string[]
}

/**
 * docs/specs/07-custody.md "Retention": deletes only what `listRetentionCandidates` already proved
 * safe (older, un-anchored, non-newest generations past `graceMs`). Per that function's own note,
 * this spans `product.agent_anchors` and `custody.snapshots` — no standard app role can read both,
 * so this MUST run under an elevated/operator connection (mirrors `migrate.ts`'s own pattern), never
 * under `apps/web`'s or the controller's normal request-serving pool.
 */
export async function sweepCustodyRetention(pool: pg.Pool, now: Date, graceMs: number): Promise<RetentionSweepResult> {
  const olderThan = new Date(now.getTime() - graceMs)
  const client = await pool.connect()
  try {
    const candidates = await listRetentionCandidates(client, olderThan)
    const deletedSnapshotIds: string[] = []
    for (const candidate of candidates) {
      await client.query('DELETE FROM custody.snapshots WHERE id = $1', [candidate.snapshotId])
      deletedSnapshotIds.push(candidate.snapshotId)
    }
    return { deletedSnapshotIds }
  } finally {
    client.release()
  }
}

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href

if (isMain) {
  const graceMs = process.env.CUSTODY_RETENTION_GRACE_MS ? Number(process.env.CUSTODY_RETENTION_GRACE_MS) : DEFAULT_GRACE_MS
  const pool = createPool(requireDatabaseUrl())
  try {
    const result = await sweepCustodyRetention(pool, new Date(), graceMs)
    console.log(`deleted ${result.deletedSnapshotIds.length} unreferenced custody snapshot(s)`)
  } finally {
    await pool.end()
  }
}
