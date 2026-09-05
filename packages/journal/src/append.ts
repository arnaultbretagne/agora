// Canonical append (ADR 0004): every fact takes its seq from the Workstream head under the
// Workstream row lock — the same lock Intent authoring holds — so birth, Intents and facts are
// totally ordered. Wall-clock is recorded, never used for ordering. Runs in the caller's
// transaction; the caller owns commit/rollback.
import type pg from 'pg'
import { isRegisteredKind, isSessionScopedKind } from './fact-kinds.js'
import { assertNoSecretPattern } from './secret-guard.js'

export class JournalError extends Error {
  constructor(
    readonly code: 'unknown_workstream' | 'unregistered_kind' | 'session_scoped_required',
    message: string,
  ) {
    super(message)
    this.name = 'JournalError'
  }
}

export interface AppendFactCommand {
  readonly sessionId?: string | null
  readonly kind: string
  readonly payload: unknown
  readonly causation?: unknown
}

export interface AppendedFact {
  readonly seq: number
  readonly recordedAt: Date
}

export async function appendFact(
  client: pg.PoolClient,
  workstreamId: string,
  command: AppendFactCommand,
  options: { readonly nowSql?: string } = {},
): Promise<AppendedFact> {
  const now = options.nowSql ?? 'now()'
  if (!isRegisteredKind(command.kind)) {
    throw new JournalError('unregistered_kind', `fact kind "${command.kind}" is not registered in contracts/schemas/fact-kinds.json`)
  }
  if (isSessionScopedKind(command.kind) && (command.sessionId === undefined || command.sessionId === null)) {
    throw new JournalError('session_scoped_required', `fact kind "${command.kind}" is session-scoped and requires a sessionId`)
  }
  assertNoSecretPattern('payload', command.payload)
  assertNoSecretPattern('causation', command.causation)

  const head = await client.query(
    `UPDATE workstreams SET head_seq = head_seq + 1 WHERE id = $1 RETURNING head_seq`,
    [workstreamId],
  )
  if (head.rowCount === 0) {
    throw new JournalError('unknown_workstream', `no Workstream ${workstreamId}`)
  }
  const seq: number = head.rows[0]!['head_seq']
  const inserted = await client.query(
    `INSERT INTO workstream_facts (workstream_id, seq, session_id, kind, payload, causation, recorded_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, ${now})
     RETURNING recorded_at`,
    [workstreamId, seq, command.sessionId ?? null, command.kind, JSON.stringify(command.payload), command.causation === undefined ? null : JSON.stringify(command.causation)],
  )
  return { seq, recordedAt: inserted.rows[0]!['recorded_at'] }
}
