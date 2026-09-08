// ACP read model (ADR 0004 — readable models are projections): messages, thoughts, tool calls,
// plans, permission interactions, prompt turns and an unknown bucket fold from acp.envelope facts
// only. Item identity is the name-based UUID of (session_id, kind, entity_key), so rebuilds
// reproduce ids and the rebuild-equivalence hash matches.
import { createHash } from 'node:crypto'
import type pg from 'pg'
import type { FactRecord } from '@agora/journal'
import { nameBasedUuid } from '../ids.js'
import { stableStringify } from '../hash.js'
import type { Projector } from '../projector.js'

export const ACP_MODEL_NAME = 'acp-model'
export const ACP_MODEL_VERSION = '2'

const ITEM_ID_NAMESPACE = '3f9a1c72-8b4d-4c6e-9a10-5b6c7d8e9f01'
const TURN_ID_NAMESPACE = '8d0c2f64-93e1-4f5a-b2ab-6c7d8e9f0a1b'

function deriveItemId(sessionId: string, itemKind: string, entityKey: string): string {
  return nameBasedUuid(ITEM_ID_NAMESPACE, `${sessionId}:${itemKind}:${entityKey}`)
}

export interface AcpItem {
  readonly id: string
  readonly sessionId: string
  readonly itemKind: 'message' | 'thought' | 'tool_call' | 'plan' | 'permission' | 'unknown'
  readonly entityKey: string
  readonly value: Record<string, unknown>
  readonly firstSeq: number
  readonly latestSeq: number
}

export interface AcpTurn {
  readonly sessionId: string
  readonly commandId: string
  readonly status: 'running' | 'completed' | 'cancelled' | 'failed'
  readonly stopReason: string | null
  readonly usage: Record<string, unknown> | null
  readonly firstSeq: number
  readonly latestSeq: number
}

export interface AcpModelState {
  readonly items: ReadonlyMap<string, AcpItem>
  readonly turns: ReadonlyMap<string, AcpTurn>
}

export function emptyAcpModelState(): AcpModelState {
  return { items: new Map(), turns: new Map() }
}

interface Envelope {
  readonly jsonrpc?: string
  readonly id?: unknown
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: Record<string, unknown>
}

function updateDiscriminator(fact: FactRecord): { readonly update: Record<string, unknown>; readonly discriminator: string } | null {
  const envelope = fact.payload as Envelope
  const update = (envelope.params?.['update'] ?? null) as Record<string, unknown> | null
  if (update === null || typeof update !== 'object') return null
  const discriminator = update['sessionUpdate']
  if (typeof discriminator !== 'string') return null
  return { update, discriminator }
}

function chunkText(update: Record<string, unknown>): string {
  const content = update['content'] as { type?: string; text?: string } | undefined
  return typeof content?.text === 'string' ? content.text : ''
}

/** The projected value keeps the raw ACP content block — the readable model stays a fold, not a rewrite. */
function contentBlock(update: Record<string, unknown>): Record<string, unknown> {
  const content = update['content']
  return typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : { type: 'text', text: '' }
}

/** A turn's response completes every message of that Session: no chunk follows it. */
function completeMessages(state: AcpModelState, sessionId: string): AcpModelState {
  const items = new Map(state.items)
  for (const [id, item] of items) {
    if (item.sessionId === sessionId && item.itemKind === 'message') {
      items.set(id, { ...item, value: { ...item.value, completed: true } })
    }
  }
  return { ...state, items }
}

function putItem(state: AcpModelState, item: AcpItem): AcpModelState {
  const items = new Map(state.items)
  items.set(item.id, item)
  return { ...state, items }
}

function putTurn(state: AcpModelState, turn: AcpTurn): AcpModelState {
  const turns = new Map(state.turns)
  turns.set(turn.commandId, turn)
  return { ...state, turns }
}

/**
 * What the operator actually said, or `null` when the turn was not one of theirs.
 *
 * A Handoff is delivered as a `session/prompt` too — it is how a fresh context is told what the
 * Workstream already holds — and it is Agora talking to the harness, not a person talking to the
 * agent. It carries an `agora://…/handoffs/…` embedded resource, and that is what distinguishes it.
 * Rendering it in the transcript would put the whole prior conversation back on screen as if the
 * operator had pasted it.
 */
function promptText(envelope: Envelope): string | null {
  const blocks = (envelope.params as { prompt?: readonly Record<string, unknown>[] } | undefined)?.prompt
  if (!Array.isArray(blocks)) return null
  const isHandoff = blocks.some((block) => {
    const uri = (block['resource'] as { uri?: unknown } | undefined)?.uri
    return typeof uri === 'string' && uri.startsWith('agora://') && uri.includes('/handoffs/')
  })
  if (isHandoff) return null
  const text = blocks
    .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
    .map((block) => block['text'] as string)
    .join('')
  return text.length > 0 ? text : null
}

