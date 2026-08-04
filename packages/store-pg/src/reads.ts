import type { PoolClient } from 'pg'
import { readWorkstreamItem, readWorkstreamTurn, type WireWorkstreamItem, type WireWorkstreamTurn } from './projector.js'

/**
 * Read-model functions for `contracts/openapi/product-api.yaml` — every shape here is the exact
 * camelCase wire shape (apps/web serializes these directly, no further renaming). Distinct from
 * `projector.ts`'s `readWorkstreamItem`/`readWorkstreamTurn` (projection read model); these read
 * the durable `product.*` tables plus `projection.workstream_items`/`turns` listing queries.
 */

export type WorkstreamRole = 'owner' | 'editor' | 'viewer'

export interface WireWorkstream {
  readonly id: string
  readonly category: 'discussion' | 'invocation'
  readonly title: string
  readonly pinned: boolean
  readonly role: WorkstreamRole
  readonly currentSessionId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

interface WorkstreamRow {
  readonly id: string
  readonly category: 'discussion' | 'invocation'
  readonly title: string
  readonly pinned: boolean
  readonly role: WorkstreamRole
  readonly current_session_id: string | null
  readonly created_at: Date
  readonly updated_at: Date
}

function toWireWorkstream(row: WorkstreamRow): WireWorkstream {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    pinned: row.pinned,
    role: row.role,
    currentSessionId: row.current_session_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export interface ListWorkstreamsResult {
  readonly items: readonly WireWorkstream[]
  readonly nextCursor: string | null
}

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}:${id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): { readonly updatedAt: string; readonly id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const separator = decoded.lastIndexOf(':')
  if (separator === -1) throw new Error('invalid_cursor')
  return { updatedAt: decoded.slice(0, separator), id: decoded.slice(separator + 1) }
}

/** docs/specs/14 "GET /v1/workstreams": authorized (member-only) list, ordered by product activity. */
export async function listWorkstreamsForPrincipal(
  client: PoolClient,
  principalId: string,
  options: { readonly cursor?: string; readonly limit: number },
): Promise<ListWorkstreamsResult> {
  const cursor = options.cursor ? decodeCursor(options.cursor) : undefined
  const { rows } = await client.query<WorkstreamRow>(
    `SELECT w.id, w.category, w.title, w.pinned, m.role, s.id AS current_session_id, w.created_at, w.updated_at
     FROM product.workstreams w
     JOIN product.workstream_memberships m ON m.workstream_id = w.id
     LEFT JOIN product.sessions s ON s.workstream_id = w.id AND s.is_current
     WHERE m.principal_id = $1
       AND w.deleted_at IS NULL
       AND ($2::timestamptz IS NULL OR (w.updated_at, w.id) < ($2::timestamptz, $3::uuid))
     ORDER BY w.updated_at DESC, w.id DESC
     LIMIT $4`,
    [principalId, cursor?.updatedAt ?? null, cursor?.id ?? null, options.limit],
  )
  const last = rows[rows.length - 1]
  return {
    items: rows.map(toWireWorkstream),
    nextCursor: rows.length === options.limit && last ? encodeCursor(last.updated_at, last.id) : null,
  }
}

export interface WireSession {
  readonly id: string
  readonly workstreamId: string
  readonly ordinal: number
  readonly agentId: string
  readonly phase: string
  readonly current: boolean
  readonly runtimeDefinitionVersion: string
  readonly createdAt: string
  readonly failure: { readonly code: string; readonly detail?: string } | null
}

interface SessionRow {
  readonly id: string
  readonly workstream_id: string
  readonly ordinal: number
  readonly agent_id: string
  readonly phase: string
  readonly is_current: boolean
  readonly runtime_definition_version: string
  readonly created_at: Date
  readonly failure_code: string | null
  readonly failure_detail: string | null
}

const SESSION_COLUMNS = `id, workstream_id, ordinal, agent_id, phase, is_current, runtime_definition_version, created_at, failure_code, failure_detail`

function toWireSession(row: SessionRow): WireSession {
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    ordinal: row.ordinal,
    agentId: row.agent_id,
    phase: row.phase,
    current: row.is_current,
    runtimeDefinitionVersion: row.runtime_definition_version,
    createdAt: row.created_at.toISOString(),
    failure: row.failure_code ? { code: row.failure_code, ...(row.failure_detail ? { detail: row.failure_detail } : {}) } : null,
  }
}

