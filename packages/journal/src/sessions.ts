// Session birth and attribution end (execution.md — Session birth and admission). Birth is one
// idempotent operation serialized with Workstream appends: under the Workstream lock it either
// returns the Session already opened for this Pod UID or pins cutoff H to the current head, opens
// the Session and appends session.opened attributed to it — so the Session's own first fact has
// seq > H (CONT-001). Birth never implicitly ends another Session's attribution.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { appendFact, JournalError } from './append.js'

export interface OpenSessionCommand {
  readonly podUid: string
  readonly provenance: unknown
}

export interface OpenedSession {
  readonly sessionId: string
  readonly ordinal: number
  readonly cutoffH: number
  readonly openedAtSeq: number
}

export async function openSession(
  client: pg.PoolClient,
  workstreamId: string,
  command: OpenSessionCommand,
  options: { readonly nowSql?: string } = {},
): Promise<OpenedSession> {
  const locked = await client.query('SELECT head_seq FROM workstreams WHERE id = $1 FOR UPDATE', [workstreamId])
  if (locked.rowCount === 0) {
    throw new JournalError('unknown_workstream', `no Workstream ${workstreamId}`)
  }

  const existing = await client.query(
    'SELECT id, ordinal, cutoff_h, opened_at_seq FROM sessions WHERE workstream_id = $1 AND pod_uid = $2',
    [workstreamId, command.podUid],
  )
  if (existing.rowCount !== 0) {
    const row = existing.rows[0]!
    return { sessionId: row['id'], ordinal: row['ordinal'], cutoffH: row['cutoff_h'], openedAtSeq: row['opened_at_seq'] }
  }

  const cutoffH: number = locked.rows[0]!['head_seq']
  const nextOrdinal = await client.query(
    'SELECT coalesce(max(ordinal), 0) + 1 AS next FROM sessions WHERE workstream_id = $1',
    [workstreamId],
  )
  const ordinal: number = nextOrdinal.rows[0]!['next']
  const sessionId = randomUUID()

  await client.query(
    `INSERT INTO sessions (id, workstream_id, ordinal, opened_at_seq, cutoff_h, pod_uid, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [sessionId, workstreamId, ordinal, cutoffH + 1, cutoffH, command.podUid, JSON.stringify(command.provenance ?? {})],
  )

  const appended = await appendFact(
    client,
    workstreamId,
    {
      sessionId,
      kind: 'session.opened',
      payload: { podUid: command.podUid, cutoffH, provenance: command.provenance ?? {} },
    },
    options,
  )

  return { sessionId, ordinal, cutoffH, openedAtSeq: appended.seq }
}

export interface EndedAttribution {
  readonly sessionId: string
  readonly ended: boolean
}

/** Ends attribution for the Session and records it as a session.ended fact. Idempotent: a second call changes nothing. */
export async function endAttribution(
  client: pg.PoolClient,
  workstreamId: string,
  sessionId: string,
  reason: string,
  options: { readonly nowSql?: string } = {},
): Promise<EndedAttribution> {
  const ended = await client.query(
    'SELECT attribution_ended_at FROM sessions WHERE id = $1 AND workstream_id = $2 FOR UPDATE',
    [sessionId, workstreamId],
  )
  if (ended.rowCount === 0) {
    throw new JournalError('unknown_workstream', `no Session ${sessionId} on Workstream ${workstreamId}`)
  }
  if (ended.rows[0]!['attribution_ended_at'] !== null) {
    return { sessionId, ended: false }
  }
  await appendFact(client, workstreamId, { sessionId, kind: 'session.ended', payload: { reason } }, options)
  await client.query(
    'UPDATE sessions SET attribution_ended_at = now() WHERE id = $1',
    [sessionId],
  )
  return { sessionId, ended: true }
}
