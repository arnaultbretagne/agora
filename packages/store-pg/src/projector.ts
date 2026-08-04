import { createHash } from 'node:crypto'
import { nameBasedUuid } from '@agora/domain'
import type { Pool, PoolClient } from 'pg'
import { advanceCheckpoint, appendFeedEvent, getCheckpoint } from './projections.js'

/**
 * docs/specs/05-journal-and-projections.md "Projection model": folds the canonical
 * `product.workstream_events` journal into the typed, rebuildable `projection.*` read model.
 * Deterministic and idempotent by event ID — driven purely by `(method, envelope, direction,
 * rpc_kind)` classification, since `packages/acp`'s journaling layer never sets
 * `entity_kind`/`entity_id` (see store-persist.ts) and ADR 0003 pins the wire protocol to stable
 * ACP v1, so only v1 `SessionUpdate` discriminators are given first-class handling; anything else
 * (including the SDK's own UNSTABLE v2-ish variants: `plan_update`, `plan_removed`,
 * `available_commands_update`, `current_mode_update`, `config_option_update`) folds into the
 * `unknown` generic bucket rather than being silently dropped or half-modeled.
 *
 * A version bump here is "adopt a new ACP field, rebuild" (ADR 0004), never a canonical migration.
 */
export const PROJECTOR_NAME = 'agora-web'
export const PROJECTOR_VERSION = '2026-08-03'

/**
 * Fixed namespace for deriving an item's identity from (session, kind, entity key) — never reused
 * for another purpose. Required for "rebuild yields identical item hashes"
 * (docs/specs/05 "Rebuild"): `computeProjectionHash` hashes each item's `id`, so a rebuild that
 * randomized IDs could never reproduce the same hash as the run before it.
 */
const ITEM_ID_NAMESPACE = '94c707d7-096e-4008-be06-942508f9d8e6'

function deriveItemId(sessionId: string, itemKind: string, entityKey: string): string {
  return nameBasedUuid(ITEM_ID_NAMESPACE, `${sessionId}:${itemKind}:${entityKey}`)
}

type Json = Record<string, unknown>

interface RawEventRow {
  readonly id: string
  readonly workstream_id: string
  readonly workstream_seq: number
  readonly session_id: string
  readonly direction: 'client_to_agent' | 'agent_to_client'
  readonly rpc_kind: 'request' | 'response' | 'notification'
  readonly method: string | null
  readonly rpc_id: unknown
  readonly envelope: Json
  readonly command_id: string | null
  readonly purpose: 'user' | 'handoff' | 'protocol'
  readonly observed_at: Date
}

export interface WireWorkstreamItem {
  readonly id: string
  readonly workstreamId: string
  readonly sessionId: string
  readonly turnId: string | null
  readonly kind: string
  readonly firstEventId: string
  readonly latestEventId: string
  readonly firstWorkstreamSeq: number
  readonly latestWorkstreamSeq: number
  readonly value: Json
  readonly contentSha256: string
  readonly updatedAt: string
}

export interface WireWorkstreamTurn {
  readonly id: string
  readonly workstreamId: string
  readonly sessionId: string
  readonly turnOrdinal: number
  readonly purpose: 'user' | 'handoff'
  readonly status: 'running' | 'completed' | 'cancelled' | 'failed'
  readonly stopReason: string | null
  readonly firstWorkstreamSeq: number
  readonly latestWorkstreamSeq: number
  readonly usage: Json | null
  readonly startedAt: string
  readonly endedAt: string | null
}

/** Deterministic across key insertion order — required so the same final state always hashes the same. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function oppositeDirection(direction: RawEventRow['direction']): RawEventRow['direction'] {
  return direction === 'client_to_agent' ? 'agent_to_client' : 'client_to_agent'
}

/**
 * Finds the request event a response is answering via a targeted lookup, rather than an in-memory
 * map correlating request/response inside one projector pass — correct even if a request and its
 * response land in different projector invocations (process restarts included).
 */
async function findRequestForResponse(
  client: PoolClient,
  sessionId: string,
  responseDirection: RawEventRow['direction'],
  rpcId: unknown,
): Promise<{ method: string; commandId: string | null } | undefined> {
  const { rows } = await client.query<{ method: string; command_id: string | null }>(
    `SELECT method, command_id FROM product.workstream_events
     WHERE session_id = $1 AND rpc_kind = 'request' AND direction = $2 AND rpc_id = $3::jsonb
     ORDER BY workstream_seq DESC LIMIT 1`,
    [sessionId, oppositeDirection(responseDirection), JSON.stringify(rpcId ?? null)],
  )
  const row = rows[0]
  return row ? { method: row.method, commandId: row.command_id } : undefined
}

interface ItemRow {
  readonly id: string
  readonly item_kind: string
}

