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

export interface AcpEnvelopeMetadata {
  readonly direction: 'client_to_agent' | 'agent_to_client'
  readonly rpcKind: 'request' | 'response' | 'notification'
  readonly method: string | null
  readonly correlatedMethod: string | null
  readonly rpcId: unknown
  readonly commandId: string | null
  readonly connectionId: string
  readonly observationId: string
  readonly frameSize: number
}

export interface AppendFactCommand {
  readonly sessionId?: string | null
  readonly kind: string
  /**
   * The structured payload. Mutually exclusive with `payloadRawText`: an ACP envelope's canonical
   * value is the raw frame text, never a parsed-and-reserialized object (ADR 0004, findings §1).
   */
  readonly payload?: unknown
  readonly payloadRawText?: string
  readonly causation?: unknown
  /** ACP indexing metadata persisted beside the envelope (S4 columns). */
  readonly acp?: AcpEnvelopeMetadata
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
  // The ACP envelope is the one exempt field: full passthrough is the point of ADR 0004, and its
  // confidentiality rules are its own. Guard the metadata and causation as usual.
  if (command.payloadRawText === undefined) {
    assertNoSecretPattern('payload', command.payload)
  }
  assertNoSecretPattern('causation', command.causation)

  const head = await client.query(
    `UPDATE workstreams SET head_seq = head_seq + 1 WHERE id = $1 RETURNING head_seq`,
    [workstreamId],
  )
  if (head.rowCount === 0) {
    throw new JournalError('unknown_workstream', `no Workstream ${workstreamId}`)
  }
  const seq: number = head.rows[0]!['head_seq']
  const payloadParam = command.payloadRawText ?? JSON.stringify(command.payload)
  const acp = command.acp
  const inserted = await client.query(
    `INSERT INTO workstream_facts
       (workstream_id, seq, session_id, kind, payload, causation, recorded_at,
        direction, rpc_kind, method, correlated_method, rpc_id, command_id, connection_id, observation_id, frame_size)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, ${now}, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15)
     RETURNING recorded_at`,
    [
      workstreamId,
      seq,
      command.sessionId ?? null,
      command.kind,
      payloadParam,
      command.causation === undefined ? null : JSON.stringify(command.causation),
      acp?.direction ?? null,
      acp?.rpcKind ?? null,
      acp?.method ?? null,
      acp?.correlatedMethod ?? null,
      acp?.rpcId === undefined || acp.rpcId === null ? null : JSON.stringify(acp.rpcId),
      acp?.commandId ?? null,
      acp?.connectionId ?? null,
      acp?.observationId ?? null,
      acp?.frameSize ?? null,
    ],
  )
  return { seq, recordedAt: inserted.rows[0]!['recorded_at'] }
}
