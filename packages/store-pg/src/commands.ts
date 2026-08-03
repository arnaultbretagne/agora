import type { PoolClient } from 'pg'
import {
  createCommand,
  principalId,
  sessionId as toSessionId,
  workstreamId as toWorkstreamId,
  commandId as toCommandId,
  type CommandActorKind,
  type CommandPurpose,
  type CommandState,
  type CreateCommandInput,
  type DomainCommandType,
  type DurableCommand,
} from '@agora/domain'
import { assertNoSecretPattern } from './secret-guard.js'

export interface CreateOrReuseCommandInput extends CreateCommandInput {
  /** The command's caller-supplied payload; opaque to the domain layer, persisted verbatim. */
  readonly request: Record<string, unknown>
}

interface CommandRow {
  readonly id: string
  readonly workstream_id: string
  readonly session_id: string | null
  readonly command_type: DomainCommandType
  readonly purpose: CommandPurpose | null
  readonly actor_kind: CommandActorKind
  readonly actor_id: string
  readonly idempotency_scope: string
  readonly idempotency_key: string
  readonly state: CommandState
  readonly accepted_at: Date
}

function hydrate(row: CommandRow): DurableCommand {
  return {
    id: toCommandId(row.id),
    type: row.command_type,
    workstreamId: toWorkstreamId(row.workstream_id),
    sessionId: row.session_id ? toSessionId(row.session_id) : undefined,
    actor: { kind: row.actor_kind, id: principalId(row.actor_id) },
    idempotencyScope: row.idempotency_scope,
    idempotencyKey: row.idempotency_key,
    purpose: row.purpose ?? undefined,
    state: row.state,
    acceptedAt: row.accepted_at,
  }
}

/**
 * Create-or-reuse by (workstream, idempotency scope, idempotency key): the domain layer already
 * derives a deterministic id from that triple (see @agora/domain deriveCommandId), and the
 * database's own UNIQUE constraint is the race-safe source of truth — `ON CONFLICT DO NOTHING`
 * plus a re-SELECT means two concurrent identical retries both return the SAME row.
 */
export async function createOrReuseCommand(
  client: PoolClient,
  input: CreateOrReuseCommandInput,
): Promise<DurableCommand> {
  const command = createCommand(input)
  assertNoSecretPattern('command.request', input.request)

  await client.query(
    `INSERT INTO product.commands
       (id, workstream_id, session_id, command_type, purpose, actor_kind, actor_id,
        idempotency_scope, idempotency_key, request, state, accepted_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     ON CONFLICT (workstream_id, idempotency_scope, idempotency_key) DO NOTHING`,
    [
      command.id,
      command.workstreamId,
      command.sessionId ?? null,
      command.type,
      command.purpose ?? null,
      command.actor.kind,
      command.actor.id,
      command.idempotencyScope,
      command.idempotencyKey,
      JSON.stringify(input.request),
      command.state,
      command.acceptedAt,
    ],
  )

  const { rows } = await client.query<CommandRow>(
    `SELECT id, workstream_id, session_id, command_type, purpose, actor_kind, actor_id,
            idempotency_scope, idempotency_key, state, accepted_at
     FROM product.commands
     WHERE workstream_id = $1 AND idempotency_scope = $2 AND idempotency_key = $3`,
    [command.workstreamId, command.idempotencyScope, command.idempotencyKey],
  )
  const row = rows[0]
  if (!row) throw new Error('unreachable: insert-or-conflict guarantees a row exists')
  return hydrate(row)
}

const TERMINAL_COMMAND_STATES = new Set<CommandState>(['completed', 'failed'])

export async function transitionCommandState(
  client: PoolClient,
  id: string,
  to: CommandState,
  updatedAt: Date,
  error?: { readonly code: string; readonly detail?: string },
): Promise<void> {
  const completedAt = TERMINAL_COMMAND_STATES.has(to) ? updatedAt : null
  await client.query(
    `UPDATE product.commands
     SET state = $2, updated_at = $3, error_code = $4, error_detail = $5, completed_at = $6
     WHERE id = $1`,
    [id, to, updatedAt, error?.code ?? null, error?.detail ?? null, completedAt],
  )
}
