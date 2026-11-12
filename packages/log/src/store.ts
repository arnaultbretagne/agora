// The log's storage (docs/specs/log.md, "Entries", "ACP lines", "Storage"). Entries are appended under
// a lock on their Workstream; the state folded from them is cached per Workstream and brought up to
// date by reading only the entries after the last position folded — under that same lock inside a
// transaction, so a decision always sees every committed entry.
import { randomUUID, createHash } from 'node:crypto'
import { Pool, types, type PoolClient } from 'pg'
import { validate, idKey, requestMethod, type Direction, type Reason, type Envelope } from './acp.ts'
import { decode, encode, hash, object, uuid, supported } from './json.ts'
import { announcement, childWorkstream, fold, type State } from './state.ts'
import { digest, expandFiles, findFiles, type FileRef, type Files } from './files.ts'

// docs/specs/log.md, "Storage": bigint stays a decimal string; arithmetic uses JavaScript bigint.
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
  /** Where the content holds a file's reference (docs/specs/files.md, "References"); null when it holds none. */
  files: FileRef[] | null
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
  | { accepted: true; command: string; position: string; execution?: string; requestId?: string; session?: string; waiting?: true }
  | { accepted: false; reason: string }
export interface Command {
  id: string
  kind: 'Create' | 'Write' | 'Retract' | 'Cancel' | 'RespondPermission' | 'Configure' | 'Scope' | 'Stop' | 'Ask' | 'Answer'
  target: Record<string, unknown>
  body: Record<string, unknown>
}
export interface AcceptedEffect {
  execution?: string
  claimName?: string
  line?: { method?: string; params?: unknown; id?: unknown; result?: unknown }
  session?: string
  body?: Record<string, unknown>
  /** A Write with no line: it waits (docs/specs/log.md, "Messages during a turn"). */
  waits?: boolean
  /** A Create's message (docs/specs/log.md, "Commands"): written with it, a Write that waits, under this id. */
  message?: { id: string; prompt: unknown }
}

const COLUMNS =
  'workstream,position,time::text,kind,execution,session,content::text,direction,rpc_kind,method,correlated_method,request_position,rpc_id::text,command,connection,receive_ordinal,files'

function row(r: Record<string, unknown>): Entry {
  return {
    ...(r as unknown as Entry),
    time: new Date(String(r.time)).toISOString(),
    content: decode(String(r.content)) as Record<string, unknown>,
    rpc_id: r.rpc_id === null ? null : decode(String(r.rpc_id)),
    files: (r.files as FileRef[] | null) ?? null,
  }
}

export async function readEntries(client: Pool | PoolClient, workstream: string, after = '0'): Promise<Entry[]> {
  const result = await client.query(
    `SELECT ${COLUMNS} FROM entries WHERE workstream=$1 AND position>$2 ORDER BY position`,
    [workstream, after],
  )
  return result.rows.map(row)
}

interface Cached {
  state: State
  entries: Entry[]
  position: bigint
  sync: Promise<void>
}