export async function getSession(client: PoolClient, sessionId: string): Promise<WireSession | undefined> {
  const { rows } = await client.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM product.sessions WHERE id = $1`, [sessionId])
  const row = rows[0]
  return row ? toWireSession(row) : undefined
}

/**
 * Internal (never on the wire — `Session` in product-api.yaml has no workspace field): the
 * Session's immutable launch-time workspace reference, needed to re-materialize its Runtime on
 * `activate` without the caller having to already know it.
 */
export async function getSessionWorkspaceMountRef(client: PoolClient, sessionId: string): Promise<string | undefined> {
  const { rows } = await client.query<{ workspace_ref: string | null }>(
    `SELECT workspace_spec->>'workspaceRef' AS workspace_ref FROM product.sessions WHERE id = $1`,
    [sessionId],
  )
  return rows[0]?.workspace_ref ?? undefined
}

export interface WireWorkstreamDetail extends WireWorkstream {
  readonly sessions: readonly WireSession[]
  readonly projectionHead: number
}

interface MembershipRoleRow {
  readonly role: WorkstreamRole
}

interface WorkstreamDetailRow {
  readonly id: string
  readonly category: 'discussion' | 'invocation'
  readonly title: string
  readonly pinned: boolean
  readonly current_session_id: string | null
  readonly created_at: Date
  readonly updated_at: Date
  readonly last_event_seq: number
}

/** Returns `undefined` if the Workstream doesn't exist OR the principal has no membership — the two are indistinguishable to the caller (docs/specs/14 "Authorization": knowledge of an ID is never sufficient). */
export async function getWorkstreamDetail(client: PoolClient, workstreamId: string, principalId: string): Promise<WireWorkstreamDetail | undefined> {
  const { rows: membershipRows } = await client.query<MembershipRoleRow>(
    'SELECT role FROM product.workstream_memberships WHERE workstream_id = $1 AND principal_id = $2',
    [workstreamId, principalId],
  )
  const membership = membershipRows[0]
  if (!membership) return undefined

  const { rows: workstreamRows } = await client.query<WorkstreamDetailRow>(
    `SELECT w.id, w.category, w.title, w.pinned, s.id AS current_session_id, w.created_at, w.updated_at, w.last_event_seq
     FROM product.workstreams w
     LEFT JOIN product.sessions s ON s.workstream_id = w.id AND s.is_current
     WHERE w.id = $1 AND w.deleted_at IS NULL`,
    [workstreamId],
  )
  const workstreamRow = workstreamRows[0]
  if (!workstreamRow) return undefined

  const { rows: sessionRows } = await client.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM product.sessions WHERE workstream_id = $1 ORDER BY ordinal`,
    [workstreamId],
  )

  return {
    ...toWireWorkstream({ ...workstreamRow, role: membership.role }),
    sessions: sessionRows.map(toWireSession),
    projectionHead: workstreamRow.last_event_seq,
  }
}

export interface WireCommand {
  readonly id: string
  readonly workstreamId: string
  readonly sessionId: string | null
  readonly commandType: string
  readonly purpose: 'user' | 'handoff' | 'protocol' | null
  readonly actorKind: 'human' | 'service' | 'system'
  readonly state: string
  readonly acceptedAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
  readonly failure: { readonly code: string; readonly detail?: string } | null
}

interface CommandReadRow {
  readonly id: string
  readonly workstream_id: string
  readonly session_id: string | null
  readonly command_type: string
  readonly purpose: 'user' | 'handoff' | 'protocol' | null
  readonly actor_kind: 'human' | 'service' | 'system'
  readonly state: string
  readonly accepted_at: Date
  readonly updated_at: Date
  readonly completed_at: Date | null
  readonly error_code: string | null
  readonly error_detail: string | null
}

/** docs/specs/14 "GET /v1/commands/{id}": authorization is via the owning Workstream — callers must separately check membership before calling this. */
export async function getCommand(client: PoolClient, commandId: string): Promise<WireCommand | undefined> {
  const { rows } = await client.query<CommandReadRow>(
    `SELECT id, workstream_id, session_id, command_type, purpose, actor_kind, state, accepted_at, updated_at, completed_at, error_code, error_detail
     FROM product.commands WHERE id = $1`,
    [commandId],
  )
  const row = rows[0]
  if (!row) return undefined
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    sessionId: row.session_id,
    commandType: row.command_type,
    purpose: row.purpose,
    actorKind: row.actor_kind,
    state: row.state,
    acceptedAt: row.accepted_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    failure: row.error_code ? { code: row.error_code, ...(row.error_detail ? { detail: row.error_detail } : {}) } : null,
  }
}

export interface WireWorkstreamMembership {
  readonly workstreamId: string
  readonly principalId: string
  readonly role: WorkstreamRole
  readonly addedAt: string
}

