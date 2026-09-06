// Catalogue revision publication (S10 Step 3 — engine.md "Intent authoring and revision selection",
// SESSION-A11, ENGINE-014).
//
// Publishing a reviewed revision is a first-class wake, not a deployment side effect. Three things
// have to be true, and each is a separate step here because each can fail on its own:
//
//   1. the SELECTION becomes durable, so every worker resolves the same revision whatever its own
//      container image happens to carry (SESSION-A11);
//   2. every affected Workstream is durably recorded as owed a wake — including idle ones, which is
//      the case a workset-only enumeration misses and the case that matters;
//   3. those wakes are delivered in bounded batches, resumable after a crash.
//
// Nothing here decides WHETHER a Workstream needs new work: it re-enqueues, and the rule tables then
// look at fresh evidence under the new revision and select whatever that implies (a re-pinned digest
// becomes CONSTRUCT-002 on its own, without publication naming the verb).
import { randomUUID } from 'node:crypto'
import type pg from 'pg'

export type PublicationQueryer = pg.Pool | pg.PoolClient

export type RevisionSet = Readonly<Record<string, unknown>>

export interface SelectedRevision {
  readonly revisionId: string
  readonly revisionSet: RevisionSet
  readonly selectedAt: Date
}

export interface Publication {
  readonly id: string
  readonly revisionId: string
  readonly state: 'enumerating' | 'enqueuing' | 'complete'
  readonly cursorWorkstreamId: string | null
}

export interface PublishCommand {
  readonly revisionId: string
  readonly revisionSet: RevisionSet
}

/** How many Workstreams one enumeration or re-enqueue pass touches. Bounded work, always. */
export const DEFAULT_BATCH_SIZE = 100

function toPublication(row: Record<string, unknown>): Publication {
  return {
    id: row['id'] as string,
    revisionId: row['revision_id'] as string,
    state: row['state'] as Publication['state'],
    cursorWorkstreamId: (row['cursor_workstream_id'] as string | null) ?? null,
  }
}

/** The selection every worker resolves against. Null before any revision has been published. */
export async function selectedRevision(client: PublicationQueryer): Promise<SelectedRevision | null> {
  const result = await client.query('SELECT revision_id, revision_set, selected_at FROM selected_revision WHERE singleton')
  if (result.rowCount === 0) return null
  const row = result.rows[0]!
  return { revisionId: row['revision_id'] as string, revisionSet: row['revision_set'] as RevisionSet, selectedAt: row['selected_at'] as Date }
}

/**
 * Records the new selection and opens a publication for it. Idempotent on the revision id:
 * publishing the same revision twice discovers the existing publication rather than enumerating a
 * second one, so a retried operator request cannot double the work.
 *
 * The selection is updated in the SAME transaction that opens the publication. That ordering is the
 * point of ENGINE-014: from this commit onwards, a mutation or admission resolved under the previous
 * revision is obsolete and is rejected immediately — it does not wait for the sweep to reach its
 * Workstream.
 */
export async function publishRevision(client: pg.PoolClient, command: PublishCommand): Promise<Publication> {
  const existing = await client.query('SELECT * FROM revision_publications WHERE revision_id = $1', [command.revisionId])
  if (existing.rowCount !== 0) return toPublication(existing.rows[0]!)

  await client.query(
    `INSERT INTO selected_revision (singleton, revision_id, revision_set) VALUES (true, $1, $2::jsonb)
     ON CONFLICT (singleton) DO UPDATE SET revision_id = EXCLUDED.revision_id, revision_set = EXCLUDED.revision_set, selected_at = now()`,
    [command.revisionId, JSON.stringify(command.revisionSet)],
  )
  const inserted = await client.query(
    `INSERT INTO revision_publications (id, revision_id, revision_set) VALUES ($1, $2, $3::jsonb) RETURNING *`,
    [randomUUID(), command.revisionId, JSON.stringify(command.revisionSet)],
  )
  return toPublication(inserted.rows[0]!)
}

export interface EnumerationResult {
  readonly recorded: number
  readonly done: boolean
}

/**
 * Records the next batch of affected Workstreams. Enumeration walks the Workstream index in id
 * order — the desired-state index, not the workset — so a Workstream with no work row is recorded
 * exactly like a busy one. The cursor advances with the batch, in the same transaction as the rows
 * it describes, so a crash resumes at the last Workstream actually written and never re-enumerates
 * from the start or skips a page.
 */
