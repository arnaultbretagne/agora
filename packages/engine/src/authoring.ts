// Intent authoring transaction (ADR 0003, engine contract "Intent authoring and revision
// selection"): per-Workstream serialization, request-key idempotency, immutable append, coalesced
// work upsert with a fresh work generation, and the empty-NOTIFY tick, all in one transaction.
import type { Intent } from '@agora/domain'
import type pg from 'pg'
import type { QueryClient } from './db.js'

export const NOTIFY_CHANNEL = 'workstream_reconciliation'

export type RevisionSet = Readonly<Record<string, unknown>>

export interface AuthorIntentCommand {
  readonly workstreamId: string
  readonly principal: string
  readonly requestKey: string
  readonly intent: Intent
  readonly revisionSet: RevisionSet
}

export type AuthorIntentOutcome =
  | { readonly kind: 'created'; readonly intentSeq: number }
  | { readonly kind: 'replayed'; readonly intentSeq: number; readonly createdAt: Date }
  | { readonly kind: 'conflict'; readonly intentSeq: number }
  | { readonly kind: 'unknown_workstream' }

export interface EngineTimeOptions {
  readonly nowSql?: string | undefined
}

export function notifyTick(client: QueryClient): Promise<unknown> {
  return client.query(`NOTIFY ${NOTIFY_CHANNEL}`)
}

export async function authorIntent(
  client: pg.PoolClient,
  command: AuthorIntentCommand,
  options: EngineTimeOptions = {},
): Promise<AuthorIntentOutcome> {
  const now = options.nowSql ?? 'now()'
  await client.query('BEGIN')
  try {
    const owned = await client.query('SELECT 1 FROM workstreams WHERE id = $1 FOR UPDATE', [command.workstreamId])
    if (owned.rowCount === 0) {
      await client.query('ROLLBACK')
      return { kind: 'unknown_workstream' }
    }

    const existing = await client.query(
      'SELECT intent_seq, intent, created_at FROM workstream_intent_events WHERE workstream_id = $1 AND request_key = $2',
      [command.workstreamId, command.requestKey],
    )
    if (existing.rowCount !== 0) {
      const row = existing.rows[0]!
      // jsonb equality is canonical content equality: key order and formatting never matter.
      const sameContent = await client.query('SELECT $1::jsonb = $2::jsonb AS equal', [JSON.stringify(row['intent']), JSON.stringify(serializableIntent(command.intent))])
      if (sameContent.rows[0]!['equal'] === true) {
        await client.query('COMMIT')
        return { kind: 'replayed', intentSeq: row['intent_seq'], createdAt: row['created_at'] }
      }
      await client.query('ROLLBACK')
      return { kind: 'conflict', intentSeq: row['intent_seq'] }
    }

    const next = await client.query(
      'SELECT coalesce(max(intent_seq), 0) + 1 AS next_seq FROM workstream_intent_events WHERE workstream_id = $1',
      [command.workstreamId],
    )
    const intentSeq: number = next.rows[0]!['next_seq']

    await client.query(
      `INSERT INTO workstream_intent_events (workstream_id, intent_seq, intent, request_key, principal, revision_set)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb)`,
      [command.workstreamId, intentSeq, JSON.stringify(serializableIntent(command.intent)), command.requestKey, command.principal, JSON.stringify(command.revisionSet)],
    )

    await client.query(
      `INSERT INTO workstream_reconciliation_work
         (workstream_id, intent_seq, work_generation, due_at, claim_token, lease_until, attempt_count, blocking_cause, last_error, updated_at)
       VALUES ($1, $2, nextval('work_generation_seq'), ${now}, NULL, NULL, 0, NULL, NULL, ${now})
       ON CONFLICT (workstream_id) DO UPDATE SET
         intent_seq = EXCLUDED.intent_seq,
         work_generation = EXCLUDED.work_generation,
         due_at = EXCLUDED.due_at,
         claim_token = NULL,
         lease_until = NULL,
         attempt_count = 0,
         blocking_cause = NULL,
         last_error = NULL,
         updated_at = EXCLUDED.updated_at`,
      [command.workstreamId, intentSeq],
    )

    await notifyTick(client)
    await client.query('COMMIT')
    return { kind: 'created', intentSeq }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export interface SerializedIntent {
  readonly power: string
  readonly harness: string
  readonly capabilities: readonly string[]
  readonly model: string
  readonly effort: string
  readonly persona: string
}

export function serializableIntent(intent: Intent): SerializedIntent {
  return {
    power: intent.power,
    harness: intent.harness,
    capabilities: [...intent.capabilities],
    model: intent.model,
    effort: intent.effort,
    persona: intent.persona,
  }
}

export interface IntentEvent {
  readonly workstreamId: string
  readonly intentSeq: number
  readonly intent: SerializedIntent
  readonly requestKey: string
  readonly principal: string
  readonly revisionSet: Readonly<Record<string, unknown>>
  readonly createdAt: Date
}

export async function loadIntentEvent(client: QueryClient, workstreamId: string, intentSeq: number): Promise<IntentEvent | null> {
  const result = await client.query(
    `SELECT workstream_id, intent_seq, intent, request_key, principal, revision_set, created_at
     FROM workstream_intent_events WHERE workstream_id = $1 AND intent_seq = $2`,
    [workstreamId, intentSeq],
  )
  if (result.rowCount === 0) return null
  const row = result.rows[0]!
  return {
    workstreamId: row['workstream_id'],
    intentSeq: row['intent_seq'],
    intent: row['intent'],
    requestKey: row['request_key'],
    principal: row['principal'],
    revisionSet: row['revision_set'],
    createdAt: row['created_at'],
  }
}

export async function loadLatestIntentEvent(client: QueryClient, workstreamId: string): Promise<IntentEvent | null> {
  const result = await client.query(
    `SELECT workstream_id, intent_seq, intent, request_key, principal, revision_set, created_at
     FROM workstream_intent_events WHERE workstream_id = $1 ORDER BY intent_seq DESC LIMIT 1`,
    [workstreamId],
  )
  if (result.rowCount === 0) return null
  const row = result.rows[0]!
  return {
    workstreamId: row['workstream_id'],
    intentSeq: row['intent_seq'],
    intent: row['intent'],
    requestKey: row['request_key'],
    principal: row['principal'],
    revisionSet: row['revision_set'],
    createdAt: row['created_at'],
  }
}
