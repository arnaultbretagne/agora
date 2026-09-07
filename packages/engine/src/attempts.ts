// Attempt recovery (engine.md — Effect ownership and late requests): reserve within the Workstream
// ordering, commit, then dispatch outside any transaction, then settle. A crash between dispatch
// and settle leaves `dispatched` — possibly accepted. Unresolved attempts block conflicting
// positive work and block off finalization (ENGINE-008/018).
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { payloadDigest, type OwnerRequest, type OwnerResponse, type OwnerTarget } from '@agora/owner-requests'
import type { QueryClient } from './db.js'

export type AttemptState = 'reserved' | 'dispatched' | 'settled' | 'unknown' | 'superseded'

export interface AttemptReservation {
  readonly attemptKey: string
  readonly workstreamId: string
  readonly epoch: number
  readonly operation: string
  readonly target: OwnerTarget
  readonly payloadDigest: string
  readonly state: AttemptState
}

export class AttemptConflictError extends Error {
  readonly code = 'attempt_conflict'

  constructor(readonly existingKey: string, readonly existingState: string, message: string) {
    super(message)
    this.name = 'AttemptConflictError'
  }
}

export interface ReserveAttemptCommand {
  readonly workstreamId: string
  readonly epoch: number
  readonly operation: string
  readonly target: OwnerTarget
  readonly payload: Record<string, unknown>
  readonly revisionSet: Record<string, unknown>
  readonly dispatchOwner: string
  /** Positive attempts on one target are serialized: an unresolved attempt blocks a second one. */
  readonly positive?: boolean
}

function attemptKey(workstreamId: string, operation: string, target: OwnerTarget): string {
  return `${workstreamId}/${operation}/${target.kind}:${target.id}/${randomUUID()}`
}

export async function reserveAttempt(client: pg.PoolClient, command: ReserveAttemptCommand): Promise<AttemptReservation> {
  // Same Workstream lock as authoring and fact appends: reservations are totally ordered with
  // everything else that mutates the Workstream.
  await client.query('SELECT head_seq FROM workstreams WHERE id = $1 FOR UPDATE', [command.workstreamId])
  if (command.positive === true) {
    const unresolved = await client.query(
      `SELECT attempt_key, state FROM owner_attempts
       WHERE workstream_id = $1 AND target_kind = $2 AND target_id = $3 AND operation = $4 AND state IN ('reserved', 'dispatched', 'unknown')
       LIMIT 1`,
      [command.workstreamId, command.target.kind, command.target.id, command.operation],
    )
    if (unresolved.rowCount !== 0) {
      throw new AttemptConflictError(
        unresolved.rows[0]!['attempt_key'],
        unresolved.rows[0]!['state'],
        `a ${command.operation} attempt on ${command.target.kind}:${command.target.id} is already ${unresolved.rows[0]!['state']} — possibly accepted`,
      )
    }
  }
  const key = attemptKey(command.workstreamId, command.operation, command.target)
  await client.query(
    `INSERT INTO owner_attempts (attempt_key, workstream_id, epoch, operation, target_kind, target_id, payload_digest, state, dispatch_owner, revision_set)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $9::jsonb)`,
    [key, command.workstreamId, command.epoch, command.operation, command.target.kind, command.target.id, payloadDigest(command.payload), command.dispatchOwner, JSON.stringify(command.revisionSet)],
  )
  return {
    attemptKey: key,
    workstreamId: command.workstreamId,
    epoch: command.epoch,
    operation: command.operation,
    target: command.target,
    payloadDigest: payloadDigest(command.payload),
    state: 'reserved',
  }
}

/** Stale-revision fence at dispatch (ENGINE-014): a request resolved under an old revision never reaches the owner. */
export async function markAttemptDispatched(
  client: pg.PoolClient,
  attemptKey: string,
  currentRevisionSet: Record<string, unknown> | null,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE owner_attempts SET state = 'dispatched'
     WHERE attempt_key = $1 AND state = 'reserved'
       AND ($2::jsonb IS NULL OR revision_set = $2::jsonb)`,
    [attemptKey, currentRevisionSet === null ? null : JSON.stringify(currentRevisionSet)],
  )
  if ((result.rowCount ?? 0) === 0) {
    await client.query(
      `UPDATE owner_attempts SET state = 'superseded', settled_at = now() WHERE attempt_key = $1 AND state = 'reserved'`,
      [attemptKey],
    )
    return false
  }
  return true
}

export async function settleAttempt(client: QueryClient, attemptKey: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE owner_attempts SET state = 'settled', settled_at = now() WHERE attempt_key = $1 AND state IN ('dispatched', 'reserved')`,
    [attemptKey],
  )
  return (result.rowCount ?? 0) === 1
}

export async function markAttemptUnknown(client: QueryClient, attemptKey: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE owner_attempts SET state = 'unknown', settled_at = now() WHERE attempt_key = $1 AND state IN ('dispatched', 'reserved')`,
    [attemptKey],
  )
  return (result.rowCount ?? 0) === 1
}

export async function supersedeAttempt(client: QueryClient, attemptKey: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE owner_attempts SET state = 'superseded', settled_at = now() WHERE attempt_key = $1 AND state IN ('reserved', 'dispatched', 'unknown')`,
    [attemptKey],
  )
  return (result.rowCount ?? 0) === 1
}

