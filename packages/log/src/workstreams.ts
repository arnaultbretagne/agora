// Workstreams (docs/specs/log.md): commands, the journal, every dispatch and every capture, recovery and
// the views. The execution mechanics are the ExecutionManager's; this decides, writes first, then
// asks it to act. One dispatcher per Workstream: everything that decides runs in `serial`.
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import {
  claimName,
  EXECUTION_LABEL,
  LIMIT_BOUNDS,
  MANAGED_BY,
  MANAGER,
  POOL_LABEL,
  TERMINAL_CLAIM_REASONS,
  type Claim,
  type CommandResult,
  type CredentialSource,
  type ExecutionManager,
  type Handler,
  type Limits,
  type PodIdentity,
  type Target,
} from '@agora/executions'
import type { Credentials, OutboundView } from '@agora/harness-bridge/outbound'
import type { Bundle } from '@agora/harness-bridge/anchor'
import { type LogStore, type Answer, type Command, type Entry } from './store.ts'
import type { Execution, State } from './state.ts'
import { core, Projections } from './projection.ts'
import { decode, encode, identity, object, schemaValue, uuid } from './json.ts'
import { idKey, type Reason } from './acp.ts'
import { telemetry } from './telemetry.ts'
import { configuring, nextOpening, offers, ownSettings, resolveSettings, settled } from './settings.ts'
import { anchorsOf, catchUpBlock, catchUpText, exchangesOf, isCatchUp, lacking, lastAnchor, type CatchUp } from './catch-up.ts'
import { compileProfile, offers as offersProfile } from '@agora/credentials'

const LOCK = 194710501
const QUOTA_LOCK = LOCK + 1
const OPENING = ['session/new', 'session/resume', 'session/load']
const CONTROL = new Set(['session/set_config_option'])
/** A burst of received lines is projected a few times a second, never once per line. */
const PROJECT_EVERY_MS = 250

/** Where a test may stop the process (docs/reliability/README.md, rule 4). */
export type FaultPoint = 'before_marker' | 'after_marker' | 'after_write' | 'before_claim' | 'after_claim' | 'after_anchor'

export interface WorkstreamsOptions {
  readonly store: LogStore
  readonly executions: ExecutionManager
  readonly defaults: Limits
  readonly maxActive: number
  readonly renewSeconds: number
  readonly tickMs?: number
  readonly responseTimeoutMs?: number
  readonly shutdownMs?: number
  readonly sink?: (line: string) => void
  /** Signs the executions' tokens (docs/specs/credentials.md); without it, no execution has a way out. */
  readonly credentials?: CredentialSource
  /** The database ownership connection failed (docs/specs/log.md, "Database ownership"). Default: exit. */
  readonly onOwnershipLost?: () => void
  /** Called at each fault point with what is at stake there; a test stops the process, or holds it, there. */
  readonly fault?: (point: FaultPoint, detail: { readonly position?: string; readonly method?: string | null }) => void | Promise<void>
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** A set of profiles, as the tokens map compares them. */
const key = (profiles: readonly string[]): string => [...profiles].sort().join(',')

function limitsOf(e: Execution): Limits {
  const limits = object(e.body.limits) ?? {}
  return { leaseSeconds: Number(schemaValue(limits.leaseSeconds)), turnCapSeconds: Number(schemaValue(limits.turnCapSeconds)) }
}

export class Workstreams implements Handler {
  readonly options: WorkstreamsOptions
  readonly projections: Projections
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly owners = new Map<string, string>()
  private readonly blocked = new Set<string>()
  /**
   * Each execution's token, as handed by this process: when it runs out, and the profiles it names
   * (sorted, joined), or null when not known — after a restart.
   */
  private readonly tokens = new Map<string, { until: number; profiles: string | null }>()
  /** The Workstreams whose execution has not ended: the clock visits these only. */
  private readonly live = new Set<string>()
  /** Projections asked by received lines, per Workstream: at most one every PROJECT_EVERY_MS. */
  private readonly projecting = new Map<string, NodeJS.Timeout>()
  private readonly projected = new Map<string, number>()
  private owner: pg.Client | null = null
  private stopped = true
  private halted = false
  private timer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(options: WorkstreamsOptions) {
    this.options = options
    this.projections = new Projections(options.store)
  }

  private get store(): LogStore {
    return this.options.store
  }
  private get executions(): ExecutionManager {
    return this.options.executions
  }
  private report(fields: Record<string, unknown>): void {
    telemetry(fields, this.options.sink ?? (() => {}))
  }