function foldAcpFact(state: AcpModelState, fact: FactRecord): AcpModelState {
  const envelope = fact.payload as Envelope
  if (fact.sessionId === null) return state

  // Outbound prompt request: opens the turn keyed by its command dispatch, AND records what was
  // said. Both halves matter. Until the second one existed, the operator's own messages were in no
  // projection at all: the record held the agent's side of every conversation and not the question
  // it answered. The browser drew the missing half from a local optimistic echo, which is why it
  // appeared BELOW the answer and vanished on reload — a transcript that reads backwards and then
  // forgets. `user_message_chunk` is not a substitute: it exists only if the agent chooses to replay
  // the message back, and claude-code does not.
  if (fact.acp?.rpcKind === 'request' && fact.acp.direction === 'client_to_agent' && fact.acp.method === 'session/prompt') {
    const next =
      fact.acp.commandId !== null && !state.turns.has(fact.acp.commandId)
        ? putTurn(state, {
            sessionId: fact.sessionId,
            commandId: fact.acp.commandId,
            status: 'running',
            stopReason: null,
            usage: null,
            firstSeq: fact.seq,
            latestSeq: fact.seq,
          })
        : state
    const said = promptText(envelope)
    if (said === null) return next
    const entityKey = `user:${fact.acp.commandId ?? `seq:${String(fact.seq)}`}`
    return putItem(next, {
      id: deriveItemId(fact.sessionId, 'message', entityKey),
      sessionId: fact.sessionId,
      itemKind: 'message',
      entityKey,
      value: { role: 'user', completed: true, content: [{ type: 'text', text: said }] },
      firstSeq: fact.seq,
      latestSeq: fact.seq,
    })
  }
  // Correlated response to a prompt: closes the running turn with its stop reason and usage.
  if (fact.acp?.rpcKind === 'response' && fact.acp.direction === 'agent_to_client' && fact.acp.correlatedMethod === 'session/prompt') {
    const commandId = findRunningTurnCommandId(state, fact.sessionId)
    if (commandId === null) return state
    const existing = state.turns.get(commandId)!
    const result = envelope.result ?? {}
    const stopReason = typeof result['stopReason'] === 'string' ? result['stopReason'] : null
    const status: AcpTurn['status'] = stopReason === 'cancelled' ? 'cancelled' : stopReason === 'end_turn' || stopReason === null ? 'completed' : 'failed'
    return putTurn(completeMessages(state, fact.sessionId), { ...existing, status, stopReason, usage: (result['usage'] as Record<string, unknown> | undefined) ?? null, latestSeq: fact.seq })
  }

  if (fact.acp?.rpcKind === 'request' && fact.acp.direction === 'agent_to_client' && fact.acp.method === 'session/request_permission') {
    const params = (envelope.params ?? {}) as { toolCall?: { toolCallId?: string } }
    const entityKey = params.toolCall?.toolCallId ?? `request:${JSON.stringify(fact.acp.rpcId ?? null)}`
    return putItem(state, {
      id: deriveItemId(fact.sessionId, 'permission', entityKey),
      sessionId: fact.sessionId,
      itemKind: 'permission',
      entityKey,
      value: { status: 'pending', toolCall: params.toolCall ?? null, requestRpcId: fact.acp.rpcId ?? null },
      firstSeq: fact.seq,
      latestSeq: fact.seq,
    })
  }
  // The outgoing response to a permission request carries the decision; one permission is in
  // flight at a time because the client awaits the operator before answering.
  if (fact.acp?.rpcKind === 'response' && fact.acp.direction === 'client_to_agent' && fact.acp.correlatedMethod === 'session/request_permission') {
    const pending = [...state.items.values()]
      .filter((item) => item.itemKind === 'permission' && item.value['status'] === 'pending')
      .sort((left, right) => right.latestSeq - left.latestSeq)[0]
    if (pending === undefined) return state
    return putItem(state, {
      ...pending,
      value: { ...pending.value, status: 'decided', outcome: envelope.result ?? null },
      latestSeq: fact.seq,
    })
  }

  if (fact.acp?.method === 'session/update' && fact.acp.rpcKind === 'notification') {
    const update = updateDiscriminator(fact)
    if (update === null) return state
    const { discriminator } = update
    if (discriminator === 'user_message_chunk' || discriminator === 'agent_message_chunk') {
      const direction = fact.acp.direction === 'client_to_agent' ? 'user' : 'agent'
      const messageId = typeof update.update['messageId'] === 'string' ? update.update['messageId'] : null
      const entityKey = `${direction}:${messageId ?? `stream:${fact.sessionId}`}`
      const id = deriveItemId(fact.sessionId, 'message', entityKey)
      const existing = state.items.get(id)
      if (existing === undefined) {
        return putItem(state, {
          id,
          sessionId: fact.sessionId,
          itemKind: 'message',
          entityKey,
          value: { role: direction === 'user' ? 'user' : 'agent', completed: false, content: [contentBlock(update.update)] },
          firstSeq: fact.seq,
          latestSeq: fact.seq,
        })
      }
      return putItem(state, {
        ...existing,
        value: { ...existing.value, content: [...((existing.value['content'] as unknown[]) ?? []), contentBlock(update.update)] },
        latestSeq: fact.seq,
      })
    }
    if (discriminator === 'agent_thought_chunk') {
      const entityKey = `thought:${fact.sessionId}`
      const id = deriveItemId(fact.sessionId, 'thought', entityKey)
      const existing = state.items.get(id)
      if (existing === undefined) {
        return putItem(state, { id, sessionId: fact.sessionId, itemKind: 'thought', entityKey, value: { content: [contentBlock(update.update)] }, firstSeq: fact.seq, latestSeq: fact.seq })
      }
      return putItem(state, { ...existing, value: { ...existing.value, content: [...((existing.value['content'] as unknown[]) ?? []), contentBlock(update.update)] }, latestSeq: fact.seq })
    }
    if (discriminator === 'tool_call' || discriminator === 'tool_call_update') {
      const toolCallId = (update.update['toolCallId'] as string | undefined) ?? 'unknown'
      const id = deriveItemId(fact.sessionId, 'tool_call', toolCallId)
      const existing = state.items.get(id)
      const patch = {
        toolCallId,
        title: update.update['title'] ?? null,
        kind: update.update['kind'] ?? null,
        status: update.update['status'] ?? null,
        raw: update.update,
      }
      if (existing === undefined) {
        return putItem(state, { id, sessionId: fact.sessionId, itemKind: 'tool_call', entityKey: toolCallId, value: patch, firstSeq: fact.seq, latestSeq: fact.seq })
      }
      return putItem(state, { ...existing, value: { ...existing.value, ...patch }, latestSeq: fact.seq })
    }
    if (discriminator === 'plan' || discriminator === 'plan_update' || discriminator === 'plan_removed') {
      const id = deriveItemId(fact.sessionId, 'plan', 'plan')
      return putItem(state, {
        id,
        sessionId: fact.sessionId,
        itemKind: 'plan',
        entityKey: 'plan',
        value: { entries: update.update['entries'] ?? null, removed: discriminator === 'plan_removed' },
        firstSeq: fact.seq,
        latestSeq: fact.seq,
      })
    }
  }
  // An accepted envelope the current model does not fold (an extension method from the agent, or
  // any unmodeled inbound frame): preserved and inspectable in the unknown bucket, never dropped
  // (ADR 0004). A future discriminator under a known method never reaches this fold at all — the
  // capture seam rejects it as a protocol error (findings §1).
  if (fact.acp?.direction === 'agent_to_client' && fact.acp.rpcKind !== 'response') {
    const entityKey = `frame:${fact.seq}`
    return putItem(state, {
      id: deriveItemId(fact.sessionId, 'unknown', entityKey),
      sessionId: fact.sessionId,
      itemKind: 'unknown',
      entityKey,
      value: { method: fact.acp.method, rpcKind: fact.acp.rpcKind, payload: fact.payload },
      firstSeq: fact.seq,
      latestSeq: fact.seq,
    })
  }
  return state
}