/**
 * The unresolved attempt this exact request would be a repeat of, if there is one (ENGINE-008).
 *
 * The protocol's whole recovery story is re-asking with the SAME key: "owners … return the recorded
 * result for a reused key with the same digest", and "retrying with a fresh key … is not an
 * implementation option". Nothing was doing that. An attempt whose owner call did not settle —
 * a 500, a dropped connection, a worker that died between dispatch and settle — sat in `unknown`
 * for ever, and because an unresolved positive attempt blocks the next one, the Workstream stopped
 * reconciling permanently. The first live deployment hit it on its first Pod.
 *
 * The digest is what makes a repeat a repeat. A different payload under the same target is a
 * DIFFERENT request: it is not this attempt's answer to wait for, and it stays blocked (which is
 * the honest outcome — the earlier one may still have been accepted).
 */
export async function unresolvedRepeatOf(
  client: QueryClient,
  command: { readonly workstreamId: string; readonly operation: string; readonly target: OwnerTarget; readonly payloadDigest: string },
): Promise<AttemptReservation | undefined> {
  const result = await client.query(
    `SELECT attempt_key, epoch, payload_digest, state FROM owner_attempts
     WHERE workstream_id = $1 AND operation = $2 AND target_kind = $3 AND target_id = $4
       AND payload_digest = $5 AND state IN ('dispatched', 'unknown')
     ORDER BY reserved_at DESC LIMIT 1`,
    [command.workstreamId, command.operation, command.target.kind, command.target.id, command.payloadDigest],
  )
  const row = result.rows[0] as { attempt_key: string; epoch: number; payload_digest: string; state: AttemptState } | undefined
  if (row === undefined) return undefined
  return {
    attemptKey: row.attempt_key,
    workstreamId: command.workstreamId,
    epoch: row.epoch,
    operation: command.operation,
    target: command.target,
    payloadDigest: row.payload_digest,
    state: row.state,
  }
}

/**
 * Puts an unresolved attempt back in `reserved` so it can be re-asked under its own key.
 * `dispatchAttempt` only moves `reserved -> dispatched`, and this is the one transition that may
 * walk an attempt backwards — it is a re-ask of the same question, not a new one.
 */
export async function reopenAttemptForRecovery(client: QueryClient, attemptKey: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE owner_attempts SET state = 'reserved', settled_at = NULL WHERE attempt_key = $1 AND state IN ('dispatched', 'unknown')`,
    [attemptKey],
  )
  return (result.rowCount ?? 0) === 1
}

/** True while any attempt of the Workstream is possibly accepted — off convergence is blocked. */
export async function hasUnresolvedAttempts(client: QueryClient, workstreamId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM owner_attempts WHERE workstream_id = $1 AND state IN ('reserved', 'dispatched', 'unknown') LIMIT 1`,
    [workstreamId],
  )
  return result.rowCount !== 0
}

/** Dispatch one reserved attempt through an owner client: dispatch mark (with the revision fence), call, settle or unknown. */
export async function dispatchAttempt(
  pool: pg.Pool,
  reservation: AttemptReservation,
  request: Omit<OwnerRequest, 'epoch' | 'workstreamId' | 'attemptKey' | 'target' | 'payloadDigest'>,
  transport: (request: OwnerRequest) => Promise<OwnerResponse>,
  options: { readonly currentRevisionSet?: Record<string, unknown> | null; readonly epoch?: number } = {},
): Promise<{ settled: boolean; response: OwnerResponse | null }> {
  const dispatchClient = await pool.connect()
  let requestPayload: OwnerRequest
  try {
    await dispatchClient.query('BEGIN')
    const ok = await markAttemptDispatched(dispatchClient, reservation.attemptKey, options.currentRevisionSet ?? null)
    await dispatchClient.query('COMMIT')
    if (!ok) return { settled: false, response: null }
    requestPayload = {
      epoch: options.epoch ?? reservation.epoch,
      workstreamId: reservation.workstreamId,
      attemptKey: reservation.attemptKey,
      operation: reservation.operation,
      target: reservation.target,
      payload: request.payload,
      payloadDigest: reservation.payloadDigest,
      revisionSet: request.revisionSet,
    }
  } finally {
    dispatchClient.release()
  }

  try {
    const response = await transport(requestPayload)
    const settleClient = await pool.connect()
    try {
      if (response.kind === 'completed' || response.kind === 'accepted') {
        await settleAttempt(settleClient, reservation.attemptKey)
      } else if (response.kind === 'unknown') {
        await markAttemptUnknown(settleClient, reservation.attemptKey)
      }
      // rejected_* responses leave the attempt dispatch-marked for recovery to look at? No: a
      // rejection is a settled outcome for THIS attempt — the engine retries under a new key.
      if (response.kind === 'rejected_stale_epoch' || response.kind === 'rejected_key_mismatch') {
        await supersedeAttempt(settleClient, reservation.attemptKey)
      }
    } finally {
      settleClient.release()
    }
    return { settled: true, response }
  } catch (error) {
    const failClient = await pool.connect()
    try {
      await markAttemptUnknown(failClient, reservation.attemptKey)
    } finally {
      failClient.release()
    }
    return { settled: false, response: { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) } }
  }
}
