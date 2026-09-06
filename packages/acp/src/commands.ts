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

  const id = randomUUID()
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
