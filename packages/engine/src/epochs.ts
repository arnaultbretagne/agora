// Mutation epochs (engine.md — Work generations, claims and leases): issued on claim transfer,
// after the old owner's dispatched attempts are enumerated and marked for recovery. Owners reject
// any request carrying an older epoch.
import type pg from 'pg'
import type { QueryClient } from './db.js'

export interface IssuedEpoch {
  readonly epoch: number
  readonly takeoverCount: number
}

export async function currentEpoch(client: QueryClient, workstreamId: string): Promise<number> {
  const result = await client.query('SELECT epoch FROM mutation_epochs WHERE workstream_id = $1', [workstreamId])
  return result.rows[0]?.['epoch'] ?? 0
}

/**
 * Issues the next epoch for the Workstream and marks every still-dispatched attempt of the old
 * owner with the recovery owner. The takeover does not settle anything: the new owner may observe
 * and close unsafe access, never start conflicting positive effects until each marked attempt is
 * settled or superseded (ENGINE-006).
 */
export async function issueEpoch(client: QueryClient, workstreamId: string, ownerClaim: string, nowSql = 'now()'): Promise<IssuedEpoch> {
  await client.query('BEGIN')
  try {
    const locked = await client.query('SELECT epoch FROM mutation_epochs WHERE workstream_id = $1 FOR UPDATE', [workstreamId])
    const previous: number = locked.rows[0]?.['epoch'] ?? 0
    const epoch = previous + 1
    const takeover = await client.query(
      `UPDATE owner_attempts SET recovery_owner = $2
       WHERE workstream_id = $1 AND state IN ('dispatched', 'unknown')`,
      [workstreamId, ownerClaim],
    )
    if (locked.rowCount === 0) {
      await client.query(
        `INSERT INTO mutation_epochs (workstream_id, epoch, owner_claim, issued_at) VALUES ($1, $2, $3, ${nowSql})`,
        [workstreamId, epoch, ownerClaim],
      )
    } else {
      await client.query(
        `UPDATE mutation_epochs SET epoch = $2, owner_claim = $3, issued_at = ${nowSql} WHERE workstream_id = $1`,
        [workstreamId, epoch, ownerClaim],
      )
    }
    await client.query('COMMIT')
    return { epoch, takeoverCount: takeover.rowCount ?? 0 }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}
