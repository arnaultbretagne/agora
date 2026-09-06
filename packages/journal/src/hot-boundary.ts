// Hot Session boundary (S8 Step 4b — execution.md "Hot Session boundaries"): the one primitive a
// retained Pod/Agent needs to serve successive Sessions — end the current Session's attribution and
// open its successor on the SAME Pod, atomically, idempotently ("repeated completion opens no
// duplicate Session"). This is the database-level mechanism only: proving quiescence (the final ACP
// exchange settled, callbacks drained), applying rule-selected mutations, and deciding WHEN a
// transition is warranted versus a plain TURN_OFF+BUILD are apps/control-plane's own orchestration,
// not yet wired to any verb in S8's own rule tables (nothing in S8's scope ever needs a second
// Session on a retained Pod — S9's restore path is the first real trigger). Built now, ahead of that
// trigger, the same way S6 built LaunchSeam.processRestart() before S8 wired what calls it.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { appendFact, JournalError } from './append.js'

export interface HotBoundaryCommand {
  /** The Session whose attribution ends — must be the Workstream's current (unended) Session. */
  readonly endingSessionId: string
  /** The SAME Pod UID the ending Session already carried — a hot boundary never changes it (a
   * different Pod is a fresh Session via openSession, not this). */
  readonly podUid: string
  readonly reason: string
  readonly provenance?: unknown
}

export interface HotBoundaryResult {
  readonly endedSessionId: string
  readonly newSessionId: string
  readonly newSessionOrdinal: number
  readonly cutoffH: number
}

/**
 * Ends `command.endingSessionId`'s attribution and opens its successor on the same Pod, in one
 * Workstream-locked operation. Idempotent per `endingSessionId`: a successor already recording
 * `provenance.precededBy = endingSessionId` is returned as-is rather than acted on twice — this is
 * a DIFFERENT idempotency key than openSession's own (podUid alone), deliberately: reusing podUid
 * here would make a hot boundary indistinguishable from "the same BUILD's replayed response",
 * silently resurrecting the ENDED session instead of ever opening a genuine successor.
 */
export async function commitHotBoundary(
  client: pg.PoolClient,
  workstreamId: string,
  command: HotBoundaryCommand,
  options: { readonly nowSql?: string } = {},
): Promise<HotBoundaryResult> {
  const nowSql = options.nowSql ?? 'now()'
  const locked = await client.query('SELECT head_seq FROM workstreams WHERE id = $1 FOR UPDATE', [workstreamId])
  if (locked.rowCount === 0) {
    throw new JournalError('unknown_workstream', `no Workstream ${workstreamId}`)
  }

  const existingSuccessor = await client.query(
    `SELECT id, ordinal, cutoff_h FROM sessions WHERE workstream_id = $1 AND provenance->>'precededBy' = $2`,
    [workstreamId, command.endingSessionId],
  )
  if (existingSuccessor.rowCount !== 0) {
    const row = existingSuccessor.rows[0]!
    return { endedSessionId: command.endingSessionId, newSessionId: row['id'], newSessionOrdinal: row['ordinal'], cutoffH: row['cutoff_h'] }
  }

  const ending = await client.query('SELECT attribution_ended_at FROM sessions WHERE id = $1 AND workstream_id = $2 FOR UPDATE', [command.endingSessionId, workstreamId])
  if (ending.rowCount === 0) {
    throw new JournalError('unknown_workstream', `no Session ${command.endingSessionId} on Workstream ${workstreamId}`)
  }
  if (ending.rows[0]!['attribution_ended_at'] === null) {
    await appendFact(client, workstreamId, { sessionId: command.endingSessionId, kind: 'session.ended', payload: { reason: command.reason } }, { nowSql })
    await client.query(`UPDATE sessions SET attribution_ended_at = ${nowSql} WHERE id = $1`, [command.endingSessionId])
  }

  const cutoffH: number = locked.rows[0]!['head_seq']
  const nextOrdinal = await client.query('SELECT coalesce(max(ordinal), 0) + 1 AS next FROM sessions WHERE workstream_id = $1', [workstreamId])
  const ordinal: number = nextOrdinal.rows[0]!['next']
  const newSessionId = randomUUID()
  const provenance = { ...(typeof command.provenance === 'object' && command.provenance !== null ? command.provenance : {}), precededBy: command.endingSessionId }

  await client.query(
    `INSERT INTO sessions (id, workstream_id, ordinal, opened_at_seq, cutoff_h, pod_uid, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [newSessionId, workstreamId, ordinal, cutoffH + 1, cutoffH, command.podUid, JSON.stringify(provenance)],
  )
  await appendFact(
    client,
    workstreamId,
    { sessionId: newSessionId, kind: 'session.opened', payload: { podUid: command.podUid, cutoffH, provenance, hotBoundary: true } },
    { nowSql },
  )

  return { endedSessionId: command.endingSessionId, newSessionId, newSessionOrdinal: ordinal, cutoffH }
}
