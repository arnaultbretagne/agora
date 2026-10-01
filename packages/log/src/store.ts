import { randomUUID, createHash } from 'node:crypto'
import { Pool, types, type PoolClient } from 'pg'
import { validate, idKey, requestMethod, type Direction, type Reason, type Envelope } from './acp.ts'
import { decode, encode, hash, object, uuid, supported } from './json.ts'
import { fold, type State } from './state.ts'

types.setTypeParser(20, (value) => value)
export interface Entry {
  workstream: string
  position: string
  time: string
  kind: string
  execution: string | null
  session: string | null
  content: Record<string, unknown>
  direction: Direction | null
  rpc_kind: string | null
  method: string | null
  correlated_method: string | null
  request_position: string | null
  rpc_id: unknown
  command: string | null
  connection: string | null
  receive_ordinal: string | null
}
export interface Append {
  kind: string
  execution?: string | null
  session?: string | null
  content: unknown
  raw?: string
  direction?: Direction
  rpc_kind?: string
  method?: string | null
  correlated_method?: string | null
  request_position?: string
  rpc_id?: unknown
  command?: string
  connection?: string
  receive_ordinal?: string
}
export type Answer =
  | { accepted: true; command: string; position: string; execution?: string; requestId?: string; session?: string }
  | { accepted: false; reason: string }
