// Workset operations (engine contract "Work generations, claims and leases"): bounded atomic
// claims, and renew/release/reschedule/finalize updates that compare the exact claim token AND
// work generation. Zero rows affected always means the claim was lost or a newer obligation
// exists — never an error to retry blindly. All time decisions read database time only.
import type { QueryClient } from './db.js'
import { notifyTick, type EngineTimeOptions } from './authoring.js'

export interface WorkRowRef {
  readonly workstreamId: string
  readonly claimToken: string
  readonly workGeneration: number
}

export interface ClaimedWorkRow {
  readonly workstreamId: string
  readonly intentSeq: number
  readonly workGeneration: number
  readonly dueAt: Date
  readonly claimToken: string
  readonly leaseUntil: Date
  readonly attemptCount: number
  readonly blockingCause: string | null
  readonly lastError: Readonly<Record<string, unknown>> | null
}

export interface ClaimOptions extends EngineTimeOptions {
  readonly limit: number
  readonly leaseMs: number
}

export async function claimDue(client: QueryClient, options: ClaimOptions): Promise<ClaimedWorkRow[]> {
  const now = options.nowSql ?? 'now()'
  const result = await client.query(
    `UPDATE workstream_reconciliation_work AS w
     SET claim_token = gen_random_uuid(),
         lease_until = ${now} + make_interval(secs => $1),
         updated_at = ${now}
     WHERE w.workstream_id IN (
       SELECT c.workstream_id FROM workstream_reconciliation_work c
       WHERE c.due_at <= ${now} AND (c.claim_token IS NULL OR c.lease_until < ${now})
       ORDER BY c.due_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING w.workstream_id, w.intent_seq, w.work_generation, w.due_at,
               w.claim_token, w.lease_until, w.attempt_count, w.blocking_cause, w.last_error`,
    [options.leaseMs / 1000, options.limit],
  )
  return result.rows.map((row) => ({
    workstreamId: row['workstream_id'],
    intentSeq: row['intent_seq'],
    workGeneration: row['work_generation'],
    dueAt: row['due_at'],
    claimToken: row['claim_token'],
    leaseUntil: row['lease_until'],
    attemptCount: row['attempt_count'],
    blockingCause: row['blocking_cause'],
    lastError: row['last_error'],
  }))
}

export async function renew(client: QueryClient, ref: WorkRowRef, leaseMs: number, options: EngineTimeOptions = {}): Promise<boolean> {
  const now = options.nowSql ?? 'now()'
  const result = await client.query(
    `UPDATE workstream_reconciliation_work
     SET lease_until = ${now} + make_interval(secs => $1), updated_at = ${now}
     WHERE workstream_id = $2 AND claim_token = $3 AND work_generation = $4`,
    [leaseMs / 1000, ref.workstreamId, ref.claimToken, ref.workGeneration],
  )
  return result.rowCount === 1
}

export interface ReleaseOptions extends EngineTimeOptions {
  /** A released row is immediately due again: the continuation tick re-evaluates from POWER. */
  readonly dueNow?: boolean | undefined
}

export async function release(client: QueryClient, ref: WorkRowRef, options: ReleaseOptions = {}): Promise<boolean> {
  const now = options.nowSql ?? 'now()'
  const result = await client.query(
    `UPDATE workstream_reconciliation_work
     SET claim_token = NULL,
         lease_until = NULL,
         due_at = CASE WHEN $1 THEN ${now} ELSE due_at END,
         updated_at = ${now}
     WHERE workstream_id = $2 AND claim_token = $3 AND work_generation = $4`,
    [options.dueNow === true, ref.workstreamId, ref.claimToken, ref.workGeneration],
  )
  return result.rowCount === 1
}

export interface RescheduleCommand extends EngineTimeOptions {
  readonly delayMs: number
  readonly attemptCount: number
  readonly blockingCause: string | null
  readonly lastError: Readonly<Record<string, unknown>> | null
}

export async function reschedule(client: QueryClient, ref: WorkRowRef, command: RescheduleCommand): Promise<boolean> {
  const now = command.nowSql ?? 'now()'
  const result = await client.query(
    `UPDATE workstream_reconciliation_work
     SET claim_token = NULL,
         lease_until = NULL,
         due_at = ${now} + make_interval(secs => $1),
         attempt_count = $2,
         blocking_cause = $3,
         last_error = $4::jsonb,
         updated_at = ${now}
     WHERE workstream_id = $5 AND claim_token = $6 AND work_generation = $7`,
    [
      command.delayMs / 1000,
      command.attemptCount,
      command.blockingCause,
      command.lastError === null ? null : JSON.stringify(command.lastError),
      ref.workstreamId,
      ref.claimToken,
      ref.workGeneration,
    ],
  )
  return result.rowCount === 1
}

export interface FinalizeRef extends WorkRowRef {
  readonly intentSeq: number
}

export async function finalize(client: QueryClient, ref: FinalizeRef): Promise<boolean> {
  const result = await client.query(
    `DELETE FROM workstream_reconciliation_work
     WHERE workstream_id = $1 AND intent_seq = $2 AND work_generation = $3 AND claim_token = $4`,
    [ref.workstreamId, ref.intentSeq, ref.workGeneration, ref.claimToken],
  )
  return result.rowCount === 1
}

export type DriftWakeOutcome = 'woke' | 'enqueued' | 'unknown_workstream'

/**
 * Drift/resynchronization wake (ENGINE-004, ENGINE-012): keeps the current intent_seq, allocates a
 * fresh work generation, clears claim and blocking state and emits the tick atomically; a
 * Workstream absent from the workset is re-enqueued on its latest Intent.
 */
export async function reEnqueueForDrift(client: QueryClient, workstreamId: string, options: EngineTimeOptions = {}): Promise<DriftWakeOutcome> {
  const now = options.nowSql ?? 'now()'
  await client.query('BEGIN')
  try {
    const updated = await client.query(
      `UPDATE workstream_reconciliation_work
       SET work_generation = nextval('work_generation_seq'),
           due_at = ${now},
           claim_token = NULL,
           lease_until = NULL,
           blocking_cause = NULL,
           last_error = NULL,
           updated_at = ${now}
       WHERE workstream_id = $1`,
      [workstreamId],
    )
    if (updated.rowCount === 0) {
      const latest = await client.query('SELECT coalesce(max(intent_seq), 0) AS latest FROM workstream_intent_events WHERE workstream_id = $1', [workstreamId])
      const intentSeq: number = latest.rows[0]!['latest']
      if (intentSeq === 0) {
        await client.query('ROLLBACK')
        return 'unknown_workstream'
      }
      await client.query(
        `INSERT INTO workstream_reconciliation_work
           (workstream_id, intent_seq, work_generation, due_at, updated_at)
         VALUES ($1, $2, nextval('work_generation_seq'), ${now}, ${now})`,
        [workstreamId, intentSeq],
      )
    }
    await notifyTick(client)
    await client.query('COMMIT')
    return updated.rowCount === 0 ? 'enqueued' : 'woke'
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}
