// Command dispatches (engine.md — Prompt delivery and context creation): the reservation commits
// before the send; every later state transition is the honest one — `responded` only from a real
// correlated response, `unknown` on crash/loss, `rejected_before_acceptance` only when provably
// never sent. No automatic transition ever invents delivery knowledge.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'

export type DispatchQueryer = pg.Pool | pg.PoolClient

export type CommandKind = 'prompt' | 'cancel' | 'handoff'
export type DispatchState = 'reserved' | 'dispatched' | 'responded' | 'unknown' | 'rejected_before_acceptance'

export interface DispatchRecord {
  readonly id: string
  readonly workstreamId: string
  readonly sessionId: string
  readonly kind: CommandKind
  readonly state: DispatchState
  readonly linkedPredecessor: string | null
}

export interface ReservedDispatch extends DispatchRecord {
  readonly predecessorWasUnresolved: boolean
}

export interface ReserveCommand {
  readonly workstreamId: string
  readonly sessionId: string
  readonly kind: CommandKind
  readonly request: unknown
  readonly requestKey: string
  /** Set for a user retry that explicitly links the unresolved command it replaces. */
  readonly linkedPredecessor?: string | null
  /**
   * A command id chosen by the caller instead of generated here. Used by the opening Handoff (S9),
   * whose descriptive URI embeds the command id and therefore has to know it BEFORE the bytes it
   * names are rendered. Deriving it deterministically from the request key keeps the idempotency the
   * random id already had: two processes completing the same descriptor collide on the unique key.
   */
  readonly id?: string
}

export class DispatchConflictError extends Error {
  readonly code = 'command_key_conflict'

  constructor(readonly existingId: string) {
    super(`request key already used by command ${existingId}`)
    this.name = 'DispatchConflictError'
  }
}

function toRecord(row: Record<string, unknown>): DispatchRecord {
  return {
    id: row['id'] as string,
    workstreamId: row['workstream_id'] as string,
    sessionId: row['session_id'] as string,
    kind: row['kind'] as CommandKind,
    state: row['state'] as DispatchState,
    linkedPredecessor: (row['linked_predecessor'] as string | null) ?? null,
  }
}

/**
 * Reserves the dispatch in the caller's transaction — the caller's admission checks (current
 * Session, no turn in flight) must run in this same transaction, and the commit must precede any
 * transport write.
 */
export async function reserveDispatch(client: pg.PoolClient, command: ReserveCommand): Promise<ReservedDispatch> {
  const existing = await client.query('SELECT id FROM command_dispatches WHERE workstream_id = $1 AND request_key = $2', [
    command.workstreamId,
    command.requestKey,
  ])
  if (existing.rowCount !== 0) {
    throw new DispatchConflictError(existing.rows[0]!['id'])
  }

  const inFlight = await client.query(
    `SELECT id FROM command_dispatches
     WHERE workstream_id = $1 AND kind = 'prompt' AND state IN ('reserved', 'dispatched', 'unknown')
     ORDER BY reserved_at DESC LIMIT 1`,
    [command.workstreamId],
  )
  if (command.kind === 'prompt') {
    if (command.linkedPredecessor === undefined || command.linkedPredecessor === null) {
      const unresolved = await client.query(
        `SELECT id FROM command_dispatches WHERE workstream_id = $1 AND kind = 'prompt' AND state = 'unknown' LIMIT 1`,
        [command.workstreamId],
      )
      if (unresolved.rowCount !== 0) {
        // A possibly accepted prompt gates the next turn until recovery resolves it (CONT-005) —
        // this is the specific refusal; the generic in-flight gate is checked after it.
        throw new Error('prompt_delivery_unknown')
      }
    }
    if (inFlight.rowCount !== 0) {
      // At most one prompt turn in flight per Workstream (findings §2.4: no portable signal tells
      // adapters apart, so the gate is Agora's, here, before any send).
      throw new Error('turn_in_flight')
    }
  }

  const id = command.id ?? randomUUID()
  const inserted = await client.query(
    `INSERT INTO command_dispatches (id, workstream_id, session_id, kind, request, state, request_key, linked_predecessor)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'reserved', $6, $7)
     RETURNING *`,
    [id, command.workstreamId, command.sessionId, command.kind, JSON.stringify(command.request), command.requestKey, command.linkedPredecessor ?? null],
  )
  return { ...toRecord(inserted.rows[0]!), predecessorWasUnresolved: false }
}