export class Transaction {
  readonly client: PoolClient
  readonly workstream: string
  readonly state: State
  readonly entries: readonly Entry[]
  position: bigint
  private readonly files: Files | undefined
  constructor(client: PoolClient, workstream: string, cached: Cached, position: bigint, files?: Files) {
    this.client = client
    this.workstream = workstream
    this.state = cached.state
    this.entries = cached.entries
    this.position = position
    this.files = files
  }
  async append(input: Append): Promise<string> {
    // docs/specs/files.md, "A file": a command's or an ACP line's files go to R2 first, references in their place.
    let content = input.raw ?? encode(input.content)
    let refs: FileRef[] | null = null
    if (input.kind === 'command' || input.kind === 'acp') {
      const found = findFiles(input.content)
      if (found) {
        if (!this.files) throw new Error('files_unavailable')
        await this.files.keep(this.client, found.bytes)
        content = encode(found.value)
        refs = found.refs
      }
    }
    const position = String(++this.position)
    await this.client.query(
      `INSERT INTO entries(workstream,position,kind,execution,session,content,direction,rpc_kind,method,correlated_method,request_position,rpc_id,command,connection,receive_ordinal,files)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16::jsonb)`,
      [
        this.workstream,
        position,
        input.kind,
        input.execution ?? null,
        input.session ?? null,
        content,
        input.direction ?? null,
        input.rpc_kind ?? null,
        input.method ?? null,
        input.correlated_method ?? null,
        input.request_position ?? null,
        input.rpc_id === undefined ? null : encode(input.rpc_id),
        input.command ?? null,
        input.connection ?? null,
        input.receive_ordinal ?? null,
        refs === null ? null : JSON.stringify(refs),
      ],
    )
    await this.client.query('UPDATE workstreams SET last_position=$2 WHERE id=$1', [this.workstream, position])
    return position
  }
  /** Writes an outgoing line, never sent: the dispatcher sends it once `acp.dispatching` commits. */
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
    const correlation =
      line.method === undefined && id !== undefined ? this.state.requests.get(`in:${idKey(id)}`) : undefined
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
  /** Ends the execution's open Sessions, with the reason of the entry that ends them. */
  async endSessions(execution: string, reason: unknown): Promise<void> {
    const rows = await this.client.query('SELECT id FROM sessions WHERE execution=$1 AND ended_position IS NULL', [
      execution,
    ])
    for (const r of rows.rows) {
      const end = await this.append({ kind: 'session.ended', execution, session: r.id, content: { reason } })
      await this.client.query('UPDATE sessions SET ended_position=$2 WHERE id=$1', [r.id, end])
    }
  }
}