async function findItem(
  client: PoolClient,
  sessionId: string,
  itemKind: string,
  key: { readonly acpEntityId?: string; readonly syntheticEntityKey?: string },
): Promise<ItemRow | undefined> {
  const { rows } = await client.query<ItemRow>(
    key.acpEntityId !== undefined
      ? `SELECT id, item_kind FROM projection.workstream_items WHERE session_id = $1 AND item_kind = $2 AND acp_entity_id = $3`
      : `SELECT id, item_kind FROM projection.workstream_items WHERE session_id = $1 AND item_kind = $2 AND synthetic_entity_key = $3`,
    [sessionId, itemKind, key.acpEntityId ?? key.syntheticEntityKey],
  )
  return rows[0]
}

/** Reads one item's satellite/current_value back into the exact wire `value` shape (also the hash input). */
async function readItemValue(client: PoolClient, itemId: string, itemKind: string, currentValue: Json | null): Promise<Json> {
  if (currentValue !== null) return currentValue

  if (itemKind === 'message' || itemKind === 'thought') {
    const { rows } = await client.query<{ role: string; message_id: string | null; content: unknown[]; chunk_count: number; completed: boolean }>(
      'SELECT role, message_id, content, chunk_count, completed FROM projection.messages WHERE item_id = $1',
      [itemId],
    )
    const row = rows[0]
    if (!row) throw new Error(`unreachable: ${itemKind} item ${itemId} has no projection.messages row`)
    return { role: row.role, messageId: row.message_id, content: row.content, chunkCount: row.chunk_count, completed: row.completed }
  }

  if (itemKind === 'tool_call') {
    const { rows } = await client.query<{
      tool_call_id: string
      name: string | null
      title: string | null
      kind: string | null
      status: string
      content: unknown[] | null
      raw_input: unknown
      raw_output: unknown
    }>('SELECT tool_call_id, name, title, kind, status, content, raw_input, raw_output FROM projection.tool_calls WHERE item_id = $1', [itemId])
    const row = rows[0]
    if (!row) throw new Error(`unreachable: tool_call item ${itemId} has no projection.tool_calls row`)
    const { rows: locations } = await client.query<{ path: string; line: number | null }>(
      'SELECT path, line FROM projection.tool_call_locations WHERE item_id = $1 ORDER BY ordinal',
      [itemId],
    )
    return {
      toolCallId: row.tool_call_id,
      name: row.name,
      title: row.title,
      kind: row.kind,
      status: row.status,
      content: row.content,
      rawInput: row.raw_input,
      rawOutput: row.raw_output,
      locations,
    }
  }

  if (itemKind === 'plan') {
    const { rows } = await client.query<{ plan_id: string | null; removed: boolean }>(
      'SELECT plan_id, removed FROM projection.plans WHERE item_id = $1',
      [itemId],
    )
    const row = rows[0]
    if (!row) throw new Error(`unreachable: plan item ${itemId} has no projection.plans row`)
    const { rows: entries } = await client.query<{ content: string; priority: string; status: string }>(
      'SELECT content, priority, status FROM projection.plan_entries WHERE item_id = $1 ORDER BY ordinal',
      [itemId],
    )
    return { planId: row.plan_id, removed: row.removed, entries }
  }

  if (itemKind === 'permission') {
    const { rows } = await client.query<{
      tool_call_item_id: string | null
      title: string | null
      options: unknown[]
      status: string
      outcome: string | null
      selected_option_id: string | null
      decided_by: string | null
      requested_at: Date
      decided_at: Date | null
    }>(
      'SELECT tool_call_item_id, title, options, status, outcome, selected_option_id, decided_by, requested_at, decided_at FROM projection.permission_requests WHERE item_id = $1',
      [itemId],
    )
    const row = rows[0]
    if (!row) throw new Error(`unreachable: permission item ${itemId} has no projection.permission_requests row`)
    return {
      toolCallItemId: row.tool_call_item_id,
      title: row.title,
      options: row.options,
      status: row.status,
      outcome: row.outcome,
      selectedOptionId: row.selected_option_id,
      decidedBy: row.decided_by,
      requestedAt: row.requested_at.toISOString(),
      decidedAt: row.decided_at?.toISOString() ?? null,
    }
  }

  throw new Error(`unreachable: item_kind ${itemKind} has neither a satellite reader nor a current_value`)
}