function findRunningTurnCommandId(state: AcpModelState, sessionId: string): string | null {
  return [...state.turns.values()].find((turn) => turn.sessionId === sessionId && turn.status === 'running')?.commandId ?? null
}

export interface AcpRunnerOptions {
  /** Runs after every successful persist: emits feed rows for changed items/turns. */
  readonly onEvents?: (events: readonly AcpFeedEvent[]) => Promise<void>
}

export interface AcpFeedEvent {
  readonly operation: 'upsert' | 'status'
  readonly itemId: string | null
  readonly payload: Record<string, unknown>
}

export function createAcpModelProjector(options: AcpRunnerOptions = {}): Projector<AcpModelState> {
  const persistFeed = async (
    client: pg.PoolClient,
    workstreamId: string,
    throughSeq: number,
    changed: AcpFeedEvent,
  ): Promise<void> => {
    await client.query(
      `INSERT INTO feed_events (workstream_id, through_seq, operation, item_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [workstreamId, throughSeq, changed.operation, changed.itemId, JSON.stringify(changed.payload)],
    )
    await options.onEvents?.([changed])
  }

  return {
    name: ACP_MODEL_NAME,
    version: ACP_MODEL_VERSION,
    emptyState: emptyAcpModelState,

    async load(client, workstreamId): Promise<AcpModelState> {
      const items = await client.query('SELECT * FROM projection_items WHERE workstream_id = $1', [workstreamId])
      const turns = await client.query('SELECT * FROM projection_turns WHERE workstream_id = $1', [workstreamId])
      const itemMap = new Map<string, AcpItem>()
      for (const row of items.rows) {
        itemMap.set(row['id'], {
          id: row['id'],
          sessionId: row['session_id'],
          itemKind: row['item_kind'],
          entityKey: row['entity_key'],
          value: row['value'],
          firstSeq: row['first_seq'],
          latestSeq: row['latest_seq'],
        })
      }
      const turnMap = new Map<string, AcpTurn>()
      for (const row of turns.rows) {
        turnMap.set(row['command_id'], {
          sessionId: row['session_id'],
          commandId: row['command_id'],
          status: row['status'],
          stopReason: row['stop_reason'],
          usage: row['usage'],
          firstSeq: row['first_seq'],
          latestSeq: row['latest_seq'],
        })
      }
      return { items: itemMap, turns: turnMap }
    },

    fold: (state, fact) => {
      if (fact.kind !== 'acp.envelope') return state
      return foldAcpFact(state, fact)
    },

    async persist(client, workstreamId, state): Promise<void> {
      const previous = await this.load(client, workstreamId)
      for (const item of state.items.values()) {
        const before = previous.items.get(item.id)
        const changed = before === undefined || before.latestSeq !== item.latestSeq || stableStringify(before.value) !== stableStringify(item.value)
        if (!changed) continue
        const contentSha256 = createHash('sha256').update(stableStringify(item.value)).digest('hex')
        await client.query(
          `INSERT INTO projection_items (id, workstream_id, session_id, item_kind, entity_key, value, content_sha256, first_seq, latest_seq, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now())
           ON CONFLICT (id) DO UPDATE SET
             value = EXCLUDED.value, content_sha256 = EXCLUDED.content_sha256, latest_seq = EXCLUDED.latest_seq, updated_at = now()`,
          [item.id, workstreamId, item.sessionId, item.itemKind, item.entityKey, JSON.stringify(item.value), contentSha256, item.firstSeq, item.latestSeq],
        )
        // `entityKey` travels with the event because it is the only thing that ties a projected item
        // back to the live interaction it describes — a permission item to the request an operator is
        // being asked to answer. The item id cannot do it: it is derived from the entity key, not the
        // other way round.
        await persistFeed(client, workstreamId, item.latestSeq, {
          operation: 'upsert',
          itemId: item.id,
          payload: { ...item.value, itemKind: item.itemKind, sessionId: item.sessionId, entityKey: item.entityKey },
        })
      }
      for (const turn of state.turns.values()) {
        const before = previous.turns.get(turn.commandId)
        const changed = before === undefined || before.latestSeq !== turn.latestSeq || before.status !== turn.status
        if (!changed) continue
        const turnRowId = nameBasedUuid(TURN_ID_NAMESPACE, `${workstreamId}:${turn.commandId}`)
        await client.query(
          `INSERT INTO projection_turns (id, workstream_id, session_id, command_id, status, stop_reason, usage, first_seq, latest_seq, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now())
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status, stop_reason = EXCLUDED.stop_reason, usage = EXCLUDED.usage, latest_seq = EXCLUDED.latest_seq, updated_at = now()`,
          [turnRowId, workstreamId, turn.sessionId, turn.commandId, turn.status, turn.stopReason, turn.usage === null ? null : JSON.stringify(turn.usage), turn.firstSeq, turn.latestSeq],
        )
        await persistFeed(client, workstreamId, turn.latestSeq, { operation: 'status', itemId: null, payload: { commandId: turn.commandId, status: turn.status, stopReason: turn.stopReason } })
      }
    },

    async clear(client, workstreamId): Promise<void> {
      await client.query('DELETE FROM projection_items WHERE workstream_id = $1', [workstreamId])
      await client.query('DELETE FROM projection_turns WHERE workstream_id = $1', [workstreamId])
    },

    async hashInputs(client, workstreamId): Promise<readonly string[]> {
      const items = await client.query('SELECT id, item_kind, entity_key, content_sha256, first_seq, latest_seq FROM projection_items WHERE workstream_id = $1', [workstreamId])
      const turns = await client.query('SELECT command_id, status, stop_reason, first_seq, latest_seq FROM projection_turns WHERE workstream_id = $1', [workstreamId])
      return [
        ...items.rows.map((row) => `item:${row['id']}:${row['item_kind']}:${row['content_sha256']}:${row['first_seq']}:${row['latest_seq']}`),
        ...turns.rows.map((row) => `turn:${row['command_id']}:${row['status']}:${row['stop_reason'] ?? ''}:${row['first_seq']}:${row['latest_seq']}`),
      ]
    },
  }
}
