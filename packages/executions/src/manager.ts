// The execution mechanics (docs/specs/executions.md): claims, bridge connections, deadlines, the bridge's
// HTTP routes. It keeps no history and decides nothing about ACP: whoever mounts it (the log's
// Workstreams) says which executions to run, receives every event through a Handler, and asks for
// every effect. It never deletes anything: the infrastructure destroys at the deadline.
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import { KubeError, WatchGone, type Claim, type KubeApi, type Sandbox, type WatchEvent } from './kube.ts'
import { mintBridgeToken } from '@agora/harness-bridge/token'
import type { Credentials, OutboundView } from '@agora/harness-bridge/outbound'
import { BASE_PROFILES_ANNOTATION, baseProfiles } from '@agora/credentials'

export const MANAGED_BY = 'app.kubernetes.io/managed-by'
export const MANAGER = 'agora'
export const POOL_LABEL = 'agora.bretagne.dev/pool'
export const HARNESS_LABEL = 'agora.bretagne.dev/harness'
export const EXECUTION_LABEL = 'agora.bretagne.dev/execution-id'
const SELECTOR = `${MANAGED_BY}=${MANAGER},${EXECUTION_LABEL}`
/** One line, one WebSocket message (docs/specs/log.md, "ACP lines"). */
export const MAX_LINE = 16 * 1024 * 1024
export const TERMINAL_CLAIM_REASONS = new Set(['WarmPoolNotFound', 'EnvVarsInjectionRejected', 'VolumeClaimTemplatesRejected'])

export interface Limits {
  readonly leaseSeconds: number
  readonly turnCapSeconds: number
}

export const LIMIT_BOUNDS: Record<keyof Limits, readonly [number, number]> = {
  leaseSeconds: [60, 600],
  turnCapSeconds: [30, 3600],
}

/** The settings each Session of a pool starts with (docs/specs/executions.md, "The API"). */
export const SESSION_CONFIG_ANNOTATION = 'agora.bretagne.dev/session-config'

/** `id=value` pairs separated by commas, in order; a malformed pair, or a repeated id, is left out. */
export function sessionConfig(annotation: string | undefined): { id: string; value: string }[] {
  if (!annotation) return []
  const out: { id: string; value: string }[] = []
  for (const pair of annotation.split(',')) {
    const at = pair.indexOf('=')
    const id = pair.slice(0, at).trim(),
      value = pair.slice(at + 1).trim()
    if (at > 0 && id !== '' && value !== '' && !out.some((w) => w.id === id)) out.push({ id, value })
  }
  return out
}

export function claimName(execution: string): string {
  return `sbx-${createHash('sha256').update(execution).digest('hex').slice(0, 10)}`
}

/** An execution to run, as its log records it. */
export interface Target {
  readonly execution: string
  readonly claimName: string
  readonly pool: string
}

/** What the mechanics report; the handler answers and orders every effect. */
export interface Handler {
  /** The claim of a run execution changed, or disappeared (`null`). */
  claim(execution: string, claim: Claim | null): Promise<void>
  /** A connection is open; `true` lets its lines flow, `false` closes it. */
  connected(execution: string, connection: string, instance: string): Promise<boolean>
  /** A received line. Nothing more is read from the connection until this settles; a rejection fails it. */
  line(execution: string, connection: string, ordinal: bigint, bytes: Buffer): Promise<void>
  /** The connection closed, after every line handed over settled. `drained`: Agora closed it cleanly. */
  closed(execution: string, connection: string, code: number | null, drained: boolean): Promise<void>
}

/** Signs tokens for the gateway (docs/specs/credentials.md); the mechanics never keep one. */
export interface CredentialSource {
  describe(): Record<string, unknown>
  mint(input: { label: string; ttlSeconds: number; profiles?: readonly string[] }): Promise<Credentials>
}

export interface ManagerOptions {
  readonly kube: KubeApi
  readonly signingKey: KeyObject
  readonly bridgePort: number
  /** Test seam: where to reach a sandbox's bridge. Defaults to its Service (`serviceFQDN`). */
  readonly bridgeAddress?: (serviceFQDN: string, podName: string) => string
  readonly tickMs?: number
  readonly reconnectMs?: number
  /** Warms the pools' Pods with their base profiles; without it, no Pod has a way out before its execution. */
  readonly credentials?: CredentialSource
  /** How often the pools' Sandboxes are looked at (5 s), and a warm token's life (15 min). */
  readonly warmEveryMs?: number
  readonly warmTtlSeconds?: number
}

