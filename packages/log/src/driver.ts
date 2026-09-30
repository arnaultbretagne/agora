import { randomUUID, createHash, type KeyObject } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import type { PoolClient } from 'pg'
import type { KubeApi, Claim } from '@agora/executions'
import { mintBridgeToken } from '@agora/harness-bridge/token'
import type { Credentials } from '@agora/harness-bridge/outbound'
import { type Bundle } from '@agora/harness-bridge/anchor'
import { LogStore, type Command, type Answer, type Entry } from './store.ts'
import { fold, type Execution, type State } from './state.ts'
import { Projections } from './projection.ts'
import { object, encode, decode, schemaValue, uuid, identity } from './json.ts'
import { idKey, MAX_LINE, type Reason } from './acp.ts'
import { telemetry } from './telemetry.ts'

export const EXECUTION_LABEL = 'agora.bretagne.dev/execution-id'
const MANAGED = 'app.kubernetes.io/managed-by'
const POOL = 'agora.bretagne.dev/pool'
const SELECTOR = `${MANAGED}=agora,${EXECUTION_LABEL}`
const LOCK = 194710501
export function claimName(execution: string): string {
  return `sbx-${createHash('sha256').update(uuid(execution)).digest('hex').slice(0, 10)}`
}
export interface DriverOptions {
  store: LogStore
  kube: KubeApi
  signingKey: KeyObject
  bridgePort?: number
  address?: (service: string, pod: string) => string
  tickMs?: number
  renewSeconds?: number
  sink?: (line: string) => void
  maxActive?: number
  shutdownMs?: number
}
interface Connection {
  workstream: string
  execution: string
  id: string
  ws: WebSocket
  ordinal: bigint
  claim: Claim
  address: string
  pod: string
  bytes: number
  pending: Promise<void>
  blocked: boolean
  closed: boolean
  draining: boolean
  sends: Set<Promise<void>>
  initialized: boolean
}
export class LogDriver {
  readonly options: DriverOptions
  readonly projections: Projections
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly connections = new Map<string, Connection>()
  private owner: PoolClient | null = null
  private ownerError: (() => void) | null = null
  private stopped = true
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  constructor(options: DriverOptions) {
    this.options = options
    this.projections = new Projections(options.store)
  }
  private report(operation: string, outcome: string, fields: Record<string, unknown> = {}): void {
    telemetry({ operation, outcome, ...fields }, this.options.sink ?? (() => {}))
  }
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
  async start(): Promise<void> {
    if (!this.stopped) throw new Error('already_started')
    await this.options.store.assertBoundaries()
    const owner = await this.options.store.writer.connect()
    try {
      const locked = await owner.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK])
      if (!locked.rows[0].locked) throw new Error('dispatch_owner_exists')
      this.owner = owner
      this.ownerError = () => {
        this.stopped = true
        for (const c of this.connections.values()) {
          c.blocked = true
          c.ws.terminate()
        }
      }
      owner.on('error', this.ownerError)
      this.stopped = false
      const workstreams = await this.options.store.writer.query('SELECT id FROM workstreams ORDER BY id')
      for (const { id } of workstreams.rows)
        await this.serial(id, async () => {
          const entries = await this.options.store.entries(id),
            state = fold(entries)
          for (const execution of state.executions.values())
            if (execution.connection)
              await this.options.store.fact(id, {
                kind: 'execution.break',
                execution: execution.id,
                content: { connection: execution.connection, clean: false, reason: 'transport_error' },
              })
          await this.options.store.publishAnchors(id)
        })
      await this.tick()
      this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 1000)
    } catch (error) {
      this.stopped = true
      if (this.owner === owner) this.owner = null
      if (this.ownerError) owner.off('error', this.ownerError)
      this.ownerError = null
      await owner.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {})
      owner.release()
      throw error
    }
  }
  async command(workstream: string, command: Command): Promise<Answer> {
    if (this.stopped) return { accepted: false, reason: 'unavailable' }
    return this.serial(workstream, async () => {
      const answer = await this.options.store.accept(workstream, command, async (state, tx) => {
        const current = state.current
        if (command.kind === 'Create') {
          const execution = command.body.execution === undefined ? randomUUID() : uuid(command.body.execution),
            pool = command.body.pool
          const limits = object(command.body.limits)
          const lease = Number(schemaValue(limits?.leaseSeconds)),
            cap = Number(schemaValue(limits?.turnCapSeconds))
          const deadline =
            command.body.deadline ?? (Number.isFinite(lease) ? new Date(Date.now() + lease * 1000).toISOString() : null)
          if (
            typeof pool !== 'string' ||
            typeof deadline !== 'string' ||
            !Number.isFinite(Date.parse(deadline)) ||
            Date.parse(deadline) <= Date.now() ||
            Date.parse(deadline) > Date.now() + lease * 1000 + 1000 ||
            !Number.isInteger(lease) ||
            lease < 60 ||
            lease > 600 ||
            !Number.isInteger(cap) ||
            cap < 30 ||
            cap > 3600
          )
            return 'invalid_create'
          if (current?.lost && !current.ended) return 'replacement_unproven'
          if (current && !current.ended) return 'execution_active'
          const catalogue = await this.options.kube.listPools('agora.bretagne.dev/harness')
          if (!catalogue.some((p) => p.metadata.name === pool)) return 'unknown_pool'
          await tx.client.query('SELECT pg_advisory_xact_lock($1)', [LOCK + 1])
          const active = await tx.client.query(
            "SELECT count(*)::text AS count FROM commands c WHERE c.kind='Create' AND NOT EXISTS(SELECT 1 FROM entries e WHERE e.execution=c.execution AND e.kind IN ('execution.ended','execution.failed','execution.lost'))",
          )
          if (BigInt(active.rows[0].count) >= BigInt(this.options.maxActive ?? 4)) return 'quota'
          if (command.body.anchor !== undefined) {
            const anchor = await tx.client.query('SELECT id,metadata::text FROM anchors WHERE id=$1', [
              uuid(command.body.anchor),
            ])
            if (!anchor.rowCount) return 'unknown_anchor'
            const metadata = object(decode(anchor.rows[0].metadata)),
              harness = catalogue.find((p) => p.metadata.name === pool)?.metadata.labels?.['agora.bretagne.dev/harness']
            if (
              !metadata ||
              metadata.harness !== harness ||
              typeof metadata.sessionId !== 'string' ||
              !Array.isArray(metadata.files) ||
              metadata.files.length === 0
            )
              return 'anchor_incompatible'
          }
          return { execution, claimName: claimName(execution), body: { ...command.body, execution, deadline } }
        }
        if (!current || current.ended || current.lost) return 'execution_unavailable'
        if (command.target.execution !== current.id) return 'stale_execution'
        if (command.kind === 'Stop') return { execution: current.id, session: current.session ?? undefined }
        if (current.stopped) return 'stopped'
        const connection = this.connections.get(current.id)
        if (command.kind === 'Write') {
          if (!connection || connection.blocked || connection.closed || connection.ws.readyState !== WebSocket.OPEN)
            return 'disconnected'
          if (state.active) return state.active.status === 'uncertain' ? 'turn_uncertain' : 'turn_active'
          if (!current.session || command.target.session !== current.session) return 'stale_session'
          if (
            [...state.requests.values()].some(
              (e) =>
                e.execution === current.id &&
                ['session/new', 'session/resume', 'session/load'].includes(e.method ?? '') &&
                !state.answers.has(e.position),
            )
          )
            return 'opening_session'
          if (state.permissions.size) return 'permission_pending'
          return {
            execution: current.id,
            session: current.session,
            line: { method: 'session/prompt', params: { sessionId: current.acpId, prompt: command.body.prompt } },
          }
        }
        if (command.kind === 'Cancel') {
          if (
            !state.active ||
            !['in_progress', 'uncertain'].includes(state.active.status) ||
            command.target.turn !== state.active.id
          )
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
        if (
          outcome?.outcome === 'selected' &&
          (!Array.isArray(options) || !options.some((o) => object(o)?.optionId === outcome.optionId))
        )
          return 'invalid_permission_option'
        return {
          execution: current.id,
          session: permission.session ?? undefined,
          line: { id: permission.rpc_id, result: { outcome: command.body.outcome } },
        }
      })
      this.report('admission', answer.accepted ? 'accepted' : 'refused', { workstream, command: command.id })
      // Acceptance never changes if a subsequent external effect fails.
      if (answer.accepted)
        await this.drive(workstream).catch(() =>
          this.report('dispatch', 'blocked', { workstream, errorClass: 'database' }),
        )
      await this.projections
        .run(workstream)
        .catch(() => this.report('project', 'blocked', { workstream, errorClass: 'database' }))
      return answer
    })
  }
  /** Explicit ACP control surface for the lab (configuration/authentication/extensions), also journaled. */
  async control(
    workstream: string,
    execution: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    return this.serial(workstream, async () => {
      const state = await this.options.store.state(workstream),
        current = state.current
      if (
        this.stopped ||
        !current ||
        current.id !== execution ||
        current.stopped ||
        current.ended ||
        current.lost ||
        state.active
      )
        throw new Error('control_refused')
      if (['initialize', 'session/prompt', 'session/cancel'].includes(method)) throw new Error('use_command')
      const line = await this.options.store.transaction(workstream, (tx) =>
        tx.outgoing(
          execution,
          { method, params },
          method === 'session/new' || method === 'session/load' || method === 'session/resume'
            ? undefined
            : (current.session ?? undefined),
        ),
      )
      await this.drive(workstream)
      return String(line.id)
    })
  }
  async attachCredentials(workstream: string, execution: string, credentials: Credentials): Promise<void> {
    await this.serial(workstream, async () => {
      await this.ensureOwner()
      const state = await this.options.store.state(workstream),
        c = this.connections.get(execution)
      if (
        state.current?.id !== execution ||
        state.current.stopped ||
        state.current.ended ||
        state.current.lost ||
        !c ||
        c.closed ||
        c.blocked
      )
        throw new Error('execution_unavailable')
      const response = await fetch(`http://${c.address}/credentials`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${mintBridgeToken(this.options.signingKey, c.pod)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error('credentials_refused')
    })
  }
  private async ensureOwner(): Promise<void> {
    if (this.stopped || !this.owner) throw new Error('no_dispatch_owner')
    try {
      await this.owner.query('SELECT 1')
    } catch (error) {
      this.stopped = true
      for (const c of this.connections.values()) {
        c.blocked = true
        c.ws.terminate()
      }
      throw error
    }
  }
  private async drive(workstream: string): Promise<void> {
    await this.ensureOwner()
    const state = await this.options.store.state(workstream),
      execution = state.current
    if (!execution || execution.ended || execution.lost) return
    let claim = await this.options.kube.getClaim(execution.claimName)
    const deadline = String(execution.body.deadline)
    if (!claim) {
      if (execution.uid) {
        await this.end(workstream, execution, 'claim_missing')
        return
      }
      if (Date.parse(deadline) <= Date.now()) {
        await this.options.store.fact(workstream, {
          kind: 'execution.failed',
          execution: execution.id,
          content: { reason: 'startup_failed' },
        })
        return
      }
      const body = {
        apiVersion: 'extensions.agents.x-k8s.io/v1beta1',
        kind: 'SandboxClaim',
        metadata: {
          name: execution.claimName,
          labels: { [MANAGED]: 'agora', [POOL]: execution.body.pool, [EXECUTION_LABEL]: execution.id },
        },
        spec: {
          warmPoolRef: { name: execution.body.pool },
          lifecycle: { shutdownTime: deadline, shutdownPolicy: 'DeleteForeground' },
        },
      }
      if (execution.stopped) return
      await this.ensureOwner()
      try {
        claim = await this.options.kube.createClaim(body)
      } catch (error) {
        if ((error as { status?: number }).status !== 409) throw error
        claim = await this.options.kube.getClaim(execution.claimName)
      }
    }
    if (!claim) return
    if (
      claim.metadata.labels?.[EXECUTION_LABEL] !== execution.id ||
      claim.metadata.labels?.[MANAGED] !== 'agora' ||
      claim.metadata.labels?.[POOL] !== execution.body.pool ||
      (execution.uid && execution.uid !== claim.metadata.uid)
    ) {
      await this.options.store.fact(workstream, {
        kind: 'execution.lost',
        execution: execution.id,
        content: { reason: 'claim_conflict' },
      })
      this.connections.get(execution.id)?.ws.terminate()
      return
    }
    if (!execution.uid)
      await this.options.store.fact(workstream, {
        kind: 'execution.obtained',
        execution: execution.id,
        content: { uid: claim.metadata.uid, claimName: claim.metadata.name },
      })
    if (claim.metadata.deletionTimestamp || Date.parse(claim.spec?.lifecycle?.shutdownTime ?? deadline) <= Date.now()) {
      await this.end(workstream, execution, 'deadline_reached')
      return
    }
    const ready = claim.status?.conditions?.find((c) => c.type === 'Ready')
    if (ready?.status !== 'True') {
      if (
        ['WarmPoolNotFound', 'EnvVarsInjectionRejected', 'VolumeClaimTemplatesRejected'].includes(ready?.reason ?? '')
      )
        await this.options.store.fact(workstream, {
          kind: 'execution.failed',
          execution: execution.id,
          content: { reason: 'startup_failed' },
        })
      return
    }
    let connection = this.connections.get(execution.id)
    if (connection) connection.claim = claim
    if (!connection || connection.closed) {
      await this.connect(workstream, execution, claim)
      connection = this.connections.get(execution.id)
    }
    if (!connection || connection.blocked || connection.closed || connection.ws.readyState !== WebSocket.OPEN) return
    const history = await this.options.store.entries(workstream)
    const failedOpening = history.find(
      (e) =>
        e.execution === execution.id &&
        e.rpc_kind === 'error' &&
        ['initialize', 'session/new', 'session/load', 'session/resume'].includes(e.correlated_method ?? ''),
    )
    if (failedOpening) {
      await this.options.store.fact(workstream, {
        kind: 'execution.failed',
        execution: execution.id,
        content: { reason: execution.body.anchor ? 'restore_failed' : 'startup_failed' },
      })
      connection.ws.terminate()
      return
    }
    if (!execution.stopped) await this.setup(workstream, execution, connection)
    const entries = await this.options.store.entries(workstream),
      latest = fold(entries)
    for (const entry of entries) {
      if (
        entry.kind !== 'acp' ||
        entry.direction !== 'out' ||
        latest.attempts.has(entry.position) ||
        latest.failures.has(entry.position)
      )
        continue
      const current = latest.executions.get(execution.id)
      if (entry.execution !== execution.id) continue
      if (current?.stopped && entry.method !== 'session/cancel' && entry.rpc_kind !== 'response') continue
      if (entry.method === 'session/prompt' && !current?.initialized) continue
      if (entry.method === 'session/cancel') {
        const command = entries.find((e) => e.kind === 'command' && e.command === entry.command)
        if (
          command?.content.kind === 'Cancel' &&
          (!latest.active || object(command.content.target)?.turn !== latest.active.id)
        ) {
          await this.fail(workstream, entry, 'stopped')
          continue
        }
      }
      if (entry.method === 'session/prompt') {
        const limits = object(execution.body.limits)!,
          lease = Number(schemaValue(limits.leaseSeconds)),
          cap = Number(schemaValue(limits.turnCapSeconds))
        const until = Math.min(Date.now() + lease * 1000, Date.parse(entry.time) + cap * 1000)
        if (until <= Date.now()) {
          await this.fail(workstream, entry, 'deadline_refused')
          continue
        }
        const shutdownTime = new Date(until).toISOString()
        try {
          connection.claim = await this.options.kube.patchClaim(execution.claimName, {
            metadata: { uid: claim.metadata.uid },
            spec: { lifecycle: { shutdownTime } },
          })
        } catch {
          await this.fail(workstream, entry, 'deadline_refused')
          continue
        }
      }
      await this.dispatch(workstream, entry, connection)
    }
    if (execution.stopped)
      for (const entry of entries)
        if (
          entry.kind === 'acp' &&
          entry.direction === 'out' &&
          entry.method !== 'session/cancel' &&
          entry.rpc_kind !== 'response' &&
          entry.execution === execution.id &&
          !latest.attempts.has(entry.position) &&
          !latest.failures.has(entry.position)
        )
          await this.fail(workstream, entry, 'stopped')
    // Stop cancels the exact outstanding prompt; it never manufactures completion.
    if (latest.executions.get(execution.id)?.stopped && latest.active) {
      const stop = entries.findLast(
        (e) => e.kind === 'command' && e.execution === execution.id && e.content.kind === 'Stop',
      )
      const already = entries.some(
        (e) => e.kind === 'acp' && e.method === 'session/cancel' && e.command === stop?.command,
      )
      if (!already) {
        const outgoing = await this.options.store.transaction(workstream, (tx) =>
          tx.outgoing(
            execution.id,
            { method: 'session/cancel', params: { sessionId: execution.acpId } },
            execution.session ?? undefined,
            stop?.command ?? undefined,
          ),
        )
        const entry = (await this.options.store.entries(workstream)).find((e) => e.position === outgoing.position)!
        await this.dispatch(workstream, entry, connection)
      }
    }
  }
  private async setup(workstream: string, execution: Execution, c: Connection): Promise<void> {
    const entries = await this.options.store.entries(workstream),
      state = fold(entries)
    const init = entries.find((e) => e.execution === execution.id && e.method === 'initialize' && e.direction === 'out')
    if (!init) {
      await this.options.store.transaction(workstream, (tx) =>
        tx.outgoing(execution.id, {
          method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agora', version: '0.0.0' } },
        }),
      )
      return
    }
    if (!state.executions.get(execution.id)?.initialized) return
    const current = state.executions.get(execution.id)!
    if (current.session) return
    if (
      entries.some(
        (e) =>
          e.execution === execution.id &&
          ['session/new', 'session/resume', 'session/load'].includes(e.method ?? '') &&
          e.direction === 'out',
      )
    )
      return
    const response = await fetch(`http://${c.address}/info`, {
      headers: { authorization: `Bearer ${mintBridgeToken(this.options.signingKey, c.pod)}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error('bridge_info_failed')
    const info = (await response.json()) as { instance: string; workspace: string }
    if (info.instance !== current.instance) {
      await this.options.store.fact(workstream, {
        kind: 'execution.lost',
        execution: execution.id,
        content: { reason: 'instance_changed' },
      })
      c.ws.terminate()
      return
    }
    let method = 'session/new',
      params: Record<string, unknown> = { cwd: info.workspace, mcpServers: [] }
    if (execution.body.anchor) {
      const anchor = await this.options.store.anchors.query('SELECT metadata::text,content FROM anchors WHERE id=$1', [
        uuid(execution.body.anchor),
      ])
      if (!anchor.rowCount) throw new Error('anchor_missing')
      const metadata = object(decode(anchor.rows[0].metadata)),
        initialize = entries.find(
          (e) => e.execution === execution.id && e.correlated_method === 'initialize' && e.rpc_kind === 'response',
        )
      const caps = object(object(initialize?.content.result)?.agentCapabilities)
      method = object(caps?.sessionCapabilities)?.resume ? 'session/resume' : 'session/load'
      if (method === 'session/load' && caps?.loadSession !== true) {
        await this.options.store.fact(workstream, {
          kind: 'execution.failed',
          execution: execution.id,
          content: { reason: 'restore_failed' },
        })
        return
      }
      const restored = await fetch(`http://${c.address}/anchor`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${mintBridgeToken(this.options.signingKey, c.pod)}`,
          'content-type': 'application/json',
        },
        body: Buffer.from(anchor.rows[0].content),
        signal: AbortSignal.timeout(30000),
      })
      if (!restored.ok) {
        await this.options.store.fact(workstream, {
          kind: 'execution.failed',
          execution: execution.id,
          content: { reason: 'restore_failed' },
        })
        return
      }
      params = { ...params, sessionId: metadata?.sessionId }
    }
    await this.options.store.transaction(workstream, (tx) => tx.outgoing(execution.id, { method, params }))
  }
  private async dispatch(workstream: string, entry: Entry, c: Connection): Promise<void> {
    if (c.blocked || c.closed) return
    await this.ensureOwner()
    try {
      const attempted = await this.options.store.transaction(workstream, async (tx) => {
        const entries = await tx.entries(),
          state = fold(entries)
        const command = entries.find((e) => e.kind === 'command' && e.command === entry.command)
        const staleCancel =
          entry.method === 'session/cancel' &&
          (!state.active ||
            !['in_progress', 'uncertain'].includes(state.active.status) ||
            state.active.session !== entry.session ||
            (command?.content.kind === 'Cancel' && object(command.content.target)?.turn !== state.active.id))
        const reply = entries.find(
          (e) =>
            e.direction === 'out' &&
            ['response', 'error'].includes(e.rpc_kind ?? '') &&
            e.request_position === entry.request_position,
        )
        const stalePermission =
          entry.request_position &&
          entry.correlated_method === 'session/request_permission' &&
          (state.requests.get(`in:${idKey(entry.rpc_id)}`)?.position !== entry.request_position ||
            state.executions.get(c.execution)?.session !== entry.session ||
            reply?.position !== entry.position)

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
          content: { requestPosition: entry.position, connection: c.id, startedAt: entry.time },
        })
        return true
      })
      if (!attempted) return
    } catch (error) {
      c.blocked = true
      c.ws.terminate()
      throw error
    }
    // The marker is durable. A failure from here on can only be treated as possible delivery.
    if (this.stopped || c.blocked || c.closed) return
    const write = new Promise<void>((resolve, reject) =>
      c.ws.send(encode(entry.content), (error) => (error ? reject(error) : resolve())),
    )
    c.sends.add(write)
    try {
      await write
      await this.options.store.fact(workstream, {
        kind: 'acp.sent',
        execution: entry.execution,
        session: entry.session,
        content: { requestPosition: entry.position, connection: c.id },
      })
    } catch {
      c.blocked = true
      await this.fail(workstream, entry, 'transport_error').catch(() => {})
      c.ws.terminate()
    } finally {
      c.sends.delete(write)
    }
  }
  private async fail(workstream: string, entry: Entry, reason: Reason): Promise<void> {
    await this.options.store.fact(workstream, {
      kind: 'request.failed',
      execution: entry.execution,
      session: entry.session,
      content: { requestPosition: entry.position, reason },
    })
  }
  private async connect(workstream: string, execution: Execution, claim: Claim): Promise<void> {
    const pod = claim.status?.sandbox?.name,
      service = claim.status?.sandbox?.serviceFQDN
    if (!pod || !service) return
    const address = this.options.address?.(service, pod) ?? `${service}:${this.options.bridgePort ?? 8080}`
    const ws = new WebSocket(`ws://${address}/acp`, {
      headers: { authorization: `Bearer ${mintBridgeToken(this.options.signingKey, pod)}` },
      maxPayload: MAX_LINE,
      handshakeTimeout: 5000,
    })
    const c: Connection = {
      workstream,
      execution: execution.id,
      id: randomUUID(),
      ws,
      ordinal: 0n,
      claim,
      address,
      pod,
      bytes: 0,
      pending: Promise.resolve(),
      blocked: true,
      closed: false,
      draining: false,
      sends: new Set(),
      initialized: false,
    }
    this.connections.set(execution.id, c)
    let instance: string | null = null
    ws.on('upgrade', (response) => {
      instance =
        typeof response.headers['agora-bridge-instance'] === 'string' ? response.headers['agora-bridge-instance'] : null
    })
    ws.on('message', (data: RawData) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      ws.pause()
      if (c.bytes + bytes.byteLength > MAX_LINE) {
        c.blocked = true
        ws.terminate()
        return
      }
      c.bytes += bytes.byteLength
      const ordinal = String(++c.ordinal)
      c.pending = c.pending
        .then(async () => {
          const deadline = Date.parse(c.claim.spec?.lifecycle?.shutdownTime ?? String(execution.body.deadline))
          for (;;) {
            try {
              await this.options.store.incoming(workstream, execution.id, c.id, ordinal, bytes)
              break
            } catch {
              c.blocked = true
              this.report('capture', 'blocked', {
                workstream,
                execution: execution.id,
                connection: c.id,
                errorClass: 'database',
                bytes: c.bytes,
              })
              if (Date.now() >= deadline) {
                ws.terminate()
                return
              }
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
          }
          c.bytes -= bytes.byteLength
          if (!c.closed) {
            c.blocked = false
            ws.resume()
          }
          await this.serial(workstream, async () => {
            const current = await this.options.store.state(workstream)
            // Permission requests left open by cancellation must be settled before another prompt.
            const committed = (await this.options.store.entries(workstream)).find(
              (e) => e.connection === c.id && e.receive_ordinal === ordinal,
            )
            const latestExecution = current.executions.get(execution.id)
            if (
              committed?.correlated_method === 'session/prompt' &&
              ['response', 'error'].includes(committed.rpc_kind ?? '') &&
              !latestExecution?.stopped &&
              !latestExecution?.ended &&
              !latestExecution?.lost
            ) {
              const lease = Number(schemaValue(object(execution.body.limits)?.leaseSeconds))
              await this.ensureOwner()
              c.claim = await this.options.kube
                .patchClaim(execution.claimName, {
                  metadata: { uid: latestExecution?.uid },
                  spec: { lifecycle: { shutdownTime: new Date(Date.now() + lease * 1000).toISOString() } },
                })
                .catch(() => c.claim)
            }
            const turn = [...current.turns.values()].at(-1)
            if (turn?.status === 'cancelled')
              for (const permission of current.permissions.values())
                if (permission.execution === execution.id)
                  await this.options.store.transaction(workstream, (tx) =>
                    tx.outgoing(
                      execution.id,
                      { id: permission.rpc_id, result: { outcome: { outcome: 'cancelled' } } },
                      permission.session ?? undefined,
                    ),
                  )
            if (!this.stopped && !c.draining) await this.drive(workstream)
            await this.projections.run(workstream)
          }).catch(() => this.report('capture', 'blocked', { workstream, errorClass: 'database' }))
        })
        .catch(() => {
          c.blocked = true
          ws.terminate()
        })
    })
    ws.on('error', () => {
      c.blocked = true
    })
    ws.on('close', (code) => {
      c.closed = true
      c.blocked = true
      void c.pending
        .then(() =>
          this.serial(workstream, async () => {
            const entries = await this.options.store.entries(workstream)
            const already = entries.some((e) => e.kind === 'execution.break' && e.content.connection === c.id)
            const state = fold(entries),
              attempts = entries.filter((e) => e.kind === 'acp.dispatching' && e.content.connection === c.id)
            const proven = attempts.every(
              (e) =>
                state.sent.has(String(e.content.requestPosition)) ||
                state.answers.has(String(e.content.requestPosition)),
            )
            if (!already)
              await this.options.store.fact(workstream, {
                kind: 'execution.break',
                execution: execution.id,
                content: {
                  connection: c.id,
                  clean: c.draining && code === 1000 && c.bytes === 0 && c.sends.size === 0 && proven,
                  reason: 'transport_error',
                },
              })
            if (code === 1011)
              await this.options.store.fact(workstream, {
                kind: 'execution.lost',
                execution: execution.id,
                content: { reason: 'adapter_exited' },
              })
            await this.projections.run(workstream)
          }),
        )
        .catch(() => this.report('connect', 'unclean', { workstream, errorClass: 'database' }))
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', () => reject(new Error('transport_error')))
      ws.once('close', () => reject(new Error('transport_error')))
    })
    if (!instance || (execution.instance && execution.instance !== instance)) {
      await this.options.store.fact(workstream, {
        kind: 'execution.lost',
        execution: execution.id,
        content: { reason: 'instance_changed' },
      })
      ws.terminate()
      return
    }
    await this.options.store.fact(workstream, {
      kind: 'execution.connected',
      execution: execution.id,
      content: { connection: c.id, instance },
    })
    c.blocked = false
  }
  private async end(workstream: string, execution: Execution, reason: Reason): Promise<void> {
    const c = this.connections.get(execution.id)
    if (c && !c.closed) {
      c.blocked = true
      c.ws.terminate()
    }
    await this.options.store.fact(workstream, { kind: 'execution.ended', execution: execution.id, content: { reason } })
  }
  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      await this.ensureOwner()
      // Listing is mandatory even when no claims exist: the journal may contain an accepted Create.
      await this.options.kube.listClaims(SELECTOR)
      const streams = await this.options.store.writer.query('SELECT id FROM workstreams')
      for (const { id } of streams.rows)
        await this.serial(id, async () => {
          await this.drive(id)
          const state = await this.options.store.state(id),
            execution = state.current,
            turn = state.active,
            c = execution ? this.connections.get(execution.id) : undefined
          if (
            execution &&
            turn &&
            turn.dispatching &&
            !execution.stopped &&
            !execution.ended &&
            !execution.lost &&
            c &&
            !c.closed &&
            !c.blocked &&
            turn.startedAt
          ) {
            const limits = object(execution.body.limits)!,
              lease = Number(schemaValue(limits.leaseSeconds)),
              cap = Number(schemaValue(limits.turnCapSeconds))
            const next = Math.min(Date.now() + lease * 1000, Date.parse(turn.startedAt) + cap * 1000),
              previous = Date.parse(c.claim.spec?.lifecycle?.shutdownTime ?? '0')
            if (next > Date.now() && next - previous > Math.min(this.options.renewSeconds ?? 60, lease / 3) * 1000) {
              await this.ensureOwner()
              c.claim = await this.options.kube.patchClaim(execution.claimName, {
                metadata: { uid: execution.uid },
                spec: { lifecycle: { shutdownTime: new Date(next).toISOString() } },
              })
            }
          }
          await this.projections.run(id)
        }).catch(() => this.report('recover', 'blocked', { workstream: id, errorClass: 'database' }))
    } catch {
      this.report('recover', 'blocked', { errorClass: 'database' })
    } finally {
      this.ticking = false
    }
  }
  async receiveAnchor(pod: string, bundle: Bundle, bytes: Uint8Array): Promise<Answer> {
    const c = [...this.connections.values()].find((c) => c.pod === pod)
    if (!c) return { accepted: false, reason: 'unknown_execution' }
    return this.serial(c.workstream, async () => {
      const state = await this.options.store.state(c.workstream),
        execution = state.executions.get(c.execution)!
      const id = identity(c.execution, c.claim.metadata.uid, createHash('sha256').update(bytes).digest('hex'), 'anchor')
      await this.options.store.anchor({
        id,
        workstream: c.workstream,
        execution: c.execution,
        session: execution.session,
        metadata: {
          harness: bundle.harness,
          pool: execution.body.pool,
          format: bundle.format,
          sessionId: execution.acpId,
          files: bundle.files.map((f) => ({ path: f.path, byteLength: Buffer.from(f.content, 'base64').byteLength })),
          stable: bundle.stable,
          reason: execution.stopped ? 'stopped' : 'deadline_reached',
        },
        bytes,
      })
      return {
        accepted: true,
        command: id,
        position: (await this.options.store.entries(c.workstream)).find(
          (e) => e.kind === 'anchor.received' && e.content.id === id,
        )!.position,
        execution: c.execution,
      }
    })
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    const deadline = Date.now() + (this.options.shutdownMs ?? 5000)
    const completed = new Set<string>()
    const tasks = [...this.connections.values()].map(async (c) => {
      c.draining = true
      await Promise.allSettled([...c.sends])
      if (c.ws.readyState === WebSocket.OPEN) c.ws.close(1000)
      while ((!c.closed || c.bytes > 0) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      await c.pending
      await this.queues.get(c.workstream)?.catch(() => {})
      completed.add(c.id)
    })
    let timeout: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, Math.max(0, deadline - Date.now()))
      }),
    ])
    clearTimeout(timeout)
    for (const c of this.connections.values())
      if (!completed.has(c.id)) {
        c.draining = false
        c.blocked = true
        c.ws.terminate()
      }
    if (this.owner) {
      await this.owner.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {})
      if (this.ownerError) this.owner.off('error', this.ownerError)
      this.ownerError = null
      this.owner.release()
      this.owner = null
    }
  }
}
