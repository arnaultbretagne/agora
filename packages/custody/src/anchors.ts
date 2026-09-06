// Anchors (S9 Step 1 — ADR 0008): one per (Workstream, harness), naming the Save that harness may
// be restored from. Publication is CONDITIONAL on the Anchor still holding the Save the publisher
// believed was current (`expectedPrevious`) and on the frontier not moving backwards — the two
// conditions together are what make a stale capture harmless (CONT-010): it either finds a
// different Save under the Anchor and is rejected, or it carries an equal/lower frontier and is
// rejected. Nothing here decides WHETHER to publish; that is TURN_OFF's conditional step (Step 3).
import type pg from 'pg'

export type AnchorQueryer = pg.Pool | pg.PoolClient

export interface Anchor {
  readonly workstreamId: string
  readonly harnessId: string
  readonly saveId: string
  readonly frontierW: number
  readonly publishedAt: Date
}

export type PublishOutcome =
  | { readonly kind: 'published'; readonly anchor: Anchor }
  /** The Anchor no longer holds `expectedPrevious` — another publication won the race. */
  | { readonly kind: 'rejected_stale_expectation'; readonly current: Anchor }
  /** The candidate proves no more incorporation than what is already published (CONT-010). */
  | { readonly kind: 'rejected_frontier_not_ahead'; readonly current: Anchor }

export interface PublishCommand {
  readonly workstreamId: string
  readonly harnessId: string
  readonly saveId: string
  readonly frontierW: number
  /**
   * The Save this publisher believed the Anchor held, or null when it believed there was none.
   * A publisher that did not look is not allowed to guess: passing the wrong value is exactly the
   * stale-capture case this rejects.
   */
  readonly expectedPrevious: string | null
}

function toAnchor(row: Record<string, unknown>): Anchor {
  return {
    workstreamId: row['workstream_id'] as string,
    harnessId: row['harness_id'] as string,
    saveId: row['save_id'] as string,
    frontierW: Number(row['frontier_w']),
    publishedAt: row['published_at'] as Date,
  }
}

export async function getAnchor(client: AnchorQueryer, workstreamId: string, harnessId: string): Promise<Anchor | null> {
  const result = await client.query('SELECT * FROM anchors WHERE workstream_id = $1 AND harness_id = $2', [workstreamId, harnessId])
  return result.rowCount === 0 ? null : toAnchor(result.rows[0]!)
}

/**
 * Advances the Anchor if, and only if, it still holds `expectedPrevious` AND the candidate's
 * frontier is strictly ahead of what is published. Strictly, not `>=`: an equal frontier proves no
 * additional incorporation, so allowing it would let a stale capture replace a newer Anchor that
 * happens to sit at the same watermark (CONT-010) while gaining nothing when it is not stale.
 */
export async function publishAnchor(client: pg.PoolClient, command: PublishCommand): Promise<PublishOutcome> {
  const current = await client.query('SELECT * FROM anchors WHERE workstream_id = $1 AND harness_id = $2 FOR UPDATE', [
    command.workstreamId,
    command.harnessId,
  ])

  if (current.rowCount === 0) {
    if (command.expectedPrevious !== null) {
      // The publisher expected an Anchor that is not there: its view is stale, and inserting now
      // would publish over a decision it never saw.
      const inserted = await client.query('SELECT * FROM anchors WHERE workstream_id = $1 AND harness_id = $2', [command.workstreamId, command.harnessId])
      return {
        kind: 'rejected_stale_expectation',
        current: inserted.rowCount === 0
          ? { workstreamId: command.workstreamId, harnessId: command.harnessId, saveId: '', frontierW: -1, publishedAt: new Date(0) }
          : toAnchor(inserted.rows[0]!),
      }
    }
    const created = await client.query(
      `INSERT INTO anchors (workstream_id, harness_id, save_id, frontier_w) VALUES ($1,$2,$3,$4) RETURNING *`,
      [command.workstreamId, command.harnessId, command.saveId, command.frontierW],
    )
    return { kind: 'published', anchor: toAnchor(created.rows[0]!) }
  }

  const existing = toAnchor(current.rows[0]!)
  if (existing.saveId !== command.expectedPrevious) {
    return { kind: 'rejected_stale_expectation', current: existing }
  }
  if (command.frontierW <= existing.frontierW) {
    return { kind: 'rejected_frontier_not_ahead', current: existing }
  }

  const updated = await client.query(
    `UPDATE anchors SET save_id = $3, frontier_w = $4, published_at = now()
     WHERE workstream_id = $1 AND harness_id = $2 AND save_id = $5
     RETURNING *`,
    [command.workstreamId, command.harnessId, command.saveId, command.frontierW, command.expectedPrevious],
  )
  if (updated.rowCount === 0) return { kind: 'rejected_stale_expectation', current: existing }
  return { kind: 'published', anchor: toAnchor(updated.rows[0]!) }
}