interface Connection {
  readonly id: string
  readonly ws: WebSocket
  instance: string | null
  open: boolean
  accepted: boolean
  closed: boolean
  draining: boolean
  failed: boolean
  ordinal: bigint
  pending: number
  queue: Buffer[]
  reading: boolean
  readonly sends: Set<Promise<void>>
  /** The handler's verdict on the connection, once asked: its close waits for it. */
  accepting: Promise<void> | null
  done: Promise<void>
  finish: () => void
}

interface Run {
  readonly target: Target
  claim: Claim | null
  held: boolean
  connection: Connection | null
  reconnectAt: number
  launchType: string | null
  podDetail: string | null
  outbound: OutboundView | null
}

export interface ExecutionView {
  readonly execution: string
  readonly claimName: string
  readonly pool: string
  readonly uid: string | null
  readonly ready: boolean
  readonly reason: string
  readonly ending: boolean
  readonly shutdownTime: string | null
  readonly pod: string | null
  readonly podDetail: string | null
  readonly launchType: string | null
  readonly bridge: 'none' | 'connecting' | 'connected'
  readonly instance: string | null
  readonly connection: string | null
  /** Bytes received and not yet handed over: at most one line. */
  readonly pending: number
  readonly held: boolean
  readonly outbound: OutboundView | null
}

export interface PoolView {
  readonly name: string
  readonly harness: string
  readonly template: string
  readonly image: string | null
  readonly replicas: number
  readonly readyReplicas: number
  /** What its Pods get while they wait (docs/specs/credentials.md, "Base profiles"). */
  readonly baseProfiles: readonly string[]
  /** A declared profile that is not a base one: then the pool gets none. */
  readonly refusedProfile: string | null
  /** The settings its Sessions start with, in order. */
  readonly sessionConfig: readonly { readonly id: string; readonly value: string }[]
}

export type CommandResult<T> =
  | { readonly accepted: true; readonly value: T }
  | { readonly accepted: false; readonly reason: string; readonly status: number }

function refused(reason: string, status = 409): { accepted: false; reason: string; status: number } {
  return { accepted: false, reason, status }
}

export class ExecutionManager {
  private readonly options: ManagerOptions
  private readonly runs = new Map<string, Run>()
  private readonly claims = new Map<string, Claim>()
  private readonly listeners = new Set<(view: ExecutionView) => void>()
  private readonly foreignKey = generateKeyPairSync('ed25519').privateKey
  private handler: Handler | null = null
  private poolCache: { at: number; pools: PoolView[] } | null = null
  /** The warm Sandboxes: when their token runs out, and a hand-over in flight. */
  private readonly warm = new Map<string, { until: number; inflight: Promise<void> | null }>()
  /** Sandboxes a claim has bound: never warmed again. */
  private readonly bound = new Set<string>()
  private warmedAt = 0
  private tickTimer: NodeJS.Timeout | null = null
  private watchAbort: AbortController | null = null
  private stopped = false

  constructor(options: ManagerOptions) {
    this.options = options
  }

  // ---------------------------------------------------------------- lifecycle

  /** Lists the claims, then follows them. Runs registered before or after receive their claim. */
  async start(handler: Handler): Promise<void> {
    this.handler = handler
    const { items, resourceVersion } = await this.options.kube.listClaims(SELECTOR)
    for (const claim of items) this.claims.set(this.executionOf(claim) ?? claim.metadata.name, claim)
    for (const run of this.runs.values()) await this.observe(run, this.claims.get(run.target.execution) ?? null)
    void this.watchLoop(resourceVersion)
    this.tickTimer = setInterval(() => void this.tick(), this.options.tickMs ?? 1000)
  }