export interface Command {
  id: string
  kind: 'Create' | 'Write' | 'Cancel' | 'RespondPermission' | 'Stop'
  target: Record<string, unknown>
  body: Record<string, unknown>
}
export interface AcceptedEffect {
  execution?: string
  claimName?: string
  line?: { method?: string; params?: unknown; id?: unknown; result?: unknown }
  session?: string
  body?: Record<string, unknown>
}
export class Transaction {
  readonly client: PoolClient
  readonly workstream: string
  position: bigint
  constructor(client: PoolClient, workstream: string, position: string) {
    this.client = client
    this.workstream = workstream
    this.position = BigInt(position)
  }
  async entries(): Promise<Entry[]> {
    return readEntries(this.client, this.workstream)
  }
  async append(input: Append): Promise<string> {
    const position = String(++this.position)
    await this.client.query(
      `INSERT INTO entries(workstream,position,kind,execution,session,content,direction,rpc_kind,method,correlated_method,request_position,rpc_id,command,connection,receive_ordinal)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
      [
        this.workstream,
        position,
        input.kind,
        input.execution ?? null,
        input.session ?? null,
        input.raw ?? encode(input.content),
        input.direction ?? null,
        input.rpc_kind ?? null,
        input.method ?? null,
        input.correlated_method ?? null,
        input.request_position ?? null,
        input.rpc_id === undefined ? null : encode(input.rpc_id),
        input.command ?? null,
        input.connection ?? null,
        input.receive_ordinal ?? null,
      ],
    )
    await this.client.query('UPDATE workstreams SET last_position=$2 WHERE id=$1', [this.workstream, position])
    return position
  }
  async outgoing(
    execution: string,
    line: AcceptedEffect['line'],
    session?: string,
    command?: string,
  ): Promise<{ position: string; id: unknown }> {
    if (!line) throw new Error('missing_line')
    const isRequest = line.method !== undefined && requestMethod(line.method) && line.result === undefined
    const id = Object.hasOwn(line, 'id')
      ? line.id
      : isRequest
        ? `agora-${execution}-${String(this.position + 1n)}`
        : undefined
    const message = { jsonrpc: '2.0', ...line, ...(id === undefined ? {} : { id }) }
    const state = fold(await this.entries())
    const correlation =
      line.method === undefined && id !== undefined ? state.requests.get(`in:${idKey(id)}`) : undefined
    const result = validate(
      encode(message),
      'out',
      correlation ? { method: correlation.method!, direction: 'in' } : undefined,
    )
    if (!result.ok) throw new Error(result.reason)
    const position = await this.acp(
      result.envelope,
      execution,
      session ?? null,
      'out',
      command,
      undefined,
      undefined,
      correlation?.method ?? undefined,
      correlation?.position,
    )
    return { position, id }
  }
  async acp(
    envelope: Envelope,
    execution: string,
    session: string | null,
    direction: Direction,
    command?: string,
    connection?: string,
    ordinal?: string,
    correlatedMethod?: string,
    requestPosition?: string,
  ): Promise<string> {
    return this.append({
      kind: 'acp',
      execution,
      session,
      content: envelope.value,
      raw: envelope.raw,
      direction,
      rpc_kind: envelope.kind,
      method: envelope.method,
      rpc_id: envelope.id,
      ...(command ? { command } : {}),
      ...(connection ? { connection } : {}),
      ...(ordinal ? { receive_ordinal: ordinal } : {}),
      ...(correlatedMethod ? { correlated_method: correlatedMethod } : {}),
      ...(requestPosition ? { request_position: requestPosition } : {}),
    })
  }
}
export async function readEntries(client: Pool | PoolClient, workstream: string): Promise<Entry[]> {
  const result = await client.query(
    'SELECT workstream,position,time::text,kind,execution,session,content::text,direction,rpc_kind,method,correlated_method,request_position,rpc_id::text,command,connection,receive_ordinal FROM entries WHERE workstream=$1 ORDER BY position',
    [workstream],
  )
  return result.rows.map((row) => ({
    ...row,
    time: new Date(row.time).toISOString(),
    content: decode(row.content) as Record<string, unknown>,
    rpc_id: row.rpc_id === null ? null : decode(row.rpc_id),
  })) as Entry[]
}
export class LogStore {
  readonly writer: Pool
  readonly projector: Pool
  readonly anchors: Pool
  constructor(urls: { writer: string; projector: string; anchors: string }, max = 12) {
    this.writer = new Pool({ connectionString: urls.writer, max })
    this.projector = new Pool({ connectionString: urls.projector, max })
    this.anchors = new Pool({ connectionString: urls.anchors, max })
    // Never let pg's asynchronous error event print connection strings or exception text.
    for (const pool of [this.writer, this.projector, this.anchors]) pool.on('error', () => {})
  }
  async assertBoundaries(): Promise<void> {
    for (const [pool, role] of [
      [this.writer, 'writer'],
      [this.projector, 'projector'],
      [this.anchors, 'anchors'],
    ] as const) {
      const result = await pool.query(
        `SELECT r.rolcanlogin,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,
        pg_has_role(current_user,$1,'MEMBER') AS member,
        EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname=$1 AND (b.rolcanlogin OR b.rolsuper OR b.rolcreaterole OR b.rolcreatedb OR b.rolbypassrls)) AS boundary_bad,
        EXISTS(SELECT 1 FROM pg_roles p WHERE (p.rolsuper OR p.rolcreaterole OR p.rolcreatedb OR p.rolbypassrls) AND pg_has_role(current_user,p.oid,'MEMBER')) AS privileged,
        EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname=ANY($2) AND pg_has_role(current_user,p.oid,'MEMBER')) AS other,
        EXISTS(SELECT 1 FROM pg_class c WHERE c.relname IN ('workstreams','entries','commands','sessions','diagnostics','anchors','objects','thread','checkpoints') AND pg_has_role(current_user,c.relowner,'MEMBER')) AS owns
        FROM pg_roles r WHERE r.rolname=current_user`,
        [`agora_${role}`, ['writer', 'projector', 'anchors'].filter((r) => r !== role).map((r) => `agora_${r}`)],
      )
      const r = result.rows[0]
      if (
        !r?.rolcanlogin ||
        r.rolsuper ||
        r.rolcreaterole ||
        r.rolcreatedb ||
        r.rolbypassrls ||
        !r.member ||
        r.boundary_bad ||
        r.privileged ||
        r.other ||
        r.owns
      )
        throw new Error('invalid_runtime_role')
    }
  }
  async close(): Promise<void> {
    await Promise.all([this.writer.end(), this.projector.end(), this.anchors.end()])
  }
  async create(workstream: string, owner: string): Promise<void> {
    await this.writer.query('INSERT INTO workstreams(id,owner) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      uuid(workstream),
      uuid(owner),
    ])
    const result = await this.writer.query('SELECT owner FROM workstreams WHERE id=$1', [workstream])
    if (result.rows[0].owner !== owner) throw new Error('workstream_conflict')
  }
  async transaction<T>(workstream: string, run: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.writer.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query('SELECT id,last_position FROM workstreams WHERE id=$1 FOR UPDATE', [
        uuid(workstream),
      ])
      if (locked.rowCount !== 1) throw new Error('unknown_workstream')
      const result = await run(new Transaction(client, workstream, locked.rows[0].last_position))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
  entries(workstream: string): Promise<Entry[]> {
    return readEntries(this.writer, uuid(workstream))
  }
  async state(workstream: string): Promise<State> {
    return fold(await this.entries(workstream))
  }
  async accept(
    workstream: string,
    command: Command,
    decide: (state: State, tx: Transaction) => Promise<AcceptedEffect | string>,
  ): Promise<Answer> {
    uuid(command.id)
    if (!supported(command)) return { accepted: false, reason: 'invalid_command' }
    const fingerprint = hash({ kind: command.kind, target: command.target, body: command.body })
    try {
      return await this.transaction(workstream, async (tx) => {
        const found = await tx.client.query(
          'SELECT fingerprint,answer::text FROM commands WHERE workstream=$1 AND id=$2',
          [workstream, command.id],
        )
        if (found.rowCount)
          return found.rows[0].fingerprint === fingerprint
            ? (decode(found.rows[0].answer) as Answer)
            : { accepted: false, reason: 'command_conflict' }
        const effect = await decide(fold(await tx.entries()), tx)
        if (typeof effect === 'string') return { accepted: false, reason: effect }
        const position = await tx.append({
          kind: 'command',
          content: {
            ...command,
            body: effect.body ?? command.body,
            ...(effect.execution ? { execution: effect.execution } : {}),
            ...(effect.claimName ? { claimName: effect.claimName } : {}),
          },
          command: command.id,
          ...(effect.execution ? { execution: effect.execution } : {}),
          ...(effect.session ? { session: effect.session } : {}),
        })
        let requestId: string | undefined
        if (effect.line && effect.execution) {
          const outgoing = await tx.outgoing(effect.execution, effect.line, effect.session, command.id)
          if (typeof outgoing.id === 'string') requestId = outgoing.id
        }
        const answer: Answer = {
          accepted: true,
          command: command.id,
          position,
          ...(effect.execution ? { execution: effect.execution } : {}),
          ...(effect.session ? { session: effect.session } : {}),
          ...(requestId ? { requestId } : {}),
        }
        await tx.client.query(
          'INSERT INTO commands(workstream,id,kind,target,fingerprint,answer,position,execution,claim_name) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,$9)',
          [
            workstream,
            command.id,
            command.kind,
            encode(command.target),
            fingerprint,
            encode(answer),
            position,
            command.kind === 'Create' ? effect.execution : null,
            effect.claimName ?? null,
          ],
        )
        return answer
      })
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return { accepted: false, reason: 'execution_conflict' }
      if (
        error instanceof Error &&
        [
          'invalid_body',
          'wrong_direction',
          'invalid_envelope',
          'unsafe_id',
          'unsupported_json_value',
          'line_too_large',
        ].includes(error.message)
      )
        return { accepted: false, reason: error.message }
      throw error
    }
  }
  async incoming(
    workstream: string,
    execution: string,
    connection: string,
    ordinal: string,
    raw: Uint8Array | string,
  ): Promise<{ handled: boolean; position?: string; reason?: Reason }> {
    return this.transaction(workstream, async (tx) => {
      const prior = await tx.client.query(
        'SELECT position FROM entries WHERE connection=$1 AND receive_ordinal=$2 UNION ALL SELECT NULL AS position FROM diagnostics WHERE connection=$1 AND receive_ordinal=$2',
        [connection, ordinal],
      )
      if (prior.rowCount)
        return {
          handled: prior.rows[0].position !== null,
          ...(prior.rows[0].position === null ? {} : { position: prior.rows[0].position }),
        }
      const entries = await tx.entries(),
        state = fold(entries)
      let candidate: Record<string, unknown> | null = null
      try {
        candidate = object(
          decode(typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw)),
        )
      } catch {
        /* Validation writes a safe diagnostic. */
      }
      const foundRequest =
        candidate && Object.hasOwn(candidate, 'id') && !Object.hasOwn(candidate, 'method')
          ? state.requests.get(`out:${idKey(candidate.id)}`)
          : undefined
      const request = foundRequest?.execution === execution ? foundRequest : undefined
      const result = validate(raw, 'in', request ? { method: request.method!, direction: 'out' } : undefined)
      if (!result.ok) {
        await tx.client.query(
          'INSERT INTO diagnostics(id,workstream,execution,connection,receive_ordinal,direction,reason,size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            randomUUID(),
            workstream,
            execution,
            connection,
            ordinal,
            'in',
            result.reason,
            Buffer.byteLength(raw),
            createHash('sha256').update(raw).digest('hex'),
          ],
        )
        if (request)
          await tx.append({
            kind: 'request.failed',
            execution,
            session: request.session,
            content: { requestPosition: request.position, reason: result.reason },
          })
        return { handled: false, reason: result.reason }
      }
      const envelope = result.envelope
      const previousAnswer = request ? entries.find((e) => e.kind === 'acp' && e.direction === 'in' &&
        e.request_position === request.position && ['response', 'error'].includes(e.rpc_kind ?? '')) : undefined
      let session = previousAnswer ? previousAnswer.session : request ? request.session :
        state.executions.get(execution)?.session ?? null
      const target = state.executions.get(execution)
      const params = object(request?.content.params),
        response = object(envelope.value.result)
      const opens =
        envelope.kind === 'response' &&
        request &&
        !state.answers.has(request.position) &&
        !target?.ended && !target?.lost && !target?.failed &&
        ['session/new', 'session/resume', 'session/load'].includes(request.method!)
      const acpId = opens ? (request!.method === 'session/new' ? response?.sessionId : params?.sessionId) : null
      if (opens && typeof acpId === 'string') session = randomUUID()
      const position = await tx.acp(
        envelope,
        execution,
        session,
        'in',
        undefined,
        connection,
        ordinal,
        request?.method ?? undefined,
        request?.position,
      )
      if (opens && typeof acpId === 'string') {
        const previous = state.executions.get(execution)?.session
        if (previous) {
          const end = await tx.append({
            kind: 'session.ended',
            execution,
            session: previous,
            content: { reason: 'replaced' },
          })
          await tx.client.query('UPDATE sessions SET ended_position=$2 WHERE id=$1 AND ended_position IS NULL', [
            previous,
            end,
          ])
        }
        const opened = await tx.append({
          kind: 'session.opened',
          execution,
          session,
          content: { acpId, responsePosition: position },
        })
        await tx.client.query(
          'INSERT INTO sessions(id,workstream,execution,acp_id,opened_position) VALUES($1,$2,$3,$4,$5)',
          [session, workstream, execution, acpId, opened],
        )
      }
      return { handled: true, position }
    })
  }
  async fact(workstream: string, input: Append): Promise<string> {
    return this.transaction(workstream, async (tx) => {
      const position = await tx.append(input)
      if (['execution.ended', 'execution.lost', 'execution.failed'].includes(input.kind) && input.execution) {
        const rows = await tx.client.query('SELECT id FROM sessions WHERE execution=$1 AND ended_position IS NULL', [
          input.execution,
        ])
        for (const row of rows.rows) {
          const end = await tx.append({
            kind: 'session.ended',
            execution: input.execution,
            session: row.id,
            content: { reason: object(input.content)?.reason ?? 'stopped' },
          })
          await tx.client.query('UPDATE sessions SET ended_position=$2 WHERE id=$1', [row.id, end])
        }
      }
      return position
    })
  }
  async anchor(input: {
    id: string
    workstream: string
    execution: string
    session: string | null
    metadata: unknown
    bytes: Uint8Array
  }): Promise<void> {
    await this.anchors.query(
      'INSERT INTO anchors(id,workstream,execution,session,metadata,content) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING',
      [
        uuid(input.id),
        input.workstream,
        input.execution,
        input.session,
        encode(input.metadata),
        Buffer.from(input.bytes),
      ],
    )
    await this.publishAnchors(input.workstream)
  }
  async publishAnchors(workstream: string): Promise<void> {
    await this.transaction(workstream, async (tx) => {
      const known = new Set((await tx.entries()).filter((e) => e.kind === 'anchor.received').map((e) => e.content.id))
      const rows = await tx.client.query(
        'SELECT id,execution,session,metadata::text FROM anchors WHERE workstream=$1 ORDER BY time,id',
        [workstream],
      )
      for (const row of rows.rows)
        if (!known.has(row.id))
          await tx.append({
            kind: 'anchor.received',
            execution: row.execution,
            session: row.session,
            content: { id: row.id, metadata: decode(row.metadata) },
          })
    })
  }
}