export class LogStore {
  readonly writer: Pool
  readonly projector: Pool
  readonly anchors: Pool
  private readonly cache = new Map<string, Cached>()
  readonly urls: { readonly writer: string; readonly projector: string; readonly anchors: string }
  /** The bucket (docs/specs/files.md); without it, an entry with a file or an anchor is refused `files_unavailable`. */
  readonly files: Files | undefined
  constructor(urls: { writer: string; projector: string; anchors: string }, max = 12, files?: Files) {
    this.urls = urls
    this.files = files
    this.writer = new Pool({ connectionString: urls.writer, max })
    this.projector = new Pool({ connectionString: urls.projector, max })
    this.anchors = new Pool({ connectionString: urls.anchors, max })
    // Never let pg's asynchronous error event print connection strings or exception text. pg-pool
    // detaches its own listener while a client is checked out: without one of ours, a connection
    // lost in the middle of a transaction would end the process instead of failing the transaction.
    for (const pool of [this.writer, this.projector, this.anchors]) {
      pool.on('error', () => {})
      pool.on('connect', (client) => client.on('error', () => {}))
    }
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
        EXISTS(SELECT 1 FROM pg_roles p WHERE (p.rolname=ANY($2) OR p.rolname IN ('pg_read_all_data','pg_write_all_data')) AND pg_has_role(current_user,p.oid,'MEMBER')) AS other,
        EXISTS(SELECT 1 FROM pg_class c WHERE c.relname IN ('workstreams','threads','entries','commands','sessions','diagnostics','anchors','files','objects','checkpoints','lists','listings') AND pg_has_role(current_user,c.relowner,'MEMBER')) AS owns
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
  /**
   * Creates a Workstream (docs/specs/log.md, "HTTP"). With a parent, a sub-stream of it ("Sub-streams"): the
   * parent's owner, root and depth plus one, the parent one of `allowed` owners when they are given.
   */
  async create(workstream: string, owner: string | null, parent: string | null = null, allowed: readonly string[] | null = null): Promise<void> {
    let line: { owner: string; root: string | null; depth: number }
    if (parent === null) line = { owner: uuid(owner), root: null, depth: 0 }
    else {
      const found = await this.writer.query('SELECT owner, coalesce(root,id) AS root, depth, host FROM workstreams WHERE id=$1', [uuid(parent)])
      const p = found.rows[0] as { owner: string; root: string; depth: number; host: string | null } | undefined
      // A native sub-stream starts nothing of Agora's (docs/specs/log.md, "Native sub-agents").
      if (!p || p.host !== null || (allowed !== null && !allowed.includes(p.owner))) throw new Error('unknown_parent')
      line = { owner: p.owner, root: p.root, depth: p.depth + 1 }
    }
    await this.writer.query('INSERT INTO workstreams(id,owner,parent,root,depth) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [
      uuid(workstream),
      line.owner,
      parent,
      line.root,
      line.depth,
    ])
    const result = await this.writer.query('SELECT owner, parent FROM workstreams WHERE id=$1', [workstream])
    if (result.rows[0].owner !== line.owner || result.rows[0].parent !== parent) throw new Error('workstream_conflict')
  }
  async workstreams(): Promise<string[]> {
    return (await this.writer.query('SELECT id FROM workstreams ORDER BY id')).rows.map((r) => r.id as string)
  }
  /** What a start must read back: Workstreams with an execution not ended, or an anchor without its entry. */
  async pending(): Promise<string[]> {
    const result = await this.writer.query(
      `SELECT c.workstream AS id FROM commands c WHERE c.kind='Create' AND NOT EXISTS
         (SELECT 1 FROM entries e WHERE e.workstream=c.workstream AND e.execution=c.execution AND e.kind='execution.ended')
       UNION SELECT a.workstream FROM anchors a WHERE NOT EXISTS
         (SELECT 1 FROM entries e WHERE e.workstream=a.workstream AND e.kind='anchor.received' AND e.content->>'id'=a.id::text)
       ORDER BY 1`,
    )
    return result.rows.map((r) => r.id as string)
  }
  /** The Workstreams whose core views are behind their entries; a checkpoint of another version counts as none. */
  async behind(version: string): Promise<string[]> {
    const last = new Map((await this.writer.query('SELECT id, last_position FROM workstreams')).rows.map((r) => [r.id as string, BigInt(r.last_position)]))
    const done = new Map(
      (await this.projector.query("SELECT workstream, position FROM checkpoints WHERE projector='core' AND version=$1", [version])).rows.map((r) => [
        r.workstream as string,
        BigInt(r.position),
      ]),
    )
    return [...last].filter(([id, position]) => position > (done.get(id) ?? 0n)).map(([id]) => id)
  }
  /** Lets go of a Workstream's cached entries; the next read folds them again. */
  forget(workstream: string): void {
    this.cache.delete(workstream)
  }
  private cached(workstream: string): Cached {
    let cached = this.cache.get(workstream)
    if (!cached) {
      cached = { state: fold([]), entries: [], position: 0n, sync: Promise.resolve() }
      cached.state.workstream = workstream
      this.cache.set(workstream, cached)
    }
    return cached
  }
  /** Folds the committed entries after the cached position; serialized, so an entry is folded once. */
  private sync(client: Pool | PoolClient, workstream: string): Promise<Cached> {
    const cached = this.cached(workstream)
    const next = cached.sync.then(async () => {
      const delta = (await readEntries(client, workstream, String(cached.position))).filter(
        (e) => BigInt(e.position) > cached.position,
      )
      if (!delta.length) return
      fold(delta, cached.state)
      cached.entries.push(...delta)
      cached.position = BigInt(delta.at(-1)!.position)
    })
    cached.sync = next.catch(() => {})
    return next.then(() => cached)
  }
  async transaction<T>(workstream: string, run: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.writer.connect()
    let broken = false
    try {
      // Each statement sees what committed before it: a file's row deleted by a sweep is seen gone (docs/specs/files.md).
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      // docs/specs/log.md, "Entries": the next position is the Workstream's, read under its lock.
      const locked = await client.query('SELECT last_position FROM workstreams WHERE id=$1 FOR UPDATE', [uuid(workstream)])
      if (locked.rowCount !== 1) throw new Error('unknown_workstream')
      const cached = await this.sync(client, workstream)
      const result = await run(new Transaction(client, workstream, cached, BigInt(locked.rows[0].last_position), this.files))
      await client.query('COMMIT')
      return result
    } catch (error) {
      // A connection that cannot even roll back is dropped, never handed out again.
      await client.query('ROLLBACK').catch(() => (broken = true))
      throw error
    } finally {
      client.release(broken)
    }
  }
  /** The Workstream's entries, in position order: the cache itself, never to be modified. */
  async entries(workstream: string): Promise<readonly Entry[]> {
    return (await this.sync(this.writer, uuid(workstream))).entries
  }
  /** docs/specs/log.md, "Native sub-agents": the Workstream whose log holds a native sub-stream's lines, or null for any other. */
  async hostOf(workstream: string): Promise<string | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workstream)) return null
    const found = await this.writer.query('SELECT host FROM workstreams WHERE id=$1', [workstream])
    return (found.rows[0]?.host as string | null | undefined) ?? null
  }
  async state(workstream: string): Promise<State> {
    return (await this.sync(this.writer, uuid(workstream))).state
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
        const effect = await decide(tx.state, tx)
        if (typeof effect === 'string') return { accepted: false, reason: effect }
        const position = await tx.append({
          kind: 'command',
          content: {
            ...command,
            body: effect.body ?? command.body,
            ...(effect.execution ? { execution: effect.execution } : {}),
            ...(effect.claimName ? { claimName: effect.claimName } : {}),
            ...(effect.waits ? { waits: true } : {}),
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
          ...(effect.waits ? { waiting: true as const } : {}),
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
        if (effect.message && effect.execution) await this.first(tx, effect.execution, effect.message)
        return answer
      })
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return { accepted: false, reason: 'execution_conflict' }
      // docs/specs/files.md, "Storing": R2 failing refuses the command, and nothing is written.
      if (error instanceof Error && error.message === 'files_unavailable') return { accepted: false, reason: 'files_unavailable' }
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
  /**
   * Captures one received line (docs/specs/log.md, "Backpressure and shutdown"): its connection and
   * receive ordinal identify it, so a retry after an ambiguous commit finds the first write.
   */
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
      const state = tx.state
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
        const diagnostic = randomUUID()
        await tx.client.query(
          'INSERT INTO diagnostics(id,workstream,execution,connection,receive_ordinal,direction,reason,size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            diagnostic,
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
        if (request && !state.answers.has(request.position))
          await tx.append({
            kind: 'request.failed',
            execution,
            session: request.session,
            content: { requestPosition: request.position, reason: result.reason, diagnostic },
          })
        return { handled: false, reason: result.reason }
      }
      const envelope = result.envelope
      const previousAnswer = request
        ? tx.entries.find(
            (e) =>
              e.kind === 'acp' &&
              e.direction === 'in' &&
              e.request_position === request.position &&
              ['response', 'error'].includes(e.rpc_kind ?? ''),
          )
        : undefined
      let session = previousAnswer
        ? previousAnswer.session
        : request
          ? request.session
          : (state.executions.get(execution)?.session ?? null)
      const target = state.executions.get(execution)
      const params = object(request?.content.params),
        response = object(envelope.value.result)
      const opens =
        envelope.kind === 'response' &&
        request &&
        !state.answers.has(request.position) &&
        !target?.ended &&
        !target?.lost &&
        !target?.failed &&
        ['session/new', 'session/resume', 'session/load'].includes(request.method!)
      const acpId = opens ? (request!.method === 'session/new' ? response?.sessionId : params?.sessionId) : null
      if (opens && typeof acpId === 'string') session = randomUUID()
      // docs/specs/log.md, "Native sub-agents": a sub-agent announced gets its Workstream in the transaction that writes
      // its line — a sub-stream of the one that announced it, its lines in this log.
      const announced = announcement(state, target, envelope.value)
      if (announced?.listed)
        await tx.client.query(
          'INSERT INTO workstreams(id,owner,parent,root,depth,host) SELECT $1, p.owner, p.id, coalesce(p.root,p.id), p.depth+1, $3 FROM workstreams p WHERE p.id=$2 ON CONFLICT DO NOTHING',
          [childWorkstream(workstream, announced.acpId), announced.parent, workstream],
        )
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
        const body = target?.body ?? {}
        const opened = await tx.append({
          kind: 'session.opened',
          execution,
          session,
          content: {
            acpId,
            responsePosition: position,
            pool: body.pool ?? null,
            harness: body.harness ?? null,
            origin: request!.method === 'session/new' ? 'new' : (body.anchor ?? 'new'),
            // The exchanges its first prompt will give (docs/specs/log.md, "Continuing").
            ...(Array.isArray(object(body.catchUp)?.turns)
              ? { catchUp: (object(body.catchUp)!.turns as unknown[]).length, omitted: object(body.catchUp)!.omitted ?? 0 }
              : {}),
          },
        })
        await tx.client.query(
          'INSERT INTO sessions(id,workstream,execution,acp_id,opened_position) VALUES($1,$2,$3,$4,$5)',
          [session, workstream, execution, acpId, opened],
        )
      }
      return { handled: true, position }
    })
  }
  /**
   * A Create's message (docs/specs/log.md, "Commands"): a Write that waits, in the Create's commit, at the next
   * position, marked `first` with the execution it starts.
   */
  private async first(tx: Transaction, execution: string, message: { id: string; prompt: unknown }): Promise<void> {
    const write = { id: message.id, kind: 'Write', target: {}, body: { prompt: message.prompt, mayWait: true } }
    const position = await tx.append({ kind: 'command', content: { ...write, waits: true, first: execution }, command: write.id })
    await tx.client.query(
      'INSERT INTO commands(workstream,id,kind,target,fingerprint,answer,position) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)',
      [tx.workstream, write.id, write.kind, encode(write.target), hash({ kind: write.kind, target: write.target, body: write.body }), encode({ accepted: true, command: write.id, position, waiting: true }), position],
    )
  }
  /** Appends a lifecycle entry; one that ends an execution also ends its open Sessions. */
  async fact(workstream: string, input: Append): Promise<string> {
    return this.transaction(workstream, async (tx) => {
      const position = await tx.append(input)
      if (['execution.ended', 'execution.lost', 'execution.failed'].includes(input.kind) && input.execution)
        await tx.endSessions(input.execution, object(input.content)?.reason ?? 'stopped')
      return position
    })
  }
  /**
   * Stores an anchor with the anchor role; `publishAnchors` then appends its entry. The Workstream keeps its
   * last anchor per harness (docs/specs/log.md, "Storage"): one stored removes the earlier ones of its harness.
   */
  async storeAnchor(input: {
    id: string
    workstream: string
    execution: string
    session: string | null
    metadata: unknown
    bytes: Uint8Array
  }): Promise<void> {
    // docs/specs/files.md, "References": the anchor's bytes are a file in R2; its record names the object.
    if (!this.files) throw new Error('files_unavailable')
    const bytes = Buffer.from(input.bytes)
    const file = digest(bytes)
    const client = await this.anchors.connect()
    let broken = false
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await this.files.keep(client, new Map([[file, bytes]]))
      await client.query(
        `WITH stored AS (
           INSERT INTO anchors(id,workstream,execution,session,metadata,file) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING
           RETURNING id, workstream, metadata->>'harness' AS harness
         )
         DELETE FROM anchors a USING stored s WHERE a.workstream=s.workstream AND a.id<>s.id AND a.metadata->>'harness' IS NOT DISTINCT FROM s.harness`,
        [uuid(input.id), input.workstream, input.execution, input.session, encode(input.metadata), file],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => (broken = true))
      throw error
    } finally {
      client.release(broken)
    }
  }
  /** Appends `anchor.received` for every stored anchor still without one (docs/specs/log.md). */
  async publishAnchors(workstream: string): Promise<void> {
    await this.transaction(workstream, async (tx) => {
      const known = new Set(tx.entries.filter((e) => e.kind === 'anchor.received').map((e) => e.content.id))
      const rows = await tx.client.query(
        'SELECT id,execution,session,metadata::text FROM anchors WHERE workstream=$1 ORDER BY id',
        [workstream],
      )
      for (const r of rows.rows)
        if (!known.has(r.id))
          await tx.append({
            kind: 'anchor.received',
            execution: r.execution,
            session: r.session,
            content: { id: r.id, metadata: decode(r.metadata) },
          })
    })
  }
  /** An anchor's metadata and bytes, read from R2 — or from its record, for one stored before its bytes moved. */
  async anchorBytes(id: string): Promise<{ metadata: Record<string, unknown>; content: Buffer } | null> {
    const result = await this.anchors.query('SELECT metadata::text,file,content FROM anchors WHERE id=$1', [uuid(id)])
    if (!result.rowCount) return null
    const r = result.rows[0]
    if (r.file === null) return { metadata: object(decode(r.metadata)) ?? {}, content: r.content as Buffer }
    if (!this.files) throw new Error('files_unavailable')
    return { metadata: object(decode(r.metadata)) ?? {}, content: await this.files.get(r.file as string) }
  }
  /** An anchor's metadata alone: what a resume names, without its bytes. */
  async anchorMetadata(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.anchors.query('SELECT metadata::text FROM anchors WHERE id=$1', [uuid(id)])
    return result.rowCount ? (object(decode(result.rows[0].metadata)) ?? {}) : null
  }
  /** An entry's content with its files given back (docs/specs/files.md, "References", "Expanding"). */
  async expand(entry: Entry): Promise<Record<string, unknown>> {
    if (!entry.files?.length) return entry.content
    if (!this.files) throw new Error('files_unavailable')
    const bytes = new Map<string, Buffer>()
    for (const sha256 of new Set(entry.files.map((f) => f.sha256))) bytes.set(sha256, await this.files.get(sha256))
    return expandFiles(entry.content, entry.files, bytes) as Record<string, unknown>
  }
  /** Whether an entry of a Workstream of one of these owners names the file (docs/specs/files.md, "Reading a file"). */
  async readable(sha256: string, owners: readonly string[]): Promise<boolean> {
    const result = await this.writer.query(
      `SELECT 1 FROM entries e JOIN workstreams w ON w.id = e.workstream
       WHERE e.files IS NOT NULL AND e.files @> jsonb_build_array(jsonb_build_object('sha256', $1::text)) AND w.owner = ANY($2::uuid[]) LIMIT 1`,
      [sha256, owners],
    )
    return result.rowCount === 1
  }
  /** The sweep (docs/specs/files.md, "The sweep"), with the anchor role. */
  async sweep(ageMs?: number): Promise<{ rows: number; orphans: number } | null> {
    if (!this.files) throw new Error('files_unavailable')
    return this.files.sweep(this.anchors, ageMs)
  }
  async anchorList(): Promise<{ id: string; workstream: string; execution: string; metadata: unknown }[]> {
    const result = await this.writer.query(
      'SELECT id,workstream,execution,metadata::text FROM anchors ORDER BY time DESC, id LIMIT 200',
    )
    return result.rows.map((r) => ({ id: r.id, workstream: r.workstream, execution: r.execution, metadata: decode(r.metadata) }))
  }
}