  /** Stops following claims and terminates what is still open; `drain` first for a clean stop. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.tickTimer !== null) clearInterval(this.tickTimer)
    this.watchAbort?.abort()
    for (const run of this.runs.values()) if (run.connection !== null && !run.connection.closed) run.connection.ws.terminate()
  }

  /** Closes every connection cleanly within `ms`: sends settle, the close handshake runs, lines keep flowing. */
  async drain(ms: number): Promise<void> {
    this.stopped = true
    const deadline = Date.now() + ms
    await Promise.all(
      [...this.runs.values()].map(async (run) => {
        const c = run.connection
        if (c === null || c.closed) return
        c.draining = true
        await Promise.race([Promise.allSettled([...c.sends]), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))])
        if (c.ws.readyState === WebSocket.OPEN) c.ws.close(1000, 'Agora stopping')
        const timer = setTimeout(() => {
          c.draining = false
          c.ws.terminate()
        }, Math.max(0, deadline - Date.now()))
        await c.done
        clearTimeout(timer)
      }),
    )
  }

  // ---------------------------------------------------------------- runs

  /** Runs an execution: its claim is reported, and its bridge connected while the claim is ready. */
  async run(target: Target): Promise<void> {
    let run = this.runs.get(target.execution)
    if (run !== undefined) return
    run = { target, claim: null, held: false, connection: null, reconnectAt: 0, launchType: null, podDetail: null, outbound: null }
    this.runs.set(target.execution, run)
    if (this.handler !== null) await this.observe(run, this.claims.get(target.execution) ?? null)
  }

  /** No new connection; the open one is terminated. The claim is still followed until it disappears. */
  hold(execution: string): void {
    const run = this.runs.get(execution)
    if (run === undefined) return
    run.held = true
    if (run.connection !== null && !run.connection.closed) run.connection.ws.terminate()
    this.emit(run)
  }

  /** Forgets an execution whose claim has disappeared. */
  release(execution: string): void {
    const run = this.runs.get(execution)
    if (run === undefined) return
    if (run.connection !== null && !run.connection.closed) run.connection.ws.terminate()
    this.runs.delete(execution)
  }

  claimOf(execution: string): Claim | null {
    return this.runs.get(execution)?.claim ?? null
  }

  /** The claim bound to a Pod, and its execution, as the cluster reports it now. */
  async claimForPod(pod: string): Promise<{ execution: string; claim: Claim }[]> {
    const { items } = await this.options.kube.listClaims(SELECTOR)
    return items
      .filter((claim) => claim.status?.sandbox?.name === pod)
      .flatMap((claim) => {
        const execution = this.executionOf(claim)
        return execution === null ? [] : [{ execution, claim }]
      })
  }

  async podUid(pod: string): Promise<string | null> {
    const found = (await this.options.kube.getPod(pod)) as { metadata?: { uid?: string } } | null
    return found?.metadata?.uid ?? null
  }

  // ---------------------------------------------------------------- claims

  private executionOf(claim: Claim): string | null {
    return claim.metadata.labels?.[EXECUTION_LABEL] ?? null
  }

  private async watchLoop(initialVersion: string): Promise<void> {
    let version = initialVersion
    while (!this.stopped) {
      this.watchAbort = new AbortController()
      try {
        await this.options.kube.watchClaims(SELECTOR, version, (event) => (version = this.onWatchEvent(event) ?? version), this.watchAbort.signal)
      } catch (error) {
        if (this.stopped) return
        if (error instanceof WatchGone) {
          try {
            const list = await this.options.kube.listClaims(SELECTOR)
            version = list.resourceVersion
            const seen = new Set<string>()
            for (const claim of list.items) {
              const execution = this.executionOf(claim)
              if (execution === null) continue
              seen.add(execution)
              this.claims.set(execution, claim)
              const run = this.runs.get(execution)
              if (run !== undefined) void this.observe(run, claim)
            }
            for (const [execution, run] of this.runs) if (!seen.has(execution)) void this.observe(run, null)
          } catch {
            // Listed again on the next turn of the loop.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  private onWatchEvent(event: WatchEvent): string | undefined {
    const version = event.object.metadata?.resourceVersion
    if (event.type === 'BOOKMARK') return version
    const execution = this.executionOf(event.object)
    if (execution === null) return version
    if (event.type === 'DELETED') {
      if (this.claims.get(execution)?.metadata.uid === event.object.metadata.uid) this.claims.delete(execution)
      const run = this.runs.get(execution)
      if (run !== undefined && run.claim?.metadata.uid === event.object.metadata.uid) void this.observe(run, null)
      return version
    }
    this.claims.set(execution, event.object)
    const run = this.runs.get(execution)
    if (run !== undefined) void this.observe(run, event.object)
    return version
  }

  private async observe(run: Run, claim: Claim | null): Promise<void> {
    run.claim = claim
    if (claim !== null && run.launchType === null && claim.status?.sandbox?.name !== undefined) void this.readLaunchType(run)
    this.emit(run)
    await this.handler?.claim(run.target.execution, claim)
    this.ensureConnection(run)
  }

  /** Creates the claim with the recorded name, pool and deadline; a claim already there is returned. */
  async createClaim(target: Target, shutdownTime: string): Promise<Claim> {
    const body = {
      apiVersion: 'extensions.agents.x-k8s.io/v1beta1',
      kind: 'SandboxClaim',
      metadata: {
        name: target.claimName,
        labels: { [MANAGED_BY]: MANAGER, [POOL_LABEL]: target.pool, [EXECUTION_LABEL]: target.execution },
      },
      spec: { warmPoolRef: { name: target.pool }, lifecycle: { shutdownTime, shutdownPolicy: 'DeleteForeground' } },
    }
    let claim: Claim | null
    try {
      claim = await this.options.kube.createClaim(body)
    } catch (error) {
      if (!(error instanceof KubeError) || error.status !== 409) throw error
      claim = await this.options.kube.getClaim(target.claimName)
      if (claim === null) throw error
    }
    this.claims.set(target.execution, claim)
    const run = this.runs.get(target.execution)
    if (run !== undefined) await this.observe(run, claim)
    return claim
  }

  /** Moves the deadline; refused if the claim's UID changed. */
  async renew(execution: string, uid: string, shutdownTime: string): Promise<Claim> {
    const run = this.runs.get(execution)
    if (run === undefined) throw new Error('unknown_execution')
    const claim = await this.options.kube.patchClaim(run.target.claimName, { metadata: { uid }, spec: { lifecycle: { shutdownTime } } })
    run.claim = claim
    this.claims.set(execution, claim)
    this.emit(run)
    return claim
  }

  private async readLaunchType(run: Run): Promise<void> {
    try {
      const sandbox = await this.options.kube.getSandbox(run.claim?.status?.sandbox?.name ?? '')
      const labels = (sandbox?.metadata as { labels?: Record<string, string> } | undefined)?.labels
      const launchType = labels?.['agents.x-k8s.io/launch-type'] ?? null
      if (launchType !== null) {
        run.launchType = launchType
        this.emit(run)
      }
    } catch {
      // The tick tries again.
    }
  }

  private async diagnose(run: Run): Promise<void> {
    const pod = await this.options.kube.getPod(run.claim?.status?.sandbox?.name ?? '')
    const status = pod?.status as { phase?: string; containerStatuses?: { state?: Record<string, { reason?: string; message?: string }> }[]; conditions?: { type: string; status: string; reason?: string; message?: string }[] } | undefined
    const waiting = status?.containerStatuses?.[0]?.state?.waiting ?? status?.containerStatuses?.[0]?.state?.terminated
    const unscheduled = status?.conditions?.find((condition) => condition.type === 'PodScheduled' && condition.status === 'False')
    const detail = waiting !== undefined ? `${String(waiting.reason)}${waiting.message === undefined ? '' : `: ${waiting.message}`}` : unscheduled !== undefined ? `${String(unscheduled.reason)}: ${String(unscheduled.message)}` : status?.phase ?? null
    if (detail !== run.podDetail) {
      run.podDetail = detail
      this.emit(run)
    }
  }

  private async tick(): Promise<void> {
    if (this.options.credentials !== undefined && Date.now() - this.warmedAt >= (this.options.warmEveryMs ?? 5000)) {
      this.warmedAt = Date.now()
      void this.warmPools().catch(() => {})
    }
    for (const run of [...this.runs.values()]) {
      try {
        const claim = run.claim
        const ready = claim?.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True'
        if (claim !== null && !ready && claim.status?.sandbox?.name !== undefined) await this.diagnose(run)
        if (claim !== null && run.launchType === null && claim.status?.sandbox?.name !== undefined) await this.readLaunchType(run)
        this.ensureConnection(run)
      } catch {
        // Diagnostics only: tried again on the next tick.
      }
    }
  }

  // ---------------------------------------------------------------- bridge connections

  private address(run: Run): string {
    return this.addressOf(run.claim?.status?.sandbox?.serviceFQDN ?? '', run.claim?.status?.sandbox?.name ?? '')
  }

  private addressOf(service: string, pod: string): string {
    // A Service name never holds a port; a `host:port` comes from a test cluster and is used as is.
    return this.options.bridgeAddress?.(service, pod) ?? (service.includes(':') ? service : `${service}:${String(this.options.bridgePort)}`)
  }

  private token(run: Run): string {
    return mintBridgeToken(this.options.signingKey, run.claim?.status?.sandbox?.name ?? '')
  }

  private ensureConnection(run: Run): void {
    if (this.stopped || run.held || this.handler === null || this.runs.get(run.target.execution) !== run) return
    // A connection is replaced only once its close has been reported.
    if (run.connection !== null) return
    if (Date.now() < run.reconnectAt) return
    const claim = run.claim
    if (claim === null || claim.metadata.deletionTimestamp !== undefined) return
    if (claim.status?.conditions?.find((c) => c.type === 'Ready')?.status !== 'True') return
    if (claim.status.sandbox?.name === undefined || !claim.status.sandbox.serviceFQDN) return
    this.connect(run)
  }

  private connect(run: Run): void {
    const ws = new WebSocket(`ws://${this.address(run)}/acp`, {
      headers: { authorization: `Bearer ${this.token(run)}` },
      maxPayload: MAX_LINE,
      // UTF-8 is the log's to check: an invalid line becomes a diagnostic, not a closed connection.
      skipUTF8Validation: true,
      handshakeTimeout: 5000,
    })
    let finish = (): void => {}
    const done = new Promise<void>((resolve) => (finish = resolve))
    const c: Connection = {
      id: randomUUID(),
      ws,
      instance: null,
      open: false,
      accepted: false,
      closed: false,
      draining: false,
      failed: false,
      ordinal: 0n,
      pending: 0,
      queue: [],
      reading: false,
      sends: new Set(),
      accepting: null,
      done,
      finish,
    }
    run.connection = c
    this.emit(run)
    ws.on('upgrade', (response) => {
      const header = response.headers['agora-bridge-instance']
      c.instance = typeof header === 'string' && header.length > 0 ? header : null
    })
    ws.on('open', () => {
      c.open = true
      ws.pause()
      c.accepting = this.accept(run, c)
    })
    ws.on('message', (data: RawData) => {
      // Paused until this line is committed: nothing more is read, the rest waits with the bridge.
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      c.pending += bytes.byteLength
      ws.pause()
      c.queue.push(bytes)
      if (c.accepted) void this.read(run, c)
    })
    ws.on('error', () => {})
    ws.on('close', (code) => {
      c.closed = true
      // Set at once, so that no tick reconnects before this close is reported: no reconnection
      // to a dead adapter (1011) or an ending Pod (1001); otherwise after a pause.
      if (code === 1011 || code === 1001) run.held = true
      else run.reconnectAt = Math.max(run.reconnectAt, Date.now() + (this.options.reconnectMs ?? 2000))
      void this.closeConnection(run, c, c.open ? code : null)
    })
  }

  private async accept(run: Run, c: Connection): Promise<void> {
    try {
      if (c.instance === null || this.handler === null) throw new Error('instance header missing')
      const accepted = await this.handler.connected(run.target.execution, c.id, c.instance)
      if (!accepted) {
        c.ws.close(1000, 'process identity lost')
        return
      }
      c.accepted = true
      this.emit(run)
      await this.read(run, c)
    } catch {
      c.failed = true
      c.ws.terminate()
    }
  }

  private async read(run: Run, c: Connection): Promise<void> {
    if (c.reading || !c.accepted) return
    c.reading = true
    try {
      while (c.queue.length > 0) {
        const bytes = c.queue.shift()!
        c.ordinal += 1n
        try {
          await this.handler!.line(run.target.execution, c.id, c.ordinal, bytes)
        } catch {
          c.failed = true
          c.ws.terminate()
          c.queue.length = 0
          return
        }
        c.pending -= bytes.byteLength
      }
      if (!c.closed && c.accepted) c.ws.resume()
    } finally {
      c.reading = false
    }
  }

  private async closeConnection(run: Run, c: Connection, code: number | null): Promise<void> {
    // The handler may be writing this connection down: its verdict comes first, so that a connection
    // it recorded always gets its close.
    await c.accepting?.catch(() => {})
    // Every line handed over settles before the close is reported. Lines that arrived before the
    // connection was accepted cannot be captured: the break records that output may be missing.
    if (!c.accepted) {
      c.pending = 0
      c.queue.length = 0
    }
    while (c.reading || c.queue.length > 0) {
      if (!c.reading && c.queue.length > 0) await this.read(run, c)
      else await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await Promise.allSettled([...c.sends])
    const drained = c.draining && code === 1000 && !c.failed && c.pending === 0
    try {
      if (c.accepted) await this.handler?.closed(run.target.execution, c.id, code, drained)
    } finally {
      c.finish()
      if (run.connection === c) {
        run.connection = null
        this.emit(run)
      }
    }
  }

  /** Sends one line on that very connection; resolves when the write's callback succeeds. */
  send(execution: string, connection: string, text: string): Promise<void> {
    const c = this.runs.get(execution)?.connection
    // Draining refuses nothing: a write whose marker is committed must still be attempted.
    if (c === null || c === undefined || c.id !== connection || c.closed || !c.accepted) return Promise.reject(new Error('transport_error'))
    const write = new Promise<void>((resolve, reject) => c.ws.send(text, (error) => (error ? reject(new Error('transport_error')) : resolve())))
    c.sends.add(write)
    void write.finally(() => c.sends.delete(write)).catch(() => {})
    return write
  }

  /** The open, accepted connection of an execution, if any. */
  connectionOf(execution: string): string | null {
    const c = this.runs.get(execution)?.connection
    return c !== null && c !== undefined && c.accepted && !c.closed && !c.draining ? c.id : null
  }

  private async bridge(execution: string, method: string, path: string, body?: Uint8Array | string, timeoutMs = 10_000): Promise<Response> {
    const run = this.runs.get(execution)
    if (run === undefined || run.claim?.status?.sandbox?.name === undefined) throw new Error('unknown_execution')
    return fetch(`http://${this.address(run)}${path}`, {
      method,
      ...(body === undefined ? {} : { body: body as BodyInit }),
      headers: { authorization: `Bearer ${this.token(run)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  async info(execution: string): Promise<{ instance: string; workspace: string; adapter: unknown; outbound: OutboundView }> {
    const response = await this.bridge(execution, 'GET', '/info', undefined, 5000)
    if (!response.ok) throw new Error('bridge_info_refused')
    const info = (await response.json()) as { instance: string; workspace: string; adapter: unknown; outbound: OutboundView }
    const run = this.runs.get(execution)
    if (run !== undefined) {
      run.outbound = info.outbound
      this.emit(run)
    }
    return info
  }

  /** Places an anchor's native files before the session is resumed. */
  async putAnchor(execution: string, bundle: Uint8Array): Promise<void> {
    const response = await this.bridge(execution, 'PUT', '/anchor', bundle, 30_000)
    if (!response.ok) throw new Error('anchor_refused')
  }

  /**
   * Hands the bridge its way out; the token is kept nowhere here. The Pod is warmed no more, and a
   * warm hand-over still in flight settles first: the execution's token is the last one in place.
   */
  async putCredentials(execution: string, credentials: Credentials): Promise<OutboundView> {
    const pod = this.runs.get(execution)?.claim?.status?.sandbox?.name
    if (pod !== undefined) {
      this.bound.add(pod)
      await this.warm.get(pod)?.inflight
    }
    const response = await this.bridge(execution, 'PUT', '/credentials', JSON.stringify(credentials))
    const answer = (await response.json()) as OutboundView & { reason?: string }
    if (!response.ok) throw new Error('credentials_refused')
    const run = this.runs.get(execution)
    if (run !== undefined) {
      run.outbound = answer
      this.emit(run)
    }
    return answer
  }

  // ---------------------------------------------------------------- warming (docs/specs/credentials.md, "On Agora's side")

  /** Hands each ready Sandbox of a pool declaring base profiles a warm token, renewed at two thirds of its life. */
  private async warmPools(): Promise<void> {
    const pools = new Map((await this.pools()).map((pool) => [pool.name, pool]))
    for (const claim of this.claims.values()) if (claim.status?.sandbox?.name !== undefined) this.bound.add(claim.status.sandbox.name)
    const sandboxes = await this.options.kube.listSandboxes()
    const seen = new Set(sandboxes.map((sandbox) => sandbox.metadata.name))
    for (const name of this.warm.keys()) if (!seen.has(name)) this.warm.delete(name)
    for (const name of this.bound) if (!seen.has(name)) this.bound.delete(name)
    const ttl = this.options.warmTtlSeconds ?? 900
    for (const sandbox of sandboxes) {
      const name = sandbox.metadata.name
      const owner = sandbox.metadata.ownerReferences?.find((reference) => reference.kind === 'SandboxWarmPool')
      const pool = owner === undefined ? undefined : pools.get(owner.name)
      if (pool === undefined || pool.baseProfiles.length === 0 || this.bound.has(name)) continue
      if (sandbox.status?.conditions?.find((c) => c.type === 'Ready')?.status !== 'True' || !sandbox.status.serviceFQDN) continue
      const state = this.warm.get(name)
      if (state?.inflight || (state !== undefined && state.until - Date.now() > (ttl * 1000) / 3)) continue
      const inflight = this.handWarm(sandbox, pool.baseProfiles, ttl).finally(() => {
        const current = this.warm.get(name)
        if (current?.inflight === inflight) current.inflight = null
      })
      this.warm.set(name, { until: state?.until ?? 0, inflight })
    }
  }

  private async handWarm(sandbox: Sandbox, profiles: readonly string[], ttl: number): Promise<void> {
    const name = sandbox.metadata.name
    try {
      const credentials = await this.options.credentials!.mint({ label: `agora warm ${name}`, ttlSeconds: ttl, profiles })
      if (this.bound.has(name)) return
      const response = await fetch(`http://${this.addressOf(sandbox.status?.serviceFQDN ?? '', name)}/credentials`, {
        method: 'PUT',
        body: JSON.stringify(credentials),
        headers: { authorization: `Bearer ${mintBridgeToken(this.options.signingKey, name)}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return
      const state = this.warm.get(name)
      if (state !== undefined) state.until = Date.parse(credentials.expiresAt ?? '') || Date.now() + ttl * 1000
    } catch {
      // Tried again at the next look.
    }
  }

  // ---------------------------------------------------------------- catalogue

  async pools(): Promise<PoolView[]> {
    if (this.poolCache !== null && Date.now() - this.poolCache.at < 10_000) return this.poolCache.pools
    const pools: PoolView[] = []
    for (const pool of await this.options.kube.listPools(HARNESS_LABEL)) {
      const templateName = pool.spec?.sandboxTemplateRef?.name ?? ''
      const template = templateName === '' ? null : await this.options.kube.getTemplate(templateName)
      const containers = ((template?.spec as { podTemplate?: { spec?: { containers?: { image?: string }[] } } } | undefined)?.podTemplate?.spec?.containers) ?? []
      pools.push({
        name: pool.metadata.name,
        harness: pool.metadata.labels?.[HARNESS_LABEL] ?? '?',
        template: templateName,
        image: containers[0]?.image ?? null,
        replicas: pool.spec?.replicas ?? 0,
        readyReplicas: pool.status?.readyReplicas ?? 0,
        ...(() => {
          const declared = baseProfiles(pool.metadata.annotations?.[BASE_PROFILES_ANNOTATION])
          return { baseProfiles: declared.profiles, refusedProfile: declared.refused }
        })(),
        sessionConfig: sessionConfig(pool.metadata.annotations?.[SESSION_CONFIG_ANNOTATION]),
      })
    }
    this.poolCache = { at: Date.now(), pools }
    return pools
  }

  // ---------------------------------------------------------------- lab hooks (docs/specs/executions.md, "The lab")

  private byName(name: string): Run | undefined {
    return [...this.runs.values()].find((run) => run.target.claimName === name || run.target.execution === name)
  }

  lab = {
    /** Terminates Agora's connection, then reconnects after `pauseSeconds`. */
    dropBridge: (name: string, pauseSeconds = 0): CommandResult<string> => {
      const run = this.byName(name)
      if (run === undefined) return refused(`unknown execution: ${name}`, 404)
      if (run.connection === null || run.connection.closed) return refused('no bridge connection')
      if (!Number.isInteger(pauseSeconds) || pauseSeconds < 0 || pauseSeconds > 60) return refused('pauseSeconds must be 0 to 60', 400)
      run.reconnectAt = Date.now() + Math.max(pauseSeconds * 1000, this.options.reconnectMs ?? 2000)
      run.connection.ws.terminate()
      return { accepted: true, value: 'cut' }
    },
    probeAuth: async (name: string): Promise<CommandResult<{ case: string; info: number; acp: number }[]>> => {
      const run = this.byName(name)
      const podName = run?.claim?.status?.sandbox?.name
      if (run === undefined || podName === undefined) return refused('unknown execution or no Pod', 404)
      const cases: [string, Record<string, string>][] = [
        ['no token', {}],
        ['expired token', { authorization: `Bearer ${mintBridgeToken(this.options.signingKey, podName, { now: Date.now() - 120_000 })}` }],
        ['token for another sandbox', { authorization: `Bearer ${mintBridgeToken(this.options.signingKey, 'sbx-autre')}` }],
        ['token signed by another key', { authorization: `Bearer ${mintBridgeToken(this.foreignKey, podName)}` }],
        ['valid token (control)', { authorization: `Bearer ${this.token(run)}` }],
      ]
      const results: { case: string; info: number; acp: number }[] = []
      for (const [label, headers] of cases) {
        const info = (await fetch(`http://${this.address(run)}/info`, { headers, signal: AbortSignal.timeout(5000) })).status
        // A bare upgrade request: only the status line matters, the socket is never kept.
        const acp = await new Promise<number>((resolve) => {
          const socket = new WebSocket(`ws://${this.address(run)}/acp`, { headers })
          socket.on('unexpected-response', (_request, response) => {
            resolve(response.statusCode ?? 0)
            socket.terminate()
          })
          socket.on('open', () => {
            resolve(101)
            socket.terminate()
          })
          socket.on('error', () => resolve(0))
        })
        results.push({ case: label, info, acp })
      }
      // The control connection displaced Agora's; Agora reconnects on its own.
      return { accepted: true, value: results }
    },
  }

  // ---------------------------------------------------------------- views

  view(run: Run): ExecutionView {
    const claim = run.claim
    const ready = claim?.status?.conditions?.find((c) => c.type === 'Ready')
    const c = run.connection
    return {
      execution: run.target.execution,
      claimName: run.target.claimName,
      pool: run.target.pool,
      uid: claim?.metadata.uid ?? null,
      ready: ready?.status === 'True',
      reason: [ready?.reason ?? '', ready?.message ?? ''].filter((part) => part !== '').join(': '),
      ending: claim?.metadata.deletionTimestamp !== undefined,
      shutdownTime: claim?.spec?.lifecycle?.shutdownTime ?? null,
      pod: claim?.status?.sandbox?.name ?? null,
      podDetail: run.podDetail,
      launchType: run.launchType,
      bridge: c === null || c.closed ? 'none' : c.accepted ? 'connected' : 'connecting',
      instance: c?.instance ?? null,
      connection: c !== null && c.accepted && !c.closed ? c.id : null,
      pending: c === null || c.closed ? 0 : c.pending,
      held: run.held,
      outbound: run.outbound,
    }
  }

  views(): ExecutionView[] {
    return [...this.runs.values()].map((run) => this.view(run))
  }

  subscribe(listener: (view: ExecutionView) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(run: Run): void {
    if (this.runs.get(run.target.execution) !== run) return
    const view = this.view(run)
    for (const listener of this.listeners) listener(view)
  }
}