export async function readWorkstreamItem(client: PoolClient, itemId: string): Promise<WireWorkstreamItem | undefined> {
  const { rows } = await client.query<{
    id: string
    workstream_id: string
    session_id: string
    turn_id: string | null
    item_kind: string
    first_event_id: string
    latest_event_id: string
    first_workstream_seq: number
    latest_workstream_seq: number
    current_value: Json | null
    content_sha256: Buffer
    updated_at: Date
  }>(
    `SELECT id, workstream_id, session_id, turn_id, item_kind, first_event_id, latest_event_id,
            first_workstream_seq, latest_workstream_seq, current_value, content_sha256, updated_at
     FROM projection.workstream_items WHERE id = $1`,
    [itemId],
  )
  const row = rows[0]
  if (!row) return undefined
  const value = await readItemValue(client, row.id, row.item_kind, row.current_value)
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    kind: row.item_kind,
    firstEventId: row.first_event_id,
    latestEventId: row.latest_event_id,
    firstWorkstreamSeq: row.first_workstream_seq,
    latestWorkstreamSeq: row.latest_workstream_seq,
    value,
    contentSha256: row.content_sha256.toString('hex'),
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function readWorkstreamTurn(client: PoolClient, turnId: string): Promise<WireWorkstreamTurn | undefined> {
  const { rows } = await client.query<{
    id: string
    workstream_id: string
    session_id: string
    turn_ordinal: number
    purpose: 'user' | 'handoff'
    status: 'running' | 'completed' | 'cancelled' | 'failed'
    stop_reason: string | null
    first_workstream_seq: number
    latest_workstream_seq: number
    input_tokens: number | null
    output_tokens: number | null
    cached_read_tokens: number | null
    cached_write_tokens: number | null
    thought_tokens: number | null
    total_tokens: number | null
    started_at: Date
    ended_at: Date | null
  }>(
    `SELECT id, workstream_id, session_id, turn_ordinal, purpose, status, stop_reason, first_workstream_seq,
            latest_workstream_seq, input_tokens, output_tokens, cached_read_tokens, cached_write_tokens,
            thought_tokens, total_tokens, started_at, ended_at
     FROM projection.turns WHERE id = $1`,
    [turnId],
  )
  const row = rows[0]
  if (!row) return undefined
  const usage =
    row.status === 'running'
      ? null
      : {
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          cachedReadTokens: row.cached_read_tokens,
          cachedWriteTokens: row.cached_write_tokens,
          thoughtTokens: row.thought_tokens,
          totalTokens: row.total_tokens,
        }
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    sessionId: row.session_id,
    turnOrdinal: row.turn_ordinal,
    purpose: row.purpose,
    status: row.status,
    stopReason: row.stop_reason,
    firstWorkstreamSeq: row.first_workstream_seq,
    latestWorkstreamSeq: row.latest_workstream_seq,
    usage,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
  }
}

async function recomputeItemHash(client: PoolClient, itemId: string, itemKind: string, currentValue: Json | null): Promise<void> {
  const value = await readItemValue(client, itemId, itemKind, currentValue)
  const hash = createHash('sha256').update(stableStringify(value)).digest()
  await client.query('UPDATE projection.workstream_items SET content_sha256 = $2 WHERE id = $1', [itemId, hash])
}

interface TouchTracker {
  readonly items: Set<string>
  readonly turns: Set<string>
}

interface UpsertItemInput {
  readonly workstreamId: string
  readonly sessionId: string
  readonly turnId: string | null
  readonly itemKind: string
  readonly acpEntityId?: string
  readonly syntheticEntityKey?: string
  readonly event: RawEventRow
  /** Present only for the low-frequency contractual-value kinds; null for the five satellite kinds. */
  readonly currentValue: Json | null
}

/** Inserts a fresh spine row (no satellite yet — the caller inserts that immediately after) or advances an existing one's position/timestamps; hash is always recomputed by the caller once the satellite write lands. */
async function touchSpine(client: PoolClient, input: UpsertItemInput, touched: TouchTracker): Promise<{ id: string; isNew: boolean }> {
  const existing = await findItem(client, input.sessionId, input.itemKind, {
    ...(input.acpEntityId !== undefined ? { acpEntityId: input.acpEntityId } : {}),
    ...(input.syntheticEntityKey !== undefined ? { syntheticEntityKey: input.syntheticEntityKey } : {}),
  })

  if (existing) {
    await client.query(
      `UPDATE projection.workstream_items
       SET latest_event_id = $2, latest_workstream_seq = $3, current_value = $4, updated_at = $5
       WHERE id = $1`,
      [existing.id, input.event.id, input.event.workstream_seq, input.currentValue ? JSON.stringify(input.currentValue) : null, input.event.observed_at],
    )
    touched.items.add(existing.id)
    return { id: existing.id, isNew: false }
  }

  const id = deriveItemId(input.sessionId, input.itemKind, input.acpEntityId ?? input.syntheticEntityKey ?? '')
  await client.query(
    `INSERT INTO projection.workstream_items
       (id, workstream_id, session_id, turn_id, item_kind, acp_entity_id, synthetic_entity_key,
        first_event_id, latest_event_id, first_workstream_seq, latest_workstream_seq, current_value,
        content_sha256, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $9, $10, $11, $12)`,
    [
      id,
      input.workstreamId,
      input.sessionId,
      input.turnId,
      input.itemKind,
      input.acpEntityId ?? null,
      input.syntheticEntityKey ?? null,
      input.event.id,
      input.event.workstream_seq,
      input.currentValue ? JSON.stringify(input.currentValue) : null,
      createHash('sha256').update('null').digest(), // placeholder; caller recomputes once the satellite row exists
      input.event.observed_at,
    ],
  )
  touched.items.add(id)
  return { id, isNew: true }
}

interface ContentBlock {
  readonly [key: string]: unknown
}

function messageSyntheticKey(turnId: string | null, role: 'user' | 'agent' | 'thought'): string {
  return `message:${turnId ?? 'no-turn'}:${role}`
}

