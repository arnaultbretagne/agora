// First projector: Sessions with their provenance (S3). The fold is driven purely by the
// registered session.* facts — the projection is a view of the canonical stream, never of the
// operational sessions table. Everything the fold needs is on the facts, so an incremental run and
// a rebuild fold to the same state and hash identically.
import type pg from 'pg'
import type { FactRecord } from '@agora/journal'
import type { Projector } from './projector.js'

export const SESSION_LIST_NAME = 'session-list'
export const SESSION_LIST_VERSION = '1'

export interface SessionListRow {
  readonly sessionId: string
  readonly ordinal: number
  readonly podUid: string
  readonly openedAt: Date
  readonly cutoffH: number
  readonly attributionEndedAt: Date | null
  readonly imageDigest: string | null
  readonly firstSeq: number
  readonly latestSeq: number
}

export type SessionListState = ReadonlyMap<string, SessionListRow>

interface OpenedPayload {
  readonly podUid?: string
  readonly cutoffH?: number
}

function foldFact(state: SessionListState, fact: FactRecord): SessionListState {
  if (fact.sessionId === null) return state
  const existing = state.get(fact.sessionId)
  const next = new Map(state)

  if (fact.kind === 'session.opened') {
    if (existing !== undefined) return state
    const payload = (fact.payload ?? {}) as OpenedPayload
    // Ordinal is the birth order by seq: deterministic from facts alone, identical after an
    // incremental fold and after a rebuild.
    const ordinal = [...state.values()].filter((row) => row.firstSeq < fact.seq).length + 1
    next.set(fact.sessionId, {
      sessionId: fact.sessionId,
      ordinal,
      podUid: payload['podUid'] ?? '',
      openedAt: fact.recordedAt,
      cutoffH: payload['cutoffH'] ?? 0,
      attributionEndedAt: null,
      imageDigest: null,
      firstSeq: fact.seq,
      latestSeq: fact.seq,
    })
    return next
  }
  if (existing === undefined) return state
  if (fact.kind === 'session.ended') {
    next.set(fact.sessionId, { ...existing, attributionEndedAt: fact.recordedAt, latestSeq: fact.seq })
    return next
  }
  if (fact.kind === 'session.provenance') {
    const payload = (fact.payload ?? {}) as { imageDigest?: string }
    next.set(fact.sessionId, {
      ...existing,
      imageDigest: payload['imageDigest'] ?? existing.imageDigest,
      latestSeq: fact.seq,
    })
    return next
  }
  next.set(fact.sessionId, { ...existing, latestSeq: fact.seq })
  return next
}

interface RawProjectedRow {
  readonly session_id: string
  readonly ordinal: number
  readonly pod_uid: string
  readonly opened_at: Date
  readonly cutoff_h: number
  readonly attribution_ended_at: Date | null
  readonly image_digest: string | null
  readonly first_seq: number
  readonly latest_seq: number
}

function rowOf(raw: RawProjectedRow): SessionListRow {
  return {
    sessionId: raw.session_id,
    ordinal: raw.ordinal,
    podUid: raw.pod_uid,
    openedAt: raw.opened_at,
    cutoffH: raw.cutoff_h,
    attributionEndedAt: raw.attribution_ended_at,
    imageDigest: raw.image_digest,
    firstSeq: raw.first_seq,
    latestSeq: raw.latest_seq,
  }
}

export const sessionListProjector: Projector<SessionListState> = {
  name: SESSION_LIST_NAME,
  version: SESSION_LIST_VERSION,
  emptyState: () => new Map(),

  async load(client: pg.PoolClient, workstreamId: string): Promise<SessionListState> {
    const result = await client.query<RawProjectedRow>(
      `SELECT session_id, ordinal, pod_uid, opened_at, cutoff_h, attribution_ended_at, image_digest, first_seq, latest_seq
       FROM projection_sessions WHERE workstream_id = $1`,
      [workstreamId],
    )
    return new Map(result.rows.map((row) => [row.session_id, rowOf(row)]))
  },

  fold: (state, fact) => foldFact(state, fact),

  async persist(client: pg.PoolClient, workstreamId: string, state: SessionListState): Promise<void> {
    for (const row of state.values()) {
      await client.query(
        `INSERT INTO projection_sessions
           (workstream_id, session_id, ordinal, pod_uid, opened_at, cutoff_h, attribution_ended_at, image_digest, first_seq, latest_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (workstream_id, session_id) DO UPDATE SET
           ordinal = EXCLUDED.ordinal,
           pod_uid = EXCLUDED.pod_uid,
           opened_at = EXCLUDED.opened_at,
           cutoff_h = EXCLUDED.cutoff_h,
           attribution_ended_at = EXCLUDED.attribution_ended_at,
           image_digest = EXCLUDED.image_digest,
           first_seq = EXCLUDED.first_seq,
           latest_seq = EXCLUDED.latest_seq`,
        [workstreamId, row.sessionId, row.ordinal, row.podUid, row.openedAt, row.cutoffH, row.attributionEndedAt, row.imageDigest, row.firstSeq, row.latestSeq],
      )
    }
  },

  async clear(client: pg.PoolClient, workstreamId: string): Promise<void> {
    await client.query('DELETE FROM projection_sessions WHERE workstream_id = $1', [workstreamId])
  },

  async hashInputs(client: pg.PoolClient, workstreamId: string): Promise<readonly string[]> {
    const result = await client.query<RawProjectedRow>(
      `SELECT session_id, ordinal, pod_uid, opened_at, cutoff_h, attribution_ended_at, image_digest, first_seq, latest_seq
       FROM projection_sessions WHERE workstream_id = $1`,
      [workstreamId],
    )
    return result.rows.map((row) =>
      [
        'session',
        row.session_id,
        row.ordinal,
        row.pod_uid,
        row.opened_at.toISOString(),
        row.cutoff_h,
        row.attribution_ended_at?.toISOString() ?? '',
        row.image_digest ?? '',
        row.first_seq,
        row.latest_seq,
      ].join(':'),
    )
  },
}