export async function listWorkstreamMembershipsWire(client: PoolClient, workstreamId: string): Promise<readonly WireWorkstreamMembership[]> {
  const { rows } = await client.query<{ workstream_id: string; principal_id: string; role: WorkstreamRole; added_at: Date }>(
    'SELECT workstream_id, principal_id, role, added_at FROM product.workstream_memberships WHERE workstream_id = $1 ORDER BY added_at',
    [workstreamId],
  )
  return rows.map((row) => ({ workstreamId: row.workstream_id, principalId: row.principal_id, role: row.role, addedAt: row.added_at.toISOString() }))
}

export async function getMembershipRole(client: PoolClient, workstreamId: string, principalId: string): Promise<WorkstreamRole | undefined> {
  const { rows } = await client.query<MembershipRoleRow>(
    'SELECT role FROM product.workstream_memberships WHERE workstream_id = $1 AND principal_id = $2',
    [workstreamId, principalId],
  )
  return rows[0]?.role
}

export interface ListItemsPage {
  readonly items: readonly WireWorkstreamItem[]
  readonly throughWorkstreamSeq: number
  readonly feedPosition: number
  readonly nextBeforeSeq: number | null
}

/**
 * docs/specs/14 "Items, projection watermark and feed position are read from one database
 * snapshot" — wrapped in one read-only transaction so all three reflect the same instant, even
 * though they come from three different tables.
 */
export async function listWorkstreamItemsPage(
  client: PoolClient,
  workstreamId: string,
  options: { readonly beforeSeq?: number; readonly limit: number },
): Promise<ListItemsPage> {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const { rows: idRows } = await client.query<{ id: string; first_workstream_seq: number }>(
      `SELECT id, first_workstream_seq FROM projection.workstream_items
       WHERE workstream_id = $1 AND ($2::bigint IS NULL OR first_workstream_seq < $2)
       ORDER BY first_workstream_seq DESC, id DESC
       LIMIT $3`,
      [workstreamId, options.beforeSeq ?? null, options.limit],
    )
    const items: WireWorkstreamItem[] = []
    for (const row of idRows) {
      const item = await readWorkstreamItem(client, row.id)
      if (item) items.push(item)
    }
    const { rows: checkpointRows } = await client.query<{ through_workstream_seq: number }>(
      `SELECT through_workstream_seq FROM projection.projector_checkpoints WHERE workstream_id = $1`,
      [workstreamId],
    )
    const { rows: feedRows } = await client.query<{ position: number }>(
      `SELECT MAX(position) AS position FROM projection.feed_events WHERE workstream_id = $1`,
      [workstreamId],
    )
    await client.query('COMMIT')
    const last = idRows[idRows.length - 1]
    return {
      items,
      throughWorkstreamSeq: checkpointRows[0]?.through_workstream_seq ?? 0,
      feedPosition: feedRows[0]?.position ?? 0,
      nextBeforeSeq: idRows.length === options.limit && last ? last.first_workstream_seq : null,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export interface ListTurnsPage {
  readonly turns: readonly WireWorkstreamTurn[]
  readonly throughWorkstreamSeq: number
  readonly feedPosition: number
  readonly nextBeforeSeq: number | null
}

export async function listWorkstreamTurnsPage(
  client: PoolClient,
  workstreamId: string,
  options: { readonly beforeSeq?: number; readonly limit: number },
): Promise<ListTurnsPage> {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const { rows: idRows } = await client.query<{ id: string; first_workstream_seq: number }>(
      `SELECT id, first_workstream_seq FROM projection.turns
       WHERE workstream_id = $1 AND ($2::bigint IS NULL OR first_workstream_seq < $2)
       ORDER BY first_workstream_seq DESC, id DESC
       LIMIT $3`,
      [workstreamId, options.beforeSeq ?? null, options.limit],
    )
    const turns: WireWorkstreamTurn[] = []
    for (const row of idRows) {
      const turn = await readWorkstreamTurn(client, row.id)
      if (turn) turns.push(turn)
    }
    const { rows: checkpointRows } = await client.query<{ through_workstream_seq: number }>(
      `SELECT through_workstream_seq FROM projection.projector_checkpoints WHERE workstream_id = $1`,
      [workstreamId],
    )
    const { rows: feedRows } = await client.query<{ position: number }>(
      `SELECT MAX(position) AS position FROM projection.feed_events WHERE workstream_id = $1`,
      [workstreamId],
    )
    await client.query('COMMIT')
    const last = idRows[idRows.length - 1]
    return {
      turns,
      throughWorkstreamSeq: checkpointRows[0]?.through_workstream_seq ?? 0,
      feedPosition: feedRows[0]?.position ?? 0,
      nextBeforeSeq: idRows.length === options.limit && last ? last.first_workstream_seq : null,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