async function upsertMessage(
  client: PoolClient,
  event: RawEventRow,
  workstreamId: string,
  turnId: string | null,
  role: 'user' | 'agent' | 'thought',
  chunk: { readonly content: ContentBlock; readonly messageId?: string | null | undefined },
  touched: TouchTracker,
): Promise<void> {
  const itemKind = role === 'thought' ? 'thought' : 'message'
  const messageId = chunk.messageId ?? undefined
  const key = messageId !== undefined ? { acpEntityId: messageId } : { syntheticEntityKey: messageSyntheticKey(turnId, role) }
  const existing = await findItem(client, event.session_id, itemKind, key)

  if (existing) {
    const { rows } = await client.query<{ content: ContentBlock[]; chunk_count: number }>(
      'SELECT content, chunk_count FROM projection.messages WHERE item_id = $1',
      [existing.id],
    )
    const current = rows[0]
    const content = [...(current?.content ?? []), chunk.content]
    const chunkCount = (current?.chunk_count ?? 0) + 1
    await client.query('UPDATE projection.messages SET content = $2, chunk_count = $3 WHERE item_id = $1', [
      existing.id,
      JSON.stringify(content),
      chunkCount,
    ])
    await client.query('UPDATE projection.workstream_items SET latest_event_id = $2, latest_workstream_seq = $3, updated_at = $4 WHERE id = $1', [
      existing.id,
      event.id,
      event.workstream_seq,
      event.observed_at,
    ])
    touched.items.add(existing.id)
    await recomputeItemHash(client, existing.id, itemKind, null)
    return
  }

  const { id } = await touchSpine(client, {
    workstreamId,
    sessionId: event.session_id,
    turnId,
    itemKind,
    ...key,
    event,
    currentValue: null,
  }, touched)
  await client.query(
    `INSERT INTO projection.messages (item_id, item_kind, role, message_id, content, chunk_count, completed)
     VALUES ($1, $2, $3, $4, $5, 1, false)`,
    [id, itemKind, role, messageId ?? null, JSON.stringify([chunk.content])],
  )
  await recomputeItemHash(client, id, itemKind, null)
}

/** A turn's message/thought items have no explicit ACP "done" signal; they complete when their turn does. */
async function markTurnMessagesCompleted(client: PoolClient, turnId: string, touched: TouchTracker): Promise<void> {
  const { rows } = await client.query<{ id: string; item_kind: string }>(
    `SELECT id, item_kind FROM projection.workstream_items WHERE turn_id = $1 AND item_kind IN ('message', 'thought')`,
    [turnId],
  )
  for (const row of rows) {
    await client.query('UPDATE projection.messages SET completed = true WHERE item_id = $1', [row.id])
    await recomputeItemHash(client, row.id, row.item_kind, null)
    touched.items.add(row.id)
  }
}

