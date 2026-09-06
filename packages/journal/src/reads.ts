// Session reads (ADR 0004): reading a Session is a filtered view of the canonical Workstream
// stream — no Session-local journal, no copy. The Workstream-range read is the input for
// projectors and, later, Handoff rendering.
import type pg from 'pg'
import { JournalError } from './append.js'

export type Queryer = pg.Pool | pg.PoolClient

export interface AcpFactMetadata {
  readonly direction: string | null
  readonly rpcKind: string | null
  readonly method: string | null
  readonly correlatedMethod: string | null
  readonly rpcId: unknown
  readonly commandId: string | null
  readonly connectionId: string | null
  readonly observationId: string | null
  readonly frameSize: number | null
}

export interface FactRecord {
  readonly workstreamId: string
  readonly seq: number
  readonly sessionId: string | null
  readonly kind: string
  readonly payload: unknown
  readonly causation: unknown
  readonly recordedAt: Date
  /** Present when the fact row carries the S4 ACP indexing columns. */
  readonly acp?: AcpFactMetadata
}

interface RawFactRow {
  readonly workstream_id: string
  readonly seq: number
  readonly session_id: string | null
  readonly kind: string
  readonly payload: unknown
  readonly causation: unknown
  readonly recorded_at: Date
  readonly direction: string | null
  readonly rpc_kind: string | null
  readonly method: string | null
  readonly correlated_method: string | null
  readonly rpc_id: unknown
  readonly command_id: string | null
  readonly connection_id: string | null
  readonly observation_id: string | null
  readonly frame_size: number | null
}

function toRecord(row: RawFactRow): FactRecord {
  return {
    workstreamId: row.workstream_id,
    seq: row.seq,
    sessionId: row.session_id,
    kind: row.kind,
    payload: row.payload,
    causation: row.causation,
    recordedAt: row.recorded_at,
    acp: {
      direction: row.direction,
      rpcKind: row.rpc_kind,
      method: row.method,
      correlatedMethod: row.correlated_method,
      rpcId: row.rpc_id,
      commandId: row.command_id,
      connectionId: row.connection_id,
      observationId: row.observation_id,
      frameSize: row.frame_size,
    },
  }
}

/** Facts strictly after `afterSeq`, ascending — the projector runner's feed. */
export async function factsFrom(client: Queryer, workstreamId: string, afterSeq: number, limit = 5_000): Promise<readonly FactRecord[]> {
  const result = await client.query<RawFactRow>(
    `SELECT workstream_id, seq, session_id, kind, payload, causation, recorded_at,
            direction, rpc_kind, method, correlated_method, rpc_id, command_id, connection_id, observation_id, frame_size
     FROM workstream_facts WHERE workstream_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [workstreamId, afterSeq, limit],
  )
  return result.rows.map(toRecord)
}

/** The inclusive [fromSeq, toSeq] range — the pagination unit for reads and, later, Handoff rendering. */
export async function factsBetween(client: Queryer, workstreamId: string, fromSeq: number, toSeq: number): Promise<readonly FactRecord[]> {
  const result = await client.query<RawFactRow>(
    `SELECT workstream_id, seq, session_id, kind, payload, causation, recorded_at,
            direction, rpc_kind, method, correlated_method, rpc_id, command_id, connection_id, observation_id, frame_size
     FROM workstream_facts WHERE workstream_id = $1 AND seq >= $2 AND seq <= $3 ORDER BY seq`,
    [workstreamId, fromSeq, toSeq],
  )
  return result.rows.map(toRecord)
}

/** Reading a Session: facts referencing its session_id, in Workstream order. */
export async function factsBySession(client: Queryer, workstreamId: string, sessionId: string): Promise<readonly FactRecord[]> {
  const result = await client.query<RawFactRow>(
    `SELECT workstream_id, seq, session_id, kind, payload, causation, recorded_at,
            direction, rpc_kind, method, correlated_method, rpc_id, command_id, connection_id, observation_id, frame_size
     FROM workstream_facts WHERE workstream_id = $1 AND session_id = $2 ORDER BY seq`,
    [workstreamId, sessionId],
  )
  return result.rows.map(toRecord)
}

export async function headSeq(client: Queryer, workstreamId: string): Promise<number> {
  const result = await client.query('SELECT head_seq FROM workstreams WHERE id = $1', [workstreamId])
  if (result.rowCount === 0) {
    throw new JournalError('unknown_workstream', `no Workstream ${workstreamId}`)
  }
  return result.rows[0]!['head_seq']
}