export async function replayDispatch(client: DispatchQueryer, workstreamId: string, requestKey: string): Promise<DispatchRecord | null> {
  const existing = await client.query('SELECT * FROM command_dispatches WHERE workstream_id = $1 AND request_key = $2', [
    workstreamId,
    requestKey,
  ])
  return existing.rowCount === 0 ? null : toRecord(existing.rows[0]!)
}

async function transition(client: pg.PoolClient, commandId: string, from: readonly DispatchState[], to: DispatchState, settled: boolean): Promise<boolean> {
  const result = await client.query(
    `UPDATE command_dispatches SET state = $3,
       dispatched_at = CASE WHEN $3 = 'dispatched' THEN now() ELSE dispatched_at END,
       settled_at = CASE WHEN $4 THEN now() ELSE settled_at END
     WHERE id = $1 AND state = ANY($2::text[])`,
    [commandId, from, to, settled],
  )
  return (result.rowCount ?? 0) === 1
}

export async function markDispatched(client: pg.PoolClient, commandId: string): Promise<boolean> {
  return transition(client, commandId, ['reserved'], 'dispatched', false)
}

export async function markResponded(client: pg.PoolClient, commandId: string): Promise<boolean> {
  return transition(client, commandId, ['dispatched', 'reserved'], 'responded', true)
}

export async function markUnknown(client: pg.PoolClient, commandId: string): Promise<boolean> {
  return transition(client, commandId, ['dispatched', 'reserved'], 'unknown', true)
}

export async function markRejectedBeforeAcceptance(client: pg.PoolClient, commandId: string): Promise<boolean> {
  return transition(client, commandId, ['dispatched', 'reserved'], 'rejected_before_acceptance', true)
}

/**
 * A reservation whose send never even started: provably never sent, so it settles as
 * `rejected_before_acceptance` and stops counting as a turn in flight.
 *
 * Restricted to `reserved` on purpose — a `dispatched` one DID reach the wire and may have been
 * accepted, which is `unknown`, not this. Without this exit a prompt whose channel failed to open
 * sat `reserved` for ever and the one-turn-per-Workstream gate refused every later prompt: found
 * live, on a Workstream that could not be prompted again.
 */
export async function markNeverSent(client: pg.PoolClient, commandId: string): Promise<boolean> {
  return transition(client, commandId, ['reserved'], 'rejected_before_acceptance', true)
}

/**
 * Recovery-only exits from `unknown` (S8 Step 5 — engine.md "Prompt delivery and context
 * creation"). Deliberately separate from markResponded/markRejectedBeforeAcceptance, which only
 * accept `dispatched`/`reserved`: an `unknown` may only be resolved by evidence gathered from the
 * harness itself, never by the dispatch path optimistically re-deciding its own lost outcome.
 * `apps/control-plane/src/recovery/context.ts` is the one caller, and it only calls these after a
 * `session/load` replay actually showed (or provably lacked) the prompt.
 */
export async function resolveUnknownAsDelivered(client: pg.PoolClient, commandId: string): Promise<boolean> {
  return transition(client, commandId, ['unknown'], 'responded', true)
}

/** The replay proved the prompt never reached the harness: `rejected_before_acceptance` is exactly the "provably never sent" state. */
export async function resolveUnknownAsNeverDelivered(client: pg.PoolClient, commandId: string): Promise<boolean> {
  return transition(client, commandId, ['unknown'], 'rejected_before_acceptance', true)
}

export interface UnresolvedPrompt {
  readonly id: string
  readonly sessionId: string
  readonly text: string | null
  readonly state: DispatchState
}

/**
 * Every prompt this Session actually attempted to send, oldest first — the ordered send history
 * recovery compares against the harness's own replay. `reserved` is excluded: it never reached the
 * transport, so it can never appear in a replay and would shift every later position by one.
 */
export async function attemptedPrompts(client: DispatchQueryer, workstreamId: string, sessionId: string): Promise<readonly UnresolvedPrompt[]> {
  const result = await client.query(
    `SELECT id, session_id, request, state FROM command_dispatches
     WHERE workstream_id = $1 AND session_id = $2 AND kind = 'prompt'
       AND state IN ('dispatched', 'responded', 'unknown')
     ORDER BY reserved_at`,
    [workstreamId, sessionId],
  )
  return result.rows.map((row) => {
    const request = row['request'] as { text?: unknown } | null
    return {
      id: row['id'] as string,
      sessionId: row['session_id'] as string,
      text: typeof request?.text === 'string' ? request.text : null,
      state: row['state'] as DispatchState,
    }
  })
}