export async function enumerateTargets(client: pg.PoolClient, publicationId: string, batchSize = DEFAULT_BATCH_SIZE): Promise<EnumerationResult> {
  const publication = await client.query('SELECT * FROM revision_publications WHERE id = $1 FOR UPDATE', [publicationId])
  if (publication.rowCount === 0) throw new Error(`no publication ${publicationId}`)
  const current = toPublication(publication.rows[0]!)
  if (current.state !== 'enumerating') return { recorded: 0, done: true }

  const page = await client.query(
    `SELECT id FROM workstreams WHERE ($2::uuid IS NULL OR id > $2::uuid) ORDER BY id LIMIT $1`,
    [batchSize, current.cursorWorkstreamId],
  )
  if (page.rowCount === 0) {
    await client.query(`UPDATE revision_publications SET state = 'enqueuing' WHERE id = $1`, [publicationId])
    return { recorded: 0, done: true }
  }

  const ids = page.rows.map((row) => (row as { id: string }).id)
  await client.query(
    `INSERT INTO publication_targets (publication_id, workstream_id)
     SELECT $1, unnest($2::uuid[])
     ON CONFLICT (publication_id, workstream_id) DO NOTHING`,
    [publicationId, ids],
  )
  await client.query('UPDATE revision_publications SET cursor_workstream_id = $2 WHERE id = $1', [publicationId, ids.at(-1)])
  return { recorded: ids.length, done: false }
}

export interface EnqueueResult {
  readonly enqueued: number
  readonly done: boolean
}

/**
 * Wakes the next batch of recorded targets. Each gets a FRESH work generation, which is what makes
 * the wake real rather than cosmetic: an in-flight claim under the old generation can no longer
 * finalize over it (ENGINE-005's own fencing, reused here).
 *
 * A Workstream with no work row gets one; a Workstream with an existing row keeps its `intent_seq`
 * (publication does not author an Intent, and the trigger would refuse a decrease anyway) and is
 * simply made due now.
 */
export async function enqueueTargets(client: pg.PoolClient, publicationId: string, batchSize = DEFAULT_BATCH_SIZE): Promise<EnqueueResult> {
  const publication = await client.query('SELECT * FROM revision_publications WHERE id = $1 FOR UPDATE', [publicationId])
  if (publication.rowCount === 0) throw new Error(`no publication ${publicationId}`)
  if (toPublication(publication.rows[0]!).state === 'enumerating') return { enqueued: 0, done: false }

  const page = await client.query(
    `SELECT workstream_id FROM publication_targets
     WHERE publication_id = $1 AND state = 'pending' ORDER BY workstream_id LIMIT $2`,
    [publicationId, batchSize],
  )
  if (page.rowCount === 0) {
    await client.query(`UPDATE revision_publications SET state = 'complete', completed_at = now() WHERE id = $1`, [publicationId])
    return { enqueued: 0, done: true }
  }

  for (const row of page.rows) {
    const workstreamId = (row as { workstream_id: string }).workstream_id
    await client.query(
      `INSERT INTO workstream_reconciliation_work (workstream_id, intent_seq, work_generation, due_at, claim_token, lease_until)
       VALUES ($1, coalesce((SELECT max(intent_seq) FROM workstream_intent_events WHERE workstream_id = $1), 0), nextval('work_generation_seq'), now(), NULL, NULL)
       ON CONFLICT (workstream_id) DO UPDATE SET
         work_generation = nextval('work_generation_seq'),
         due_at = now(),
         claim_token = NULL,
         lease_until = NULL,
         updated_at = now()`,
      [workstreamId],
    )
    await client.query(
      `UPDATE publication_targets SET state = 'enqueued', enqueued_at = now() WHERE publication_id = $1 AND workstream_id = $2`,
      [publicationId, workstreamId],
    )
  }
  return { enqueued: page.rowCount ?? 0, done: false }
}

/**
 * Drives one publication to completion in bounded passes. Safe to call repeatedly and from a sweep:
 * every pass is a fresh transaction over the durable cursor, so a crash costs at most one batch of
 * repeated work and never loses a target.
 */
export async function advancePublication(
  pool: pg.Pool,
  publicationId: string,
  options: { readonly batchSize?: number; readonly maxPasses?: number } = {},
): Promise<Publication> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxPasses = options.maxPasses ?? 1000
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const client = await pool.connect()
    let finished = false
    try {
      await client.query('BEGIN')
      const enumeration = await enumerateTargets(client, publicationId, batchSize)
      if (enumeration.done) {
        const enqueue = await enqueueTargets(client, publicationId, batchSize)
        finished = enqueue.done
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    if (finished) break
  }
  const final = await pool.query('SELECT * FROM revision_publications WHERE id = $1', [publicationId])
  return toPublication(final.rows[0]!)
}

/** Publications that still owe work — what a sweep resumes after a restart. */
export async function unfinishedPublications(client: PublicationQueryer): Promise<readonly Publication[]> {
  const result = await client.query(`SELECT * FROM revision_publications WHERE state <> 'complete' ORDER BY published_at`)
  return result.rows.map((row) => toPublication(row as Record<string, unknown>))
}

/**
 * The fence every mutation and admission check runs (ENGINE-014). A resolution carrying a revision
 * id that is no longer the selected one is obsolete the moment the selection commits — it is
 * rejected here, immediately, rather than waiting for the publication sweep to reach its Workstream.
 * An absent selection accepts anything: a deployment that has never published one has no revision to
 * be stale against, and refusing everything would make publication a prerequisite for first boot.
 */
export async function isRevisionCurrent(client: PublicationQueryer, revisionId: string | null): Promise<boolean> {
  const selected = await selectedRevision(client)
  if (selected === null) return true
  return revisionId === selected.revisionId
}
