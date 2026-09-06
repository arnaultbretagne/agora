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

  // Only the CURRENT (unended) Session for this Pod counts as "the same BUILD's replayed response"
  // — an ENDED one sharing this podUid is a hot boundary's predecessor (execution.md "Hot Session
  // boundaries"), never a reason to resurrect it here (sessions_one_current_per_workstream_pod
  // enforces there is at most one unended match to find).
  const existing = await client.query(
    'SELECT id, ordinal, cutoff_h, opened_at_seq FROM sessions WHERE workstream_id = $1 AND pod_uid = $2 AND attribution_ended_at IS NULL',
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

export interface AcpContextBinding {
  readonly contextId: string
  readonly processGeneration: number
}

export interface RestoreOrigin {
  /** The frontier the restored Save actually PROVED (CONT-009) — the opening range's lower bound. */
  readonly originW: number
  readonly saveId: string
}

/**
 * Records what a RESTORE carried into this Session (S9). Separate from bindAcpContext because the
 * two answer different questions: that one says which native context is live, this one says how much
 * of the Workstream's record that context already had. A Session with no restore keeps `origin_w = 0`
 * — the cross-seed, where the whole range up to H still has to be refilled.
 */
export async function recordRestoreOrigin(client: pg.PoolClient, sessionId: string, origin: RestoreOrigin): Promise<void> {
  await client.query('UPDATE sessions SET origin_w = $1, origin_save_id = $2 WHERE id = $3', [origin.originW, origin.saveId, sessionId])
}

/**
 * Records the Session's live ACP context (S8 START/RESTORE) — operational, not a new immutable
 * fact: observation.session's own fresh reads (runtime-control's process generation, a live ACP
 * probe) are what actually prove liveness on any later tick; this row is only what START bound,
 * so a reconnect can find the same context id to verify against, never a second source of truth.
 */
export async function bindAcpContext(client: pg.PoolClient, sessionId: string, binding: AcpContextBinding): Promise<void> {
  await client.query('UPDATE sessions SET acp_context_id = $1, process_generation = $2 WHERE id = $3', [binding.contextId, binding.processGeneration, sessionId])
}

/** The P4 bridge token this Session's control-plane connection uses — persisted so a later reconnect (not just the process that received gate_release's response) can still authenticate. */
export async function recordBridgeToken(client: pg.PoolClient, sessionId: string, token: string): Promise<void> {
  await client.query('UPDATE sessions SET bridge_token = $1 WHERE id = $2', [token, sessionId])
}

export interface CurrentSession {
  readonly sessionId: string
  readonly podUid: string
  readonly acpContextId: string | null
  readonly processGeneration: number
  readonly bridgeToken: string | null
}

/** The one Session with no ended attribution for this Workstream, if any — the only one START/CONFIG ever act on. */
export async function currentSession(client: pg.Pool | pg.PoolClient, workstreamId: string): Promise<CurrentSession | null> {
  const result = await client.query(
    'SELECT id, pod_uid, acp_context_id, process_generation, bridge_token FROM sessions WHERE workstream_id = $1 AND attribution_ended_at IS NULL',
    [workstreamId],
  )
  if (result.rowCount === 0) return null
  const row = result.rows[0]!
  return { sessionId: row['id'], podUid: row['pod_uid'], acpContextId: row['acp_context_id'], processGeneration: row['process_generation'], bridgeToken: row['bridge_token'] }
}

export interface OpeningWindow {
  /**
   * The opening range's lower bound: what the context already had when this Session opened. 0 for a
   * cross-seed; a restored Save's proven frontier otherwise (S9 — sessions.origin_w).
   */
  readonly w: number
  /**
   * The opening descriptor's fixed H — "H was fixed before the new Session's facts, never sampled
   * at REFILL dispatch" (009_sync.md). Pinned at Session birth as cutoff_h and never re-read.
   */
  readonly h: number
  readonly saveId: string | null
}

/** The current Session's opening range (W, H], `null` when there is no current Session — sync has nothing to report without one, never a guessed range. */
export async function currentOpeningWindow(client: pg.Pool | pg.PoolClient, workstreamId: string): Promise<OpeningWindow | null> {
  const result = await client.query('SELECT cutoff_h, origin_w, origin_save_id FROM sessions WHERE workstream_id = $1 AND attribution_ended_at IS NULL', [workstreamId])
  if (result.rowCount === 0) return null
  const row = result.rows[0]!
  // A Session that never restored has origin_w = 0 AND a cutoff pinned at the head it was born at:
  // W = 0, H = cutoff_h. Before S9 those were reported as equal, which made every cross-seed look
  // already synchronized; they are equal only when the Workstream had no facts at all (CONT-002).
  return { w: Number(row['origin_w']), h: Number(row['cutoff_h']), saveId: (row['origin_save_id'] as string | null) ?? null }
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
