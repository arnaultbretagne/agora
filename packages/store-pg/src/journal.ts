import type { PoolClient } from 'pg'
import { assertNoSecretPattern } from './secret-guard.js'

export type EventDirection = 'client_to_agent' | 'agent_to_client'
export type RpcKind = 'request' | 'response' | 'notification'
export type EventPurpose = 'user' | 'handoff' | 'protocol'
export type IngestMode = 'live' | 'load_replay' | 'recovered'

export interface AppendEventInput {
  readonly eventId: string
  readonly workstreamId: string
  readonly sessionId: string
  readonly direction: EventDirection
  readonly rpcKind: RpcKind
  readonly method?: string
  readonly rpcId?: unknown
  /** The complete ACP JSON-RPC envelope, stored verbatim (docs/specs/05, packages/acp/SPIKE.md). */
  readonly envelope: unknown
  readonly commandId?: string
  readonly causationEventId?: string
  readonly purpose: EventPurpose
  readonly entityKind?: string
  readonly entityId?: string
  readonly transportObservationId?: string
  readonly ingestMode: IngestMode
  readonly observedAt: Date
}

export interface AppendedEvent {
  readonly workstreamSeq: number
  readonly sessionSeq: number
}

/**
 * docs/specs/05-journal-and-projections.md "Ordering": lock the owning Workstream row, increment
 * both sequence heads, insert the event with both allocated positions, insert one journal-outbox
 * row, commit once. All in one transaction — the dual sequence allocator and the outbox write are
 * the same atomic operation, never split.
 */
export async function appendEvent(client: PoolClient, input: AppendEventInput): Promise<AppendedEvent> {
  // The envelope itself is exempt (full ACP passthrough, its own confidentiality rules); only the
  // indexing/metadata fields Agora itself writes are guarded here (see secret-guard.ts).
  assertNoSecretPattern('workstream_event.method', input.method)
  assertNoSecretPattern('workstream_event.entityKind', input.entityKind)
  assertNoSecretPattern('workstream_event.entityId', input.entityId)
  assertNoSecretPattern('workstream_event.transportObservationId', input.transportObservationId)

  await client.query('BEGIN')
  try {
    const { rows: workstreamRows } = await client.query<{ last_event_seq: number }>(
      'SELECT last_event_seq FROM product.workstreams WHERE id = $1 FOR UPDATE',
      [input.workstreamId],
    )
    const workstreamRow = workstreamRows[0]
    if (!workstreamRow) throw new Error(`workstream ${input.workstreamId} not found`)
    const workstreamSeq = workstreamRow.last_event_seq + 1

    const { rows: sessionRows } = await client.query<{ last_event_seq: number }>(
      'SELECT last_event_seq FROM product.sessions WHERE id = $1 AND workstream_id = $2 FOR UPDATE',
      [input.sessionId, input.workstreamId],
    )
    const sessionRow = sessionRows[0]
    if (!sessionRow) throw new Error(`session ${input.sessionId} not found in workstream ${input.workstreamId}`)
    const sessionSeq = sessionRow.last_event_seq + 1

    await client.query('UPDATE product.workstreams SET last_event_seq = $2, updated_at = $3 WHERE id = $1', [
      input.workstreamId,
      workstreamSeq,
      input.observedAt,
    ])
    await client.query('UPDATE product.sessions SET last_event_seq = $2 WHERE id = $1', [input.sessionId, sessionSeq])

    await client.query(
      `INSERT INTO product.workstream_events
         (id, workstream_id, workstream_seq, session_id, session_seq, direction, rpc_kind, method, rpc_id,
          envelope, command_id, causation_event_id, purpose, entity_kind, entity_id,
          transport_observation_id, ingest_mode, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        input.eventId,
        input.workstreamId,
        workstreamSeq,
        input.sessionId,
        sessionSeq,
        input.direction,
        input.rpcKind,
        input.method ?? null,
        input.rpcId !== undefined ? JSON.stringify(input.rpcId) : null,
        JSON.stringify(input.envelope),
        input.commandId ?? null,
        input.causationEventId ?? null,
        input.purpose,
        input.entityKind ?? null,
        input.entityId ?? null,
        input.transportObservationId ?? null,
        input.ingestMode,
        input.observedAt,
      ],
    )

    await client.query(
      `INSERT INTO product.journal_outbox (event_id, workstream_id, workstream_seq, created_at)
       VALUES ($1, $2, $3, $4)`,
      [input.eventId, input.workstreamId, workstreamSeq, input.observedAt],
    )

    await client.query('COMMIT')
    return { workstreamSeq, sessionSeq }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