async function upsertToolCall(
  client: PoolClient,
  event: RawEventRow,
  workstreamId: string,
  turnId: string | null,
  toolCallId: string,
  fields: {
    readonly name?: string | null | undefined
    readonly title?: string | null | undefined
    readonly kind?: string | null | undefined
    readonly status?: string | null | undefined
    readonly content?: unknown[] | null | undefined
    readonly rawInput?: unknown
    readonly rawOutput?: unknown
    readonly locations?: readonly { readonly path: string; readonly line?: number | null }[] | null | undefined
  },
  touched: TouchTracker,
): Promise<void> {
  const existing = await findItem(client, event.session_id, 'tool_call', { acpEntityId: toolCallId })

  if (existing) {
    const { rows } = await client.query<{
      name: string | null
      title: string | null
      kind: string | null
      status: string
      content: unknown[] | null
      raw_input: unknown
      raw_output: unknown
    }>('SELECT name, title, kind, status, content, raw_input, raw_output FROM projection.tool_calls WHERE item_id = $1', [existing.id])
    const current = rows[0]
    const merged = {
      name: fields.name !== undefined ? fields.name : (current?.name ?? null),
      title: fields.title !== undefined ? fields.title : (current?.title ?? null),
      kind: fields.kind !== undefined ? fields.kind : (current?.kind ?? null),
      status: fields.status !== undefined && fields.status !== null ? fields.status : (current?.status ?? 'pending'),
      content: fields.content !== undefined ? fields.content : (current?.content ?? null),
      rawInput: fields.rawInput !== undefined ? fields.rawInput : current?.raw_input,
      rawOutput: fields.rawOutput !== undefined ? fields.rawOutput : current?.raw_output,
    }
    await client.query(
      `UPDATE projection.tool_calls SET name = $2, title = $3, kind = $4, status = $5, content = $6, raw_input = $7, raw_output = $8
       WHERE item_id = $1`,
      [
        existing.id,
        merged.name,
        merged.title,
        merged.kind,
        merged.status,
        merged.content ? JSON.stringify(merged.content) : null,
        merged.rawInput !== undefined ? JSON.stringify(merged.rawInput) : null,
        merged.rawOutput !== undefined ? JSON.stringify(merged.rawOutput) : null,
      ],
    )
    if (fields.locations) {
      await client.query('DELETE FROM projection.tool_call_locations WHERE item_id = $1', [existing.id])
      for (const [index, location] of fields.locations.entries()) {
        await client.query('INSERT INTO projection.tool_call_locations (item_id, ordinal, path, line) VALUES ($1, $2, $3, $4)', [
          existing.id,
          index + 1,
          location.path,
          location.line ?? null,
        ])
      }
    }
    await client.query('UPDATE projection.workstream_items SET latest_event_id = $2, latest_workstream_seq = $3, updated_at = $4 WHERE id = $1', [
      existing.id,
      event.id,
      event.workstream_seq,
      event.observed_at,
    ])
    touched.items.add(existing.id)
    await recomputeItemHash(client, existing.id, 'tool_call', null)
    return
  }

  const locations = fields.locations ?? []
  const { id } = await touchSpine(client, {
    workstreamId,
    sessionId: event.session_id,
    turnId,
    itemKind: 'tool_call',
    acpEntityId: toolCallId,
    event,
    currentValue: null,
  }, touched)
  await client.query(
    `INSERT INTO projection.tool_calls (item_id, tool_call_id, name, title, kind, status, content, raw_input, raw_output)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      toolCallId,
      fields.name ?? null,
      fields.title ?? null,
      fields.kind ?? null,
      fields.status ?? 'pending',
      fields.content ? JSON.stringify(fields.content) : null,
      fields.rawInput !== undefined ? JSON.stringify(fields.rawInput) : null,
      fields.rawOutput !== undefined ? JSON.stringify(fields.rawOutput) : null,
    ],
  )
  for (const [index, location] of locations.entries()) {
    await client.query('INSERT INTO projection.tool_call_locations (item_id, ordinal, path, line) VALUES ($1, $2, $3, $4)', [
      id,
      index + 1,
      location.path,
      location.line ?? null,
    ])
  }
  await recomputeItemHash(client, id, 'tool_call', null)
}

/** ACP v1 `plan` is full-state and has no `planId` — one plan per turn, replaced wholesale each update. */
async function upsertPlan(
  client: PoolClient,
  event: RawEventRow,
  workstreamId: string,
  turnId: string | null,
  entries: readonly { readonly content: string; readonly priority: string; readonly status: string }[],
  touched: TouchTracker,
): Promise<void> {
  const syntheticEntityKey = `plan:${turnId ?? 'no-turn'}`
  const existing = await findItem(client, event.session_id, 'plan', { syntheticEntityKey })

  const id = existing
    ? existing.id
    : (
        await touchSpine(client, {
          workstreamId,
          sessionId: event.session_id,
          turnId,
          itemKind: 'plan',
          syntheticEntityKey,
          event,
          currentValue: null,
        }, touched)
      ).id

  if (existing) {
    await client.query('DELETE FROM projection.plan_entries WHERE item_id = $1', [id])
    await client.query('UPDATE projection.workstream_items SET latest_event_id = $2, latest_workstream_seq = $3, updated_at = $4 WHERE id = $1', [
      id,
      event.id,
      event.workstream_seq,
      event.observed_at,
    ])
    touched.items.add(id)
  } else {
    await client.query('INSERT INTO projection.plans (item_id, plan_id, removed) VALUES ($1, NULL, false)', [id])
  }
  for (const [index, entry] of entries.entries()) {
    await client.query(
      'INSERT INTO projection.plan_entries (item_id, ordinal, content, priority, status) VALUES ($1, $2, $3, $4, $5)',
      [id, index + 1, entry.content, entry.priority, entry.status],
    )
  }
  await recomputeItemHash(client, id, 'plan', null)
}

async function upsertGenericSpine(
  client: PoolClient,
  event: RawEventRow,
  workstreamId: string,
  turnId: string | null,
  itemKind: string,
  syntheticEntityKey: string,
  value: Json,
  touched: TouchTracker,
): Promise<void> {
  const { id } = await touchSpine(client, {
    workstreamId,
    sessionId: event.session_id,
    turnId,
    itemKind,
    syntheticEntityKey,
    event,
    currentValue: value,
  }, touched)
  await recomputeItemHash(client, id, itemKind, value)
}

function toUsageValue(usage: Record<string, unknown> | undefined | null): Json {
  return {
    inputTokens: usage?.['inputTokens'] ?? null,
    outputTokens: usage?.['outputTokens'] ?? null,
    cachedReadTokens: usage?.['cachedReadTokens'] ?? null,
    cachedWriteTokens: usage?.['cachedWriteTokens'] ?? null,
    thoughtTokens: usage?.['thoughtTokens'] ?? null,
    totalTokens: usage?.['totalTokens'] ?? null,
  }
}

async function openTurn(client: PoolClient, event: RawEventRow, workstreamId: string, touched: TouchTracker): Promise<void> {
  if (!event.command_id) return
  const purpose = event.purpose === 'protocol' ? 'user' : event.purpose
  await client.query(
    `INSERT INTO projection.turns
       (id, workstream_id, session_id, turn_ordinal, purpose, status, first_workstream_seq, latest_workstream_seq, started_at)
     VALUES ($1, $2, $3, (SELECT COALESCE(MAX(turn_ordinal), 0) + 1 FROM projection.turns WHERE session_id = $3), $4, 'running', $5, $5, $6)
     ON CONFLICT (id, session_id, workstream_id) DO NOTHING`,
    [event.command_id, workstreamId, event.session_id, purpose, event.workstream_seq, event.observed_at],
  )
  touched.turns.add(event.command_id)
}

interface HandoffCommandRow {
  readonly source_from_seq: number | null
  readonly source_through_seq: number | null
  readonly seed_policy_version: string | null
  readonly content_sha256: Buffer | null
  readonly request: { readonly fidelity?: 'complete' | 'degraded' } | null
}

/**
 * docs/specs/05 item mapping "handoff | Handoff command ID | ... | source range, policy version,
 * digest, fidelity and target outcome; copied source items are not expanded" — this is the ONLY
 * item this plan creates from a handoff prompt; it never expands the source range back into
 * duplicate copies of the original items (those stay exactly where the projector already put them,
 * on the SOURCE Session).
 */
async function upsertHandoffItem(
  client: PoolClient,
  event: RawEventRow,
  workstreamId: string,
  commandId: string,
  targetOutcome: 'pending' | 'completed' | 'failed',
  touched: TouchTracker,
): Promise<void> {
  const { rows } = await client.query<HandoffCommandRow>(
    'SELECT source_from_seq, source_through_seq, seed_policy_version, content_sha256, request FROM product.commands WHERE id = $1',
    [commandId],
  )
  const row = rows[0]
  if (!row || row.source_from_seq === null || row.source_through_seq === null || row.seed_policy_version === null || !row.content_sha256) return

  const value: Json = {
    sourceFromSeq: row.source_from_seq,
    sourceThroughSeq: row.source_through_seq,
    seedPolicyVersion: row.seed_policy_version,
    digest: row.content_sha256.toString('hex'),
    fidelity: row.request?.fidelity ?? 'complete',
    targetOutcome,
  }
  await upsertGenericSpine(client, event, workstreamId, commandId, 'handoff', `handoff:${commandId}`, value, touched)
}

async function closeTurn(
  client: PoolClient,
  event: RawEventRow,
  workstreamId: string,
  turnId: string,
  status: 'completed' | 'cancelled' | 'failed',
  stopReason: string | null,
  usage: Record<string, unknown> | null,
  touched: TouchTracker,
): Promise<void> {
  const usageValue = toUsageValue(usage ?? undefined)
  await client.query(
    `UPDATE projection.turns
     SET status = $2, stop_reason = $3, latest_workstream_seq = $4, ended_at = $5,
         input_tokens = $6, output_tokens = $7, cached_read_tokens = $8, cached_write_tokens = $9,
         thought_tokens = $10, total_tokens = $11
     WHERE id = $1 AND status = 'running'`,
    [
      turnId,
      status,
      stopReason,
      event.workstream_seq,
      event.observed_at,
      usageValue['inputTokens'],
      usageValue['outputTokens'],
      usageValue['cachedReadTokens'],
      usageValue['cachedWriteTokens'],
      usageValue['thoughtTokens'],
      usageValue['totalTokens'],
    ],
  )
  touched.turns.add(turnId)
  await markTurnMessagesCompleted(client, turnId, touched)
  if (event.purpose === 'handoff') {
    const outcome = status === 'completed' ? 'completed' : 'failed'
    await upsertHandoffItem(client, event, workstreamId, turnId, outcome, touched)
  }
}

async function applyUnknown(client: PoolClient, event: RawEventRow, workstreamId: string, turnId: string | null, touched: TouchTracker): Promise<void> {
  await upsertGenericSpine(
    client,
    event,
    workstreamId,
    turnId,
    'unknown',
    `unknown:${event.id}`,
    { method: event.method, rpcKind: event.rpc_kind, direction: event.direction, envelope: event.envelope },
    touched,
  )
}

async function applyNotification(client: PoolClient, event: RawEventRow, workstreamId: string, turnId: string | null, touched: TouchTracker): Promise<void> {
  const params = event.envelope['params'] as Record<string, unknown> | undefined
  const update = params?.['update'] as Record<string, unknown> | undefined
  const kind = update?.['sessionUpdate']

  switch (kind) {
    case 'user_message_chunk':
      return upsertMessage(client, event, workstreamId, turnId, 'user', {
        content: update?.['content'] as ContentBlock,
        messageId: update?.['messageId'] as string | null | undefined,
      }, touched)
    case 'agent_message_chunk':
      return upsertMessage(client, event, workstreamId, turnId, 'agent', {
        content: update?.['content'] as ContentBlock,
        messageId: update?.['messageId'] as string | null | undefined,
      }, touched)
    case 'agent_thought_chunk':
      return upsertMessage(client, event, workstreamId, turnId, 'thought', {
        content: update?.['content'] as ContentBlock,
        messageId: update?.['messageId'] as string | null | undefined,
      }, touched)
    case 'tool_call':
    case 'tool_call_update':
      return upsertToolCall(
        client,
        event,
        workstreamId,
        turnId,
        update?.['toolCallId'] as string,
        {
          name: update?.['name'] as string | null | undefined,
          title: update?.['title'] as string | null | undefined,
          kind: update?.['kind'] as string | null | undefined,
          status: update?.['status'] as string | null | undefined,
          content: update?.['content'] as unknown[] | null | undefined,
          rawInput: update?.['rawInput'],
          rawOutput: update?.['rawOutput'],
          locations: update?.['locations'] as { readonly path: string; readonly line?: number | null }[] | null | undefined,
        },
        touched,
      )
    case 'plan':
      return upsertPlan(
        client,
        event,
        workstreamId,
        turnId,
        (update?.['entries'] as { content: string; priority: string; status: string }[]) ?? [],
        touched,
      )
    case 'usage_update':
      return upsertGenericSpine(
        client,
        event,
        workstreamId,
        null,
        'usage',
        `usage:${event.session_id}`,
        { used: update?.['used'] ?? null, size: update?.['size'] ?? null, cost: update?.['cost'] ?? null },
        touched,
      )
    case 'session_info_update':
      return upsertGenericSpine(
        client,
        event,
        workstreamId,
        null,
        'session_info',
        `session_info:${event.session_id}`,
        { title: update?.['title'] ?? null, updatedAt: update?.['updatedAt'] ?? null },
        touched,
      )
    default:
      return applyUnknown(client, event, workstreamId, turnId, touched)
  }
}

async function applyRequest(client: PoolClient, event: RawEventRow, workstreamId: string, turnId: string | null, touched: TouchTracker): Promise<void> {
  if (event.method === 'session/prompt' && event.direction === 'client_to_agent') {
    await openTurn(client, event, workstreamId, touched)
    if (event.purpose === 'handoff' && event.command_id) {
      await upsertHandoffItem(client, event, workstreamId, event.command_id, 'pending', touched)
    }
    return
  }
  if (event.method === 'session/request_permission') {
    const params = event.envelope['params'] as Record<string, unknown> | undefined
    const toolCall = params?.['toolCall'] as Record<string, unknown> | undefined
    const options = (params?.['options'] as unknown[]) ?? []
    let toolCallItemId: string | null = null
    if (toolCall?.['toolCallId']) {
      const item = await findItem(client, event.session_id, 'tool_call', { acpEntityId: toolCall['toolCallId'] as string })
      toolCallItemId = item?.id ?? null
    }
    const syntheticEntityKey = `permission:${event.session_id}:${JSON.stringify(event.rpc_id)}`
    const { id } = await touchSpine(client, {
      workstreamId,
      sessionId: event.session_id,
      turnId,
      itemKind: 'permission',
      syntheticEntityKey,
      event,
      currentValue: null,
    }, touched)
    await client.query(
      `INSERT INTO projection.permission_requests (item_id, tool_call_item_id, title, options, status, requested_at)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       ON CONFLICT (item_id) DO NOTHING`,
      [id, toolCallItemId, (toolCall?.['title'] as string | undefined) ?? null, JSON.stringify(options), event.observed_at],
    )
    await recomputeItemHash(client, id, 'permission', null)
    return
  }
  return applyUnknown(client, event, workstreamId, turnId, touched)
}

async function applyResponse(client: PoolClient, event: RawEventRow, workstreamId: string, turnId: string | null, touched: TouchTracker): Promise<void> {
  const request = await findRequestForResponse(client, event.session_id, event.direction, event.rpc_id)
  if (!request) return applyUnknown(client, event, workstreamId, turnId, touched)

  if (request.method === 'session/prompt' && request.commandId) {
    const result = event.envelope['result'] as { stopReason?: string; usage?: Record<string, unknown> } | undefined
    const error = event.envelope['error']
    if (result) {
      const status = result.stopReason === 'cancelled' ? 'cancelled' : 'completed'
      return closeTurn(client, event, workstreamId, request.commandId, status, result.stopReason ?? null, result.usage ?? null, touched)
    }
    if (error) return closeTurn(client, event, workstreamId, request.commandId, 'failed', null, null, touched)
    return
  }

  if (request.method === 'session/request_permission') {
    const syntheticEntityKey = `permission:${event.session_id}:${JSON.stringify(event.rpc_id)}`
    const item = await findItem(client, event.session_id, 'permission', { syntheticEntityKey })
    if (!item) return
    const result = event.envelope['result'] as { outcome?: { outcome: string; optionId?: string } } | undefined
    const outcome = result?.outcome
    const status = outcome?.outcome === 'cancelled' ? 'cancelled' : 'answered'
    await client.query(
      `UPDATE projection.permission_requests
       SET status = $2, outcome = $3, selected_option_id = $4, decided_by = 'user', decided_at = $5
       WHERE item_id = $1`,
      [item.id, status, outcome?.outcome ?? null, outcome?.optionId ?? null, event.observed_at],
    )
    await client.query('UPDATE projection.workstream_items SET latest_event_id = $2, latest_workstream_seq = $3, updated_at = $4 WHERE id = $1', [
      item.id,
      event.id,
      event.workstream_seq,
      event.observed_at,
    ])
    touched.items.add(item.id)
    await recomputeItemHash(client, item.id, 'permission', null)
    return
  }

  return applyUnknown(client, event, workstreamId, turnId, touched)
}

async function applyEvent(client: PoolClient, event: RawEventRow, workstreamId: string, touched: TouchTracker): Promise<void> {
  const turnId = event.command_id
  if (event.rpc_kind === 'notification' && event.method === 'session/update') {
    return applyNotification(client, event, workstreamId, turnId, touched)
  }
  if (event.rpc_kind === 'request') {
    return applyRequest(client, event, workstreamId, turnId, touched)
  }
  if (event.rpc_kind === 'response') {
    return applyResponse(client, event, workstreamId, turnId, touched)
  }
  return applyUnknown(client, event, workstreamId, turnId, touched)
}

export interface ProjectWorkstreamResult {
  readonly processed: number
  readonly throughWorkstreamSeq: number
  readonly feedPosition: number | null
}

/**
 * docs/specs/05 "Projection scheduling": compares the canonical head with the projector's own
 * checkpoint and folds missing events in sequence order — correct even if the notification that
 * triggered this run was missed or duplicated, since it re-derives from the durable checkpoint,
 * not from the notification itself. Emits one `upsert` feed event per item actually changed and
 * one `status` (subject=command) feed event per turn that opened/closed, all in the SAME
 * transaction as the checkpoint advance (docs/specs/05 "The projector commits these together").
 */
export async function projectWorkstream(client: PoolClient, workstreamId: string, now: Date): Promise<ProjectWorkstreamResult> {
  const checkpoint = await getCheckpoint(client, PROJECTOR_NAME, workstreamId)

  await client.query('BEGIN')
  try {
    const { rows: events } = await client.query<RawEventRow>(
      `SELECT id, workstream_id, workstream_seq, session_id, direction, rpc_kind, method, rpc_id, envelope, command_id, purpose, observed_at
       FROM product.workstream_events
       WHERE workstream_id = $1 AND workstream_seq > $2 AND ingest_mode = 'live'
       ORDER BY workstream_seq ASC`,
      [workstreamId, checkpoint.throughWorkstreamSeq],
    )

    const touched: TouchTracker = { items: new Set(), turns: new Set() }
    for (const event of events) {
      await applyEvent(client, event, workstreamId, touched)
    }

    const last = events[events.length - 1]
    let feedPosition: number | null = null

    if (last) {
      const throughSeq = last.workstream_seq
      for (const itemId of touched.items) {
        const item = await readWorkstreamItem(client, itemId)
        if (!item) continue
        feedPosition = await appendFeedEvent(client, {
          workstreamId,
          throughWorkstreamSeq: throughSeq,
          operation: 'upsert',
          itemId,
          payload: item as unknown as Json,
          createdAt: now,
        })
      }
      for (const turnId of touched.turns) {
        const turn = await readWorkstreamTurn(client, turnId)
        if (!turn) continue
        feedPosition = await appendFeedEvent(client, {
          workstreamId,
          throughWorkstreamSeq: throughSeq,
          operation: 'status',
          payload: { subject: 'command', subjectId: turnId, state: { status: turn.status, stopReason: turn.stopReason, usage: turn.usage } },
          createdAt: now,
        })
      }
      await advanceCheckpoint(client, PROJECTOR_NAME, workstreamId, PROJECTOR_VERSION, throughSeq, last.id, now)
    }

    await client.query('COMMIT')
    return { processed: events.length, throughWorkstreamSeq: last?.workstream_seq ?? checkpoint.throughWorkstreamSeq, feedPosition }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export interface SweepResult {
  readonly workstreamsSwept: number
}

/**
 * docs/specs/05 "Projection scheduling": `product.journal_outbox` is a reliable notification that
 * canonical work exists, not the Web feed itself — missing/duplicate notifications cannot change
 * correctness because `projectWorkstream` re-derives progress from its own checkpoint, never from
 * the outbox row. This is the actual "consume journal notifications" driver: find every Workstream
 * with unpublished outbox rows, project it, then mark its now-covered rows published. A caller runs
 * this on an interval (apps/web's process) or on-demand (tests) — the outbox makes either safe.
 */
export async function sweepProjector(pool: Pool, now: Date): Promise<SweepResult> {
  const listClient = await pool.connect()
  let workstreamIds: string[]
  try {
    const { rows } = await listClient.query<{ workstream_id: string }>(
      'SELECT DISTINCT workstream_id FROM product.journal_outbox WHERE published_at IS NULL',
    )
    workstreamIds = rows.map((row) => row.workstream_id)
  } finally {
    listClient.release()
  }

  for (const workstreamId of workstreamIds) {
    const client = await pool.connect()
    try {
      const result = await projectWorkstream(client, workstreamId, now)
      if (result.processed > 0) {
        await client.query(
          'UPDATE product.journal_outbox SET published_at = $2 WHERE workstream_id = $1 AND workstream_seq <= $3 AND published_at IS NULL',
          [workstreamId, now, result.throughWorkstreamSeq],
        )
      }
    } finally {
      client.release()
    }
  }
  return { workstreamsSwept: workstreamIds.length }
}