  /** One dispatcher per Workstream: decisions and effects run one after the other. */
  private serial<T>(workstream: string, run: () => Promise<T>): Promise<T> {
    const preceding = this.queues.get(workstream) ?? Promise.resolve()
    const next = preceding.catch(() => {}).then(run)
    this.queues.set(workstream, next)
    void next
      .finally(() => {
        if (this.queues.get(workstream) === next) this.queues.delete(workstream)
      })
      .catch(() => {})
    return next
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (!this.stopped) throw new Error('already_started')
    await this.store.assertBoundaries()
    // A half-open socket must not hold the clock: the check times out, and a timeout is a loss.
    const owner = new pg.Client({ connectionString: this.store.urls.writer, application_name: 'agora-owner', keepAlive: true, query_timeout: 10_000 })
    owner.on('error', () => this.ownershipLost())
    await owner.connect()
    const locked = await owner.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK])
    if (!locked.rows[0].locked) {
      await owner.end().catch(() => {})
      throw new Error('dispatch_owner_exists')
    }
    this.owner = owner
    this.stopped = false
    for (const row of (await this.store.writer.query("SELECT workstream,execution FROM commands WHERE kind='Create'")).rows)
      this.owners.set(row.execution as string, row.workstream as string)
    // Only what is followed is read back: an execution not ended, an anchor without its entry.
    for (const workstream of await this.store.pending()) {
      const state = await this.store.state(workstream)
      // docs/specs/log.md, "Backpressure and shutdown": a connection left without a break broke uncleanly.
      for (const e of state.executions.values())
        if (e.connection)
          await this.store.fact(workstream, { kind: 'execution.break', execution: e.id, content: { connection: e.connection, clean: false } })
      await this.store.publishAnchors(workstream)
      for (const e of state.executions.values()) if (!e.ended) await this.follow(workstream, e)
    }
    await this.executions.start(this)
    for (const workstream of new Set([...this.live, ...(await this.store.behind(core.version))])) await this.serial(workstream, () => this.project(workstream))
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 1000)
  }

  /** A clean stop: no new dispatch, connections drained, breaks written, then the lock released. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    for (const timer of this.projecting.values()) clearTimeout(timer)
    this.projecting.clear()
    await this.executions.drain(this.options.shutdownMs ?? 5000)
    await Promise.allSettled([...this.queues.values()])
    await this.executions.stop()
    if (this.owner !== null) {
      await this.owner.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {})
      await this.owner.end().catch(() => {})
      this.owner = null
    }
  }

  /** Dies on the spot, as a killed process would: nothing more is written. For tests. */
  halt(): void {
    this.halted = true
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    for (const timer of this.projecting.values()) clearTimeout(timer)
    this.projecting.clear()
    void this.executions.stop()
    if (this.owner !== null) {
      // As a dead process: the connection drops, and PostgreSQL releases the lock with it.
      const socket = (this.owner as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream
      socket?.destroy()
      this.owner = null
    }
  }

  private ownershipLost(): void {
    if (this.halted) return
    this.report({ operation: 'recover', outcome: 'failed', errorClass: 'database' })
    this.halt()
    ;(this.options.onOwnershipLost ?? (() => process.exit(1)))()
  }

  private async follow(workstream: string, e: Execution): Promise<void> {
    this.owners.set(e.id, workstream)
    this.live.add(workstream)
    await this.executions.run(this.target(e))
    if (e.lost || e.failed) this.executions.hold(e.id)
  }

  private target(e: Execution): Target {
    return { execution: e.id, claimName: e.claimName, pool: String(e.body.pool) }
  }

  private workstreamOf(execution: string): string | undefined {
    const workstream = this.owners.get(execution)
    return workstream === '' ? undefined : workstream
  }

  // ---------------------------------------------------------------- commands

  async command(workstream: string, command: Command): Promise<Answer> {
    if (this.stopped) return { accepted: false, reason: 'unavailable' }
    // docs/specs/log.md, "Commands": the catalogue is read before the transaction, never under its lock.
    const catalogue = command.kind === 'Create' ? await this.executions.pools() : []
    return this.serial(workstream, async () => {
      if (this.blocked.has(workstream)) return { accepted: false, reason: 'unavailable' }
      const answer = await this.store.accept(workstream, command, async (state, tx) => {
        const current = state.current
        if (command.kind === 'Create') {
          if (current && !current.ended) return 'execution_active'
          const pool = catalogue.find((p) => p.name === command.body.pool)
          if (!pool) return 'unknown_pool'
          const requested = object(command.body.limits) ?? {}
          const limits: Record<string, number> = { ...this.options.defaults }
          for (const key of Object.keys(LIMIT_BOUNDS) as (keyof Limits)[]) {
            const raw = schemaValue(requested[key])
            if (raw === undefined || raw === null) continue
            const [min, max] = LIMIT_BOUNDS[key]
            if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) return 'invalid_create'
            limits[key] = raw
          }
          await tx.client.query('SELECT pg_advisory_xact_lock($1)', [QUOTA_LOCK])
          const active = await tx.client.query(
            "SELECT count(*)::text AS count FROM commands c WHERE c.kind='Create' AND NOT EXISTS(SELECT 1 FROM entries e WHERE e.workstream=c.workstream AND e.execution=c.execution AND e.kind='execution.ended')",
          )
          if (BigInt(active.rows[0].count) >= BigInt(this.options.maxActive)) return 'quota'
          // docs/specs/log.md, "Commands": the opening settings, the pool's under the Create's own.
          const own = ownSettings(command.body.settings)
          if (own === null) return 'invalid_create'
          const settings = resolveSettings(pool.sessionConfig, own)
          const profiles = this.checkProfiles(command.body.profiles === undefined ? [] : command.body.profiles)
          if (profiles === 'invalid') return 'invalid_create'
          if (typeof profiles === 'string') return profiles
          // docs/specs/log.md, "Continuing": the anchor given, else the Workstream's last of this harness;
          // then the exchanges it does not hold, chosen now and given with the execution's first prompt.
          const anchors = anchorsOf(tx.entries, state)
          let anchor: string | undefined
          if (command.body.anchor !== undefined) {
            anchor = uuid(command.body.anchor)
            const found = await tx.client.query('SELECT metadata::text FROM anchors WHERE id=$1', [anchor])
            if (!found.rowCount) return 'unknown_anchor'
            const metadata = object(decode(found.rows[0].metadata))
            if (metadata?.harness !== pool.harness || typeof metadata.sessionId !== 'string') return 'anchor_incompatible'
          } else anchor = lastAnchor(anchors, state, pool.harness) ?? undefined
          const catchUp = catchUpText(exchangesOf(tx.entries, lacking(anchors, state, anchor ?? null)), anchor !== undefined)
          const execution = randomUUID()
          return {
            execution,
            claimName: claimName(execution),
            body: {
              pool: pool.name,
              harness: pool.harness,
              limits,
              deadline: iso(Date.now() + limits.leaseSeconds! * 1000),
              ...(profiles.length > 0 ? { profiles } : {}),
              ...(anchor ? { anchor } : {}),
              catchUp: { turns: catchUp.turns, omitted: catchUp.omitted },
              ...(settings.length > 0 ? { settings } : {}),
              execution,
            },
          }
        }
        if (!current || current.ended) return 'execution_unavailable'
        if (command.target.execution !== current.id) return 'stale_execution'
        if (command.kind === 'Stop') return current.stopped ? 'stopped' : { execution: current.id, session: current.session ?? undefined }
        if (current.lost || current.failed) return 'execution_unavailable'
        if (current.stopped) return 'stopped'
        if (command.kind === 'Write') {
          if (!current.connection || this.executions.connectionOf(current.id) !== current.connection) return 'disconnected'
          if (this.ending(current)) return 'execution_ending'
          if (state.active) return state.active.status === 'uncertain' ? 'turn_uncertain' : 'turn_active'
          if (!current.session || command.target.session !== current.session) return 'stale_session'
          if (this.opening(state, current)) return 'opening_session'
          if (state.permissions.size) return 'permission_pending'
          if (!settled(state, current)) return 'settings_pending'
          const catchUp = this.catchUpFor(tx.entries, state, current, command.body.prompt)
          const prompt = catchUp ? [catchUpBlock(catchUp), ...(command.body.prompt as unknown[])] : command.body.prompt
          return {
            execution: current.id,
            session: current.session,
            line: { method: 'session/prompt', params: { sessionId: current.acpId, prompt } },
          }
        }
        if (command.kind === 'Configure') {
          if (!current.connection || this.executions.connectionOf(current.id) !== current.connection) return 'disconnected'
          if (this.ending(current)) return 'execution_ending'
          if (state.active) return state.active.status === 'uncertain' ? 'turn_uncertain' : 'turn_active'
          if (!current.session || command.target.session !== current.session) return 'stale_session'
          if (this.opening(state, current)) return 'opening_session'
          if (state.permissions.size) return 'permission_pending'
          if (!settled(state, current)) return 'settings_pending'
          if (typeof command.body.configId !== 'string' || !offers(current, command.body.configId, command.body.value)) return 'unknown_setting'
          return {
            execution: current.id,
            session: current.session,
            line: { method: 'session/set_config_option', params: { sessionId: current.acpId, configId: command.body.configId, value: command.body.value } },
          }
        }
        if (command.kind === 'Scope') {
          // docs/specs/log.md, "Commands": between turns; the token follows once accepted.
          if (state.active) return state.active.status === 'uncertain' ? 'turn_uncertain' : 'turn_active'
          const profiles = this.checkProfiles(command.body.profiles)
          if (profiles === 'invalid') return 'invalid_scope'
          if (typeof profiles === 'string') return profiles
          return { execution: current.id, body: { profiles } }
        }
        if (command.kind === 'Cancel') {
          if (!state.active || !['in_progress', 'uncertain'].includes(state.active.status) || command.target.turn !== state.active.id)
            return 'stale_turn'
          return {
            execution: current.id,
            session: state.active.session ?? undefined,
            line: { method: 'session/cancel', params: { sessionId: current.acpId } },
          }
        }
        const permission = state.permissions.get(`in:${idKey(command.body.requestId)}`)
        if (
          !permission ||
          permission.execution !== current.id ||
          permission.session !== current.session ||
          command.target.session !== permission.session ||
          command.target.requestPosition !== permission.position
        )
          return 'stale_permission'
        const outcome = object(command.body.outcome),
          options = object(permission.content.params)?.options
        if (outcome?.outcome === 'selected' && (!Array.isArray(options) || !options.some((o) => object(o)?.optionId === outcome.optionId)))
          return 'invalid_permission_option'
        return {
          execution: current.id,
          session: permission.session ?? undefined,
          line: { id: permission.rpc_id, result: { outcome: command.body.outcome } },
        }
      })
      this.report({ operation: 'admission', outcome: answer.accepted ? 'accepted' : 'refused', workstream, command: command.id })
      if (answer.accepted) {
        if (command.kind === 'Create' && answer.execution) {
          // A replayed Create answers as the first did; an execution that has ended is not run again.
          const e = (await this.store.state(workstream)).executions.get(answer.execution)
          if (e && !e.ended) await this.follow(workstream, e)
        }
        if (command.kind === 'Scope') await this.rescope(workstream)
        // Acceptance stands whatever the effects do next; their failures are read in the thread.
        await this.drive(workstream).catch(() => this.report({ operation: 'dispatch', outcome: 'blocked', workstream, errorClass: 'unknown' }))
      }
      await this.project(workstream)
      return answer
    })
  }

  /**
   * The catch-up a Write carries (docs/specs/log.md, "Continuing"): the exchanges its Create chose, until
   * a prompt of the execution carrying them has been dispatched. A command (`/…`) never carries it: the
   * agent would no longer see it as a command.
   */
  private catchUpFor(entries: readonly Entry[], state: State, e: Execution, prompt: unknown): CatchUp | null {
    const recorded = object(e.body.catchUp)
    const turns = Array.isArray(recorded?.turns) ? recorded.turns.map(String) : []
    if (turns.length === 0 || !Array.isArray(prompt)) return null
    const first = prompt.map((b) => object(b)).find((b) => b?.type === 'text')
    if (typeof first?.text === 'string' && first.text.trimStart().startsWith('/')) return null
    const carried = (x: Entry) => {
      const blocks = object(x.content.params)?.prompt
      return Array.isArray(blocks) && blocks.some(isCatchUp)
    }
    if (entries.some((x) => x.execution === e.id && x.kind === 'acp' && x.direction === 'out' && x.method === 'session/prompt' && state.attempts.has(x.position) && carried(x)))
      return null
    return catchUpText(exchangesOf(entries, turns), e.body.anchor !== undefined, Number(schemaValue(recorded!.omitted)) || 0)
  }

  /** A Create's or a Scope's profiles, checked (docs/specs/credentials.md, "Offered profiles"): each once, or the refusal. */
  private checkProfiles(value: unknown): string[] | 'invalid' | 'unknown_profile' | 'profile_not_offered' {
    if (!Array.isArray(value) || value.some((p) => typeof p !== 'string')) return 'invalid'
    const profiles = [...new Set(value as string[])]
    try {
      for (const profile of profiles) compileProfile(profile)
    } catch {
      return 'unknown_profile'
    }
    const offered = this.options.credentials?.offered ?? []
    if (offered.length > 0 && profiles.some((p) => !offersProfile(offered, p))) return 'profile_not_offered'
    return profiles
  }

  /**
   * The catalogue (docs/specs/log.md, "HTTP"), each pool with the settings and commands its last
   * Session gave, else its harness's last: what a draft offers before it has a Session of its own.
   */
  async catalogue(): Promise<Record<string, unknown>[]> {
    const [pools, views] = await Promise.all([this.executions.pools(), this.projections.views()])
    const latest = (of: (v: (typeof views)[number]) => boolean) =>
      views
        .filter((v) => of(v) && v.settings !== null && v.settings !== undefined)
        .sort((a, b) => String(b.changedAt ?? '').localeCompare(String(a.changedAt ?? '')))[0]
    return pools.map((p) => {
      // A pool no Session has opened in yet, as a harness's newer image is: its harness's last one.
      const last = latest((v) => v.pool === p.name) ?? latest((v) => v.harness === p.harness)
      return { ...p, settings: last?.settings ?? null, commands: last?.commands ?? [] }
    })
  }

  /** The lab's configuration line (docs/specs/log.md, "HTTP"): one allowed method, between turns. */
  async control(workstream: string, execution: string, method: string, params: Record<string, unknown>): Promise<string> {
    if (!CONTROL.has(method)) throw new Error('control_refused')
    return this.serial(workstream, async () => {
      const state = await this.store.state(workstream),
        e = state.current
      if (this.stopped || !e || e.id !== execution || e.stopped || e.ended || e.lost || e.failed || !e.session || state.active)
        throw new Error('control_refused')
      const line = await this.store.transaction(workstream, (tx) =>
        tx.outgoing(e.id, { method, params: { ...params, sessionId: e.acpId } }, e.session ?? undefined),
      )
      await this.drive(workstream)
      await this.project(workstream)
      return String(line.id)
    })
  }

  /** The execution's Pod address, which its tokens are bound to. */
  podAddress(execution: string): Promise<string> {
    return this.executions.podAddress(execution)
  }

  async attachCredentials(workstream: string, execution: string, credentials: Credentials): Promise<OutboundView> {
    return this.serial(workstream, async () => {
      const e = (await this.store.state(workstream)).current
      if (!e || e.id !== execution || e.ended || e.lost || e.failed) throw new Error('execution_unavailable')
      const view = await this.executions.putCredentials(e.id, credentials)
      // A test token stands for the execution's own profiles until it runs out or a Scope changes them.
      this.tokens.set(e.id, { until: Date.parse(credentials.expiresAt ?? '') || 0, profiles: key(await this.profilesOf(e)) })
      return view
    })
  }

  // ---------------------------------------------------------------- the execution's life

  private ending(e: Execution): boolean {
    const claim = this.executions.claimOf(e.id)
    const shutdown = Date.parse(claim?.spec?.lifecycle?.shutdownTime ?? String(e.body.deadline))
    return claim?.metadata.deletionTimestamp !== undefined || shutdown <= Date.now()
  }

  private opening(state: State, e: Execution): boolean {
    return [...state.unanswered].some((position) => {
      const r = state.requestPositions.get(position)
      return r?.execution === e.id && OPENING.includes(r.method ?? '') && !state.failures.has(position)
    })
  }

  /** docs/specs/log.md, "An execution's memory": the claim against the record. */
  private async reconcile(workstream: string): Promise<void> {
    const state = await this.store.state(workstream)
    const e = state.current
    if (!e || e.ended) return
    const claim = this.executions.claimOf(e.id)
    if (claim === null) {
      if (e.uid || e.lost || e.failed || e.stopped) return this.end(workstream, e, 'claim_missing')
      if (Date.parse(String(e.body.deadline)) <= Date.now()) {
        await this.store.fact(workstream, { kind: 'execution.failed', execution: e.id, content: { reason: 'startup_failed' } })
        return this.end(workstream, e, 'claim_missing')
      }
      try {
        await this.options.fault?.('before_claim', {})
        await this.executions.createClaim(this.target(e), String(e.body.deadline))
        await this.options.fault?.('after_claim', {})
      } catch {
        this.report({ operation: 'recover', outcome: 'blocked', workstream, execution: e.id, errorClass: 'transport' })
      }
      return
    }
    const labels = claim.metadata.labels ?? {}
    if (
      labels[EXECUTION_LABEL] !== e.id ||
      labels[MANAGED_BY] !== MANAGER ||
      labels[POOL_LABEL] !== e.body.pool ||
      claim.metadata.name !== e.claimName ||
      (e.uid && e.uid !== claim.metadata.uid)
    ) {
      if (!e.lost) await this.store.fact(workstream, { kind: 'execution.lost', execution: e.id, content: { reason: 'claim_conflict' } })
      this.executions.hold(e.id)
      return
    }
    if (!e.uid)
      await this.store.fact(workstream, { kind: 'execution.obtained', execution: e.id, content: { uid: claim.metadata.uid, claimName: claim.metadata.name } })
    if (e.lost || e.failed) {
      this.executions.hold(e.id)
      return
    }
    // An ending claim: nothing more is dispatched, and the open connection is left to the Pod's end,
    // so that what the harness still writes is captured.
    if (this.ending(e)) return
    const ready = claim.status?.conditions?.find((c) => c.type === 'Ready')
    if (ready?.status !== 'True' && TERMINAL_CLAIM_REASONS.has(ready?.reason ?? '')) {
      await this.store.fact(workstream, { kind: 'execution.failed', execution: e.id, content: { reason: 'startup_failed' } })
      this.executions.hold(e.id)
      return
    }
    await this.drive(workstream)
  }

  private async end(workstream: string, e: Execution, reason: Reason): Promise<void> {
    const anchor = (await this.store.entries(workstream)).findLast((x) => x.kind === 'anchor.received' && x.execution === e.id)
    await this.store.fact(workstream, { kind: 'execution.ended', execution: e.id, content: { reason, anchor: anchor?.content.id ?? null } })
    this.executions.release(e.id)
    this.live.delete(workstream)
    this.tokens.delete(e.id)
    // Its views are written; what it needs again is read back from PostgreSQL.
    await this.project(workstream)
    this.store.forget(workstream)
    this.projections.forget(workstream)
  }

  private async fail(workstream: string, entry: Entry, reason: Reason): Promise<void> {
    await this.store.fact(workstream, {
      kind: 'request.failed',
      execution: entry.execution,
      session: entry.session,
      content: { requestPosition: entry.position, reason },
    })
  }

  /** Writes what the execution needs next, then dispatches what was never attempted, in order. */
  private async drive(workstream: string): Promise<void> {
    if (this.stopped || this.blocked.has(workstream)) return
    let state = await this.store.state(workstream)
    const e = state.current
    if (!e || e.ended || e.lost || e.failed) return
    const connection = this.executions.connectionOf(e.id)
    if (connection === null || connection !== e.connection) return
    // docs/specs/log.md, "An execution's memory": an ending claim stops every dispatch.
    if (this.ending(e)) return
    if (!e.stopped) await this.setup(workstream, e)
    state = await this.store.state(workstream)
    const current = state.executions.get(e.id)!
    if (current.lost || current.failed) return
    // Stop cancels the turn in progress, once; it never makes up its end.
    if (current.stopped && state.active && ['in_progress', 'uncertain'].includes(state.active.status)) {
      const stop = (await this.store.entries(workstream)).findLast((x) => x.kind === 'command' && x.execution === e.id && x.content.kind === 'Stop')
      const sent = (await this.store.entries(workstream)).some((x) => x.kind === 'acp' && x.method === 'session/cancel' && x.command === stop?.command)
      if (stop && !sent)
        await this.store.transaction(workstream, (tx) =>
          tx.outgoing(e.id, { method: 'session/cancel', params: { sessionId: current.acpId } }, current.session ?? undefined, stop.command ?? undefined),
        )
      state = await this.store.state(workstream)
    }
    for (const entry of [...state.outbox.values()]) {
      if (entry.execution !== e.id) continue
      if (state.attempts.has(entry.position) || state.failures.has(entry.position)) continue
      const latest = (await this.store.state(workstream)).executions.get(e.id)!
      if (latest.stopped && entry.method !== 'session/cancel' && entry.rpc_kind !== 'response') {
        await this.fail(workstream, entry, 'stopped')
        continue
      }
      if (entry.method !== 'initialize' && !latest.initialized) continue
      if (entry.method === 'session/prompt' && !latest.session) continue
      if (entry.method === 'session/prompt') {
        // The token must last the whole turn (docs/specs/credentials.md, "Between turns").
        if (!(await this.ensureToken(e))) {
          await this.fail(workstream, entry, 'credentials_refused')
          continue
        }
        const { leaseSeconds, turnCapSeconds } = limitsOf(e)
        const until = Math.min(Date.now() + leaseSeconds * 1000, Date.parse(entry.time) + turnCapSeconds * 1000)
        if (until <= Date.now() || !latest.uid) {
          await this.fail(workstream, entry, 'deadline_refused')
          continue
        }
        try {
          await this.executions.renew(e.id, latest.uid, iso(until))
        } catch {
          await this.fail(workstream, entry, 'deadline_refused')
          continue
        }
      }
      const sent = await this.dispatch(workstream, entry, connection)
      state = await this.store.state(workstream)
      if (sent && entry.method === 'session/cancel') await this.cancelPermissions(workstream, e.id, connection)
    }
  }

  /** ACP: once `session/cancel` is sent, every pending permission of the execution is answered `cancelled`. */
  private async cancelPermissions(workstream: string, execution: string, connection: string): Promise<void> {
    const state = await this.store.state(workstream)
    for (const permission of [...state.permissions.values()]) {
      if (permission.execution !== execution) continue
      const line = await this.store.transaction(workstream, (tx) =>
        tx.outgoing(execution, { id: permission.rpc_id, result: { outcome: { outcome: 'cancelled' } } }, permission.session ?? undefined),
      )
      const entry = (await this.store.entries(workstream)).find((x) => x.position === line.position)
      if (entry) await this.dispatch(workstream, entry, connection)
    }
  }

  /** The execution's rights: its pool's base profiles and its own. */
  private async profilesOf(e: Execution): Promise<string[]> {
    const pool = (await this.executions.pools()).find((p) => p.name === e.body.pool)
    return [...new Set([...(pool?.baseProfiles ?? []), ...e.profiles])]
  }

  /**
   * Hands the execution its token, naming it: true once the bridge has it, or when it needs none. With
   * no profile left after one was handed, a token with no grant withdraws it.
   */
  private async handToken(e: Execution): Promise<boolean> {
    const source = this.options.credentials
    const profiles = await this.profilesOf(e)
    const held = this.tokens.get(e.id)
    if (source === undefined || (profiles.length === 0 && (held === undefined || held.profiles === ''))) return true
    const { leaseSeconds, turnCapSeconds } = limitsOf(e)
    try {
      const address = await this.executions.podAddress(e.id)
      const credentials = await source.mint({ label: `agora ${e.id}`, ttlSeconds: turnCapSeconds + leaseSeconds, profiles, address })
      await this.executions.putCredentials(e.id, credentials)
      this.tokens.set(e.id, { until: Date.parse(credentials.expiresAt ?? '') || 0, profiles: key(profiles) })
      return true
    } catch {
      this.report({ operation: 'dispatch', outcome: 'blocked', execution: e.id, errorClass: 'transport' })
      return false
    }
  }

  /**
   * A new token before a prompt if the current one would run out within the turn and a minute, or
   * names other profiles than the execution's.
   */
  private async ensureToken(e: Execution): Promise<boolean> {
    if (this.options.credentials === undefined) return true
    const profiles = key(await this.profilesOf(e))
    let held = this.tokens.get(e.id)
    if (held === undefined) {
      // After a restart: what the bridge holds; which profiles it names is not known, unless none.
      const outbound = (await this.executions.info(e.id).catch(() => null))?.outbound
      held = { until: Date.parse(outbound?.expiresAt ?? '') || 0, profiles: outbound !== undefined && outbound.proxy === null ? '' : null }
      this.tokens.set(e.id, held)
    }
    if (held.profiles === profiles && (profiles === '' || held.until - Date.now() >= (limitsOf(e).turnCapSeconds + 60) * 1000)) return true
    return this.handToken(e)
  }

  /** After a Scope (docs/specs/credentials.md, "On Agora's side"): the new token at once, if the execution has had its first. */
  private async rescope(workstream: string): Promise<void> {
    const state = await this.store.state(workstream)
    const e = state.current
    if (!e || e.ended || e.lost || e.failed || e.stopped || !e.connection || this.executions.connectionOf(e.id) !== e.connection) return
    if (![...state.requests.values()].some((r) => r.execution === e.id && r.direction === 'out' && r.method === 'initialize')) return
    // If it fails, the next prompt hands it, or fails.
    await this.ensureToken(e)
  }

  /** The token, the anchor if any, `initialize`, then the Session: new, or restored (docs/specs/executions.md, "Restoring"). */
  private async setup(workstream: string, e: Execution): Promise<void> {
    const state = await this.store.state(workstream)
    const requests = [...state.requests.values()].filter((r) => r.execution === e.id && r.direction === 'out')
    if (!requests.some((r) => r.method === 'initialize')) {
      // The execution's token first: a harness initializing without a way out stalls.
      if (!(await this.handToken(e))) return
      // Then the anchor, before the adapter speaks: one that opens its files at start is restarted to read them.
      if (e.body.anchor) {
        const anchor = await this.store.anchorBytes(String(e.body.anchor))
        if (!anchor) return this.failSetup(workstream, e, 'anchor_missing')
        try {
          await this.executions.putAnchor(e.id, anchor.content)
        } catch {
          return this.failSetup(workstream, e, 'restore_failed')
        }
      }
      await this.store.transaction(workstream, (tx) =>
        tx.outgoing(e.id, {
          method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'agora', version: '1' } },
        }),
      )
      return
    }
    // docs/specs/log.md, "Sessions": once it opens, its opening settings, one at a time.
    if (e.session) {
      const next = nextOpening(e)
      if (next === null || configuring(state, e)) return
      await this.store.transaction(workstream, (tx) =>
        tx.outgoing(e.id, { method: 'session/set_config_option', params: { sessionId: e.acpId, configId: next.id, value: next.value } }, e.session ?? undefined),
      )
      return
    }
    if (!e.initialized || requests.some((r) => OPENING.includes(r.method ?? ''))) return
    const info = await this.executions.info(e.id)
    if (info.instance !== e.instance) {
      await this.store.fact(workstream, { kind: 'execution.lost', execution: e.id, content: { reason: 'instance_changed' } })
      this.executions.hold(e.id)
      return
    }
    let method = 'session/new'
    let params: Record<string, unknown> = { cwd: info.workspace, mcpServers: [] }
    if (e.body.anchor) {
      const anchor = await this.store.anchorBytes(String(e.body.anchor))
      const initialize = (await this.store.entries(workstream)).find(
        (x) => x.execution === e.id && x.correlated_method === 'initialize' && x.rpc_kind === 'response',
      )
      const caps = object(object(initialize?.content.result)?.agentCapabilities)
      method = object(caps?.sessionCapabilities)?.resume != null ? 'session/resume' : 'session/load'
      if (!anchor) return this.failSetup(workstream, e, 'anchor_missing')
      if (method === 'session/load' && caps?.loadSession !== true) return this.failSetup(workstream, e, 'restore_failed')
      params = { ...params, sessionId: anchor.metadata.sessionId }
    }
    await this.store.transaction(workstream, (tx) => tx.outgoing(e.id, { method, params }))
  }

  private async failSetup(workstream: string, e: Execution, reason: 'anchor_missing' | 'restore_failed'): Promise<void> {
    await this.store.fact(workstream, { kind: 'execution.failed', execution: e.id, content: { reason } })
    this.executions.hold(e.id)
  }

  /**
   * docs/specs/log.md, "Dispatch and recovery": the marker commits before the transport is called, and
   * nothing after it can refuse the write. A failed write is a local failure, not proof of no delivery.
   */
  private async dispatch(workstream: string, entry: Entry, connection: string): Promise<boolean> {
    await this.options.fault?.('before_marker', { position: entry.position, method: entry.method })
    const marked = await this.store.transaction(workstream, async (tx) => {
      const state = tx.state
      const command = tx.entries.find((x) => x.kind === 'command' && x.command === entry.command)
      const staleCancel =
        entry.method === 'session/cancel' &&
        (!state.active ||
          !['in_progress', 'uncertain'].includes(state.active.status) ||
          state.active.session !== entry.session ||
          (command?.content.kind === 'Cancel' && object(command.content.target)?.turn !== state.active.id))
      // An answer goes to that very request occurrence, and only the first answer written for it.
      const permission = entry.request_position ? state.requestPositions.get(entry.request_position) : undefined
      const first = tx.entries.find(
        (x) => x.direction === 'out' && ['response', 'error'].includes(x.rpc_kind ?? '') && x.request_position === entry.request_position,
      )
      const stalePermission =
        entry.correlated_method === 'session/request_permission' &&
        (!permission || first?.position !== entry.position || state.requests.get(`in:${idKey(entry.rpc_id)}`)?.position !== permission.position)
      if (staleCancel || stalePermission) {
        await tx.append({
          kind: 'request.failed',
          execution: entry.execution,
          session: entry.session,
          content: { requestPosition: entry.position, reason: 'stopped' },
        })
        return false
      }
      await tx.append({
        kind: 'acp.dispatching',
        execution: entry.execution,
        session: entry.session,
        content: { requestPosition: entry.position, connection, startedAt: entry.time },
      })
      return true
    })
    if (!marked) return false
    await this.options.fault?.('after_marker', { position: entry.position, method: entry.method })
    try {
      await this.executions.send(entry.execution!, connection, encode(entry.content))
    } catch {
      await this.fail(workstream, entry, 'transport_error')
      return false
    }
    await this.options.fault?.('after_write', { position: entry.position, method: entry.method })
    await this.store.fact(workstream, {
      kind: 'acp.sent',
      execution: entry.execution,
      session: entry.session,
      content: { requestPosition: entry.position, connection },
    })
    return true
  }

  private async project(workstream: string): Promise<void> {
    this.projected.set(workstream, Date.now())
    await this.projections.run(workstream).catch(() => this.report({ operation: 'project', outcome: 'blocked', workstream, errorClass: 'database' }))
  }

  // ---------------------------------------------------------------- the mechanics' events (Handler)

  /** Queued, never awaited: the mechanics may report a claim from inside this Workstream's own dispatcher. */
  async claim(execution: string, _claim: Claim | null): Promise<void> {
    const workstream = this.workstreamOf(execution)
    if (workstream === undefined || this.stopped) return
    void this.serial(workstream, async () => {
      await this.reconcile(workstream)
      await this.project(workstream)
    }).catch(() => this.report({ operation: 'recover', outcome: 'blocked', workstream, execution, errorClass: 'database' }))
  }

  async connected(execution: string, connection: string, instance: string): Promise<boolean> {
    const workstream = this.workstreamOf(execution)
    if (workstream === undefined || this.stopped) return false
    return this.serial(workstream, async () => {
      const e = (await this.store.state(workstream)).executions.get(execution)
      if (!e || e.ended || e.lost || e.failed) return false
      if (e.instance && e.instance !== instance) {
        await this.store.fact(workstream, { kind: 'execution.lost', execution, content: { reason: 'instance_changed' } })
        this.executions.hold(execution)
        await this.project(workstream)
        return false
      }
      await this.store.fact(workstream, { kind: 'execution.connected', execution, content: { connection, instance } })
      void this.serial(workstream, async () => {
        await this.drive(workstream)
        await this.project(workstream)
      }).catch(() => {})
      return true
    })
  }

  async line(execution: string, connection: string, ordinal: bigint, bytes: Buffer): Promise<void> {
    const workstream = this.workstreamOf(execution)
    if (workstream === undefined || this.halted) throw new Error('unknown_execution')
    // docs/specs/log.md, "Backpressure and shutdown": the line is kept and retried until it commits.
    let captured: Awaited<ReturnType<LogStore['incoming']>>
    for (;;) {
      try {
        captured = await this.store.incoming(workstream, execution, connection, String(ordinal), bytes)
        break
      } catch {
        this.blocked.add(workstream)
        this.report({ operation: 'capture', outcome: 'blocked', workstream, execution, connection, errorClass: 'database', bytes: bytes.byteLength })
        const claim = this.executions.claimOf(execution)
        if (this.stopped || Date.parse(claim?.spec?.lifecycle?.shutdownTime ?? '0') <= Date.now()) {
          // Given up: the connection fails, and the Workstream admits commands again.
          this.blocked.delete(workstream)
          throw new Error('capture_abandoned')
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    this.blocked.delete(workstream)
    void this.serial(workstream, () => this.handled(workstream, execution, captured.position)).catch(() =>
      this.report({ operation: 'capture', outcome: 'blocked', workstream, execution, errorClass: 'database' }),
    )
  }

  /** After a line is captured: the end of a turn grants one lease; then dispatch, and project soon. */
  private async handled(workstream: string, execution: string, position: string | undefined): Promise<void> {
    if (this.stopped) return
    const state = await this.store.state(workstream)
    const entry = position === undefined ? undefined : (await this.store.entries(workstream)).findLast((x) => x.position === position)
    const e = state.executions.get(execution)
    if (
      entry?.correlated_method === 'session/prompt' &&
      ['response', 'error'].includes(entry.rpc_kind ?? '') &&
      e &&
      e.uid &&
      !e.stopped &&
      !e.ended &&
      !e.lost &&
      !e.failed &&
      !this.ending(e) &&
      state.answeredBy.get(entry.request_position ?? '') === entry.position
    ) {
      try {
        await this.executions.renew(execution, e.uid, iso(Date.now() + limitsOf(e).leaseSeconds * 1000))
      } catch {
        this.report({ operation: 'renew', outcome: 'failed', workstream, execution, errorClass: 'transport' })
      }
    }
    // After a turn, what went out through the bridge: tunnels, the proxy's answers, in the mechanics' view.
    if (entry?.correlated_method === 'session/prompt' && ['response', 'error'].includes(entry.rpc_kind ?? ''))
      void this.executions.info(execution).catch(() => {})
    await this.drive(workstream)
    this.projectSoon(workstream)
  }

  /** At most one projection every PROJECT_EVERY_MS for received lines; commands project at once. */
  private projectSoon(workstream: string): void {
    if (this.projecting.has(workstream) || this.stopped) return
    const wait = Math.max(0, (this.projected.get(workstream) ?? 0) + PROJECT_EVERY_MS - Date.now())
    this.projecting.set(
      workstream,
      setTimeout(() => {
        this.projecting.delete(workstream)
        void this.serial(workstream, () => this.project(workstream)).catch(() => {})
      }, wait),
    )
  }

  async closed(execution: string, connection: string, code: number | null, drained: boolean): Promise<void> {
    const workstream = this.workstreamOf(execution)
    if (workstream === undefined || this.halted) return
    // The break is retried until written; when stopping, a restart writes it instead (unclean).
    for (;;) {
      try {
        return await this.writeBreak(workstream, execution, connection, code, drained)
      } catch {
        this.report({ operation: 'connect', outcome: 'unclean', workstream, execution, errorClass: 'database' })
        if (this.halted || this.stopped) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }

  private writeBreak(workstream: string, execution: string, connection: string, code: number | null, drained: boolean): Promise<void> {
    return this.serial(workstream, async () => {
      const state = await this.store.state(workstream)
      const entries = await this.store.entries(workstream)
      if (entries.some((x) => x.kind === 'execution.break' && x.content.connection === connection)) return
      const attempts = entries.filter((x) => x.kind === 'acp.dispatching' && x.content.connection === connection)
      const proven = attempts.every((x) => state.sent.has(String(x.content.requestPosition)) || state.answers.has(String(x.content.requestPosition)))
      await this.store.fact(workstream, {
        kind: 'execution.break',
        execution,
        content: { connection, code, clean: drained && proven },
      })
      const e = state.executions.get(execution)
      if (code === 1011 && e && !e.lost && !e.ended) {
        await this.store.fact(workstream, { kind: 'execution.lost', execution, content: { reason: 'adapter_exited' } })
        this.executions.hold(execution)
      }
      await this.project(workstream)
    })
  }

  // ---------------------------------------------------------------- the anchor pushed by the Pod

  async receiveAnchor(pod: PodIdentity, bundle: Bundle, raw: Uint8Array): Promise<CommandResult<{ anchorId: string }>> {
    const matches = await this.executions.claimForPod(pod.podName)
    if (matches.length === 0) return { accepted: false, reason: 'unknown_execution', status: 404 }
    if (matches.length !== 1) return { accepted: false, reason: 'anchor_conflict', status: 409 }
    const { execution, claim } = matches[0]!
    const workstream = this.workstreamOf(execution)
    if (workstream === undefined) return { accepted: false, reason: 'unknown_execution', status: 404 }
    return this.serial(workstream, async () => {
      const e = (await this.store.state(workstream)).executions.get(execution)
      if (
        !e ||
        !e.uid ||
        e.uid !== claim.metadata.uid ||
        claim.metadata.name !== e.claimName ||
        claim.metadata.labels?.[POOL_LABEL] !== e.body.pool ||
        (await this.executions.podUid(pod.podName)) !== pod.podUid ||
        bundle.harness !== e.body.harness
      )
        return { accepted: false as const, reason: 'anchor_conflict', status: 409 }
      if (bundle.files.length === 0) return { accepted: true as const, value: { anchorId: '' } }
      const id = identity(execution, claim.metadata.uid, createHash('sha256').update(raw).digest('hex'), 'anchor')
      await this.store.storeAnchor({
        id,
        workstream,
        execution,
        session: e.session,
        metadata: {
          harness: bundle.harness,
          pool: e.body.pool,
          format: bundle.format,
          sessionId: e.acpId,
          files: bundle.files.map((f) => ({ path: f.path, byteLength: Buffer.from(f.content, 'base64').byteLength })),
          stable: bundle.stable,
          reason: e.stopped ? 'stopped' : 'deadline_reached',
        },
        bytes: raw,
      })
      await this.options.fault?.('after_anchor', {})
      await this.store.publishAnchors(workstream)
      await this.project(workstream)
      return { accepted: true as const, value: { anchorId: id } }
    })
  }

  // ---------------------------------------------------------------- the clock

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      if (this.owner !== null) await this.owner.query('SELECT 1').catch(() => this.ownershipLost())
      if (this.stopped) return
      for (const workstream of [...this.live]) {
        await this.serial(workstream, async () => {
          const state = await this.store.state(workstream)
          const e = state.current
          if (!e || e.ended) return
          await this.timeouts(workstream, state, e)
          await this.renew(workstream, state, e)
          await this.reconcile(workstream)
          await this.project(workstream)
        }).catch(() => this.report({ operation: 'recover', outcome: 'blocked', workstream, errorClass: 'database' }))
      }
    } finally {
      this.ticking = false
    }
  }

  /**
   * `initialize` and Session opening: answered within the timeout, or the execution fails. An invalid
   * answer leaves the request pending (docs/specs/log.md, "Validation"): only a valid one stops the clock.
   * Decided under the Workstream's lock, so an answer captured meanwhile wins.
   */
  private async timeouts(workstream: string, state: State, e: Execution): Promise<void> {
    if (e.lost || e.failed) return
    const limit = this.options.responseTimeoutMs ?? 60_000
    for (const position of [...state.unanswered]) {
      const request = state.requestPositions.get(position)
      if (!request || request.execution !== e.id || !['initialize', ...OPENING].includes(request.method ?? '')) continue
      if (state.timedOut.has(request.position)) continue
      const sentAt = state.sentAt.get(request.position)
      if (sentAt === undefined || Date.parse(sentAt) + limit > Date.now()) continue
      const reason = request.method === 'initialize' || !e.body.anchor ? 'startup_failed' : 'restore_failed'
      const failed = await this.store.transaction(workstream, async (tx) => {
        const current = tx.state.executions.get(e.id)
        if (tx.state.answers.has(request.position) || tx.state.timedOut.has(request.position) || !current || current.lost || current.failed || current.ended) return false
        await tx.append({
          kind: 'request.failed',
          execution: request.execution,
          session: request.session,
          content: { requestPosition: request.position, reason: 'response_timeout' },
        })
        await tx.append({ kind: 'execution.failed', execution: e.id, content: { reason, requestPosition: request.position } })
        await tx.endSessions(e.id, reason)
        return true
      })
      if (failed) this.executions.hold(e.id)
      return
    }
  }

  /** During a dispatched turn: min(now + lease, turn start + maximum duration), the last step included. */
  private async renew(workstream: string, state: State, e: Execution): Promise<void> {
    const turn = state.active
    if (!turn || !turn.dispatching || !turn.startedAt || !e.uid || e.stopped || e.lost || e.failed || this.ending(e) || this.blocked.has(workstream)) return
    // Recovery is bounded by the deadline already granted: no renewal without the connection.
    if (!e.connection || this.executions.connectionOf(e.id) !== e.connection) return
    const { leaseSeconds, turnCapSeconds } = limitsOf(e)
    const cap = Date.parse(turn.startedAt) + turnCapSeconds * 1000
    const next = Math.min(Date.now() + leaseSeconds * 1000, cap)
    const current = Date.parse(this.executions.claimOf(e.id)?.spec?.lifecycle?.shutdownTime ?? '0')
    const step = Math.min(this.options.renewSeconds, leaseSeconds / 3) * 1000
    if (next <= Date.now() || !(next - current >= step || (next === cap && current < cap))) return
    try {
      await this.executions.renew(e.id, e.uid, iso(next))
      this.report({ operation: 'renew', outcome: 'succeeded', workstream, execution: e.id })
    } catch {
      this.report({ operation: 'renew', outcome: 'failed', workstream, execution: e.id, errorClass: 'transport' })
    }
  }
}
