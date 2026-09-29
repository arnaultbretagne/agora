// Agora's executions (docs/executions.md). It holds ONE connection per bridge, follows turns by
// watching the ACP traffic it relays, and re-arms each claim's deadline while a turn runs
// (docs/executions.md: min(now + lease, turn start + max turn)). It never deletes anything: the
// infrastructure destroys at the deadline, and the Pod pushes its anchor on the way out.
// Everything it must know after a restart is written on the claim itself.
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { WebSocket } from 'ws'
import type { AnchorMeta, AnchorStore } from './anchors.ts'
import { KubeError, WatchGone, type Claim, type KubeApi, type WatchEvent } from './kube.ts'
import { mintBridgeToken } from '@agora/harness-bridge/token'
import type { Bundle } from '@agora/harness-bridge/anchor'
import type { Credentials, OutboundView } from '@agora/harness-bridge/outbound'

export const MANAGED_BY = 'app.kubernetes.io/managed-by'
export const MANAGER = 'agora'
export const POOL_LABEL = 'agora.bretagne.dev/pool'
export const HARNESS_LABEL = 'agora.bretagne.dev/harness'
export const ANNOTATION = {
  requestId: 'agora.bretagne.dev/request-id',
  limits: 'agora.bretagne.dev/limits',
  restoreAnchor: 'agora.bretagne.dev/restore-anchor',
  restored: 'agora.bretagne.dev/restored',
  instance: 'agora.bretagne.dev/instance',
  sessionId: 'agora.bretagne.dev/session-id',
  turn: 'agora.bretagne.dev/turn',
  idleSince: 'agora.bretagne.dev/idle-since',
  stopped: 'agora.bretagne.dev/stopped',
} as const
const SELECTOR = `${MANAGED_BY}=${MANAGER}`
const RING_LIMIT = 2000
const HISTORY_LIMIT = 100
const LOG_LIMIT = 300
const TERMINAL_CLAIM_REASONS = new Set(['WarmPoolNotFound', 'EnvVarsInjectionRejected', 'VolumeClaimTemplatesRejected'])

export interface Limits {
  readonly leaseSeconds: number
  readonly turnCapSeconds: number
}

export const LIMIT_BOUNDS: Record<keyof Limits, readonly [number, number]> = {
  leaseSeconds: [60, 600],
  turnCapSeconds: [30, 3600],
}

export interface ManagerOptions {
  readonly kube: KubeApi
  readonly anchors: AnchorStore
  readonly signingKey: KeyObject
  readonly defaults: Limits
  readonly renewSeconds: number
  readonly maxActive: number
  readonly bridgePort: number
  /** Test seam: where to reach a sandbox's bridge. Defaults to its Service (`serviceFQDN`). */
  readonly bridgeAddress?: (serviceFQDN: string, podName: string) => string
  readonly tickMs?: number
  readonly log?: (message: string) => void
}

type Id = string | number

interface Turn {
  readonly startedAt: string
  readonly requestId: Id
  readonly seq: number
  readonly sessionId: string | null
}

interface Hello {
  readonly instance: string
  readonly pod: string
  readonly workspace: string
  readonly initialize: { agentInfo?: { name?: string; version?: string }; agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } } } | null
  readonly adapter: { alive: boolean; exitCode: number | null; signal: string | null }
  readonly lastSeq: number
  readonly gap: boolean
  readonly replayFrom: number | null
  readonly outbound?: OutboundView
}

export interface Ending {
  readonly name: string
  readonly pool: string
  /** Why the deadline was reached: stop asked, turn limit, end of lease after a turn… */
  readonly reason: string
  readonly anchor: AnchorMeta | null
  readonly anchorError: string | null
  readonly at: string
}

export interface LogEntry {
  readonly at: string
  readonly execution: string | null
  readonly message: string
}

interface SandboxRecord {
  readonly name: string
  readonly uid: string
  readonly pool: string
  readonly requestId: string
  readonly createdAt: number
  readonly limits: Limits
  readonly restoreAnchor: string | null
  // From the claim, refreshed on every event.
  ready: boolean
  readyReason: string
  readyMessage: string
  podName: string | null
  serviceFQDN: string | null
  shutdownTime: string | null
  ending: boolean
  // Written on the claim by Agora; read from it only once, when the record is first built.
  instance: string | null
  sessionId: string | null
  turn: Turn | null
  idleSince: string | null
  restored: boolean
  stopped: { reason: string; at: string } | null
  // Live, in this process only.
  launchType: string | null
  podDetail: string | null
  bridge: WebSocket | null
  bridgeState: 'aucune' | 'connexion' | 'connectée'
  reconnectTimer: NodeJS.Timeout | null
  hello: Hello | null
  lastSeq: number
  ring: { seq: number; acp: string }[]
  consumer: WebSocket | null
  consumerPending: Map<string, { method: string; sessionId: string | null }>
  permissions: Set<string>
  ownPending: Map<string, (message: AcpMessage) => void>
  admitting: boolean
  restoring: boolean
  lastRenewedAt: number
  renewals: number
  lastTurn: { outcome: string; endedAt: string } | null
  anchor: AnchorMeta | null
  anchorError: string | null
  /** What the bridge says of its way out (docs/credentials.md) — never the token. */
  outbound: OutboundView | null
  error: string | null
  lost: string | null
  uncertain: string | null
}

interface AcpMessage {
  readonly id?: Id | null
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: Record<string, unknown> | null
  readonly error?: { code?: number; message?: string }
}

export type ManagerEvent =
  | { readonly type: 'execution'; readonly execution: ExecutionView }
  | { readonly type: 'ended'; readonly ending: Ending }
  | { readonly type: 'anchor'; readonly anchor: AnchorMeta }
  | { readonly type: 'log'; readonly entry: LogEntry }

export type ExecutionView = ReturnType<ExecutionManager['view']>

export interface PoolView {
  readonly name: string
  readonly harness: string
  readonly template: string
  readonly image: string | null
  readonly replicas: number
  readonly readyReplicas: number
}

export type CommandResult<T> = { readonly accepted: true; readonly value: T } | { readonly accepted: false; readonly reason: string; readonly status: number }

function refused(reason: string, status = 409): { accepted: false; reason: string; status: number } {
  return { accepted: false, reason, status }
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function idKey(id: Id): string {
  return typeof id === 'number' ? `n:${String(id)}` : `s:${id}`
}

export function claimName(requestId: string): string {
  return `sbx-${createHash('sha256').update(requestId).digest('hex').slice(0, 10)}`
}

export class ExecutionManager {
  private readonly options: ManagerOptions
  private readonly records = new Map<string, SandboxRecord>()
  private readonly gone = new Set<string>()
  private readonly history: Ending[] = []
  private readonly logs: LogEntry[] = []
  private readonly listeners = new Set<(event: ManagerEvent) => void>()
  private readonly foreignKey = generateKeyPairSync('ed25519').privateKey
  private poolCache: { at: number; pools: PoolView[] } | null = null
  private ownCounter = 0
  private tickTimer: NodeJS.Timeout | null = null
  private watchAbort: AbortController | null = null
  private stopped = false

  constructor(options: ManagerOptions) {
    this.options = options
  }

  // ---------------------------------------------------------------- lifecycle of the manager

  async start(): Promise<void> {
    const { items, resourceVersion } = await this.options.kube.listClaims(SELECTOR)
    for (const claim of items) this.upsert(claim)
    this.log(null, `démarrage : ${String(items.length)} claim(s) retrouvé(s)`)
    void this.watchLoop(resourceVersion)
    this.tickTimer = setInterval(() => void this.tick(), this.options.tickMs ?? 5000)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.tickTimer !== null) clearInterval(this.tickTimer)
    this.watchAbort?.abort()
    for (const record of this.records.values()) {
      if (record.reconnectTimer !== null) clearTimeout(record.reconnectTimer)
      record.bridge?.terminate()
      record.consumer?.close(1001, 'arrêt d’Agora')
    }
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
          this.log(null, 'watch expiré : nouveau LIST')
          try {
            const list = await this.options.kube.listClaims(SELECTOR)
            version = list.resourceVersion
            const seen = new Set(list.items.map((claim) => claim.metadata.name))
            for (const claim of list.items) this.upsert(claim)
            for (const record of [...this.records.values()]) if (!seen.has(record.name)) this.claimGone(record)
          } catch (listError) {
            this.log(null, `LIST impossible : ${String(listError)}`)
          }
        } else {
          this.log(null, `watch interrompu : ${error instanceof Error ? error.message : String(error)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  private onWatchEvent(event: WatchEvent): string | undefined {
    const version = event.object.metadata?.resourceVersion
    if (event.type === 'BOOKMARK') return version
    if (event.type === 'DELETED') {
      const record = this.records.get(event.object.metadata.name)
      if (record !== undefined && record.uid === event.object.metadata.uid) this.claimGone(record)
      return version
    }
    this.upsert(event.object)
    return version
  }

  // ---------------------------------------------------------------- claims → records

  private upsert(claim: Claim): void {
    const { name, uid } = claim.metadata
    if (this.gone.has(uid)) return
    let record = this.records.get(name)
    if (record !== undefined && record.uid !== uid) {
      this.claimGone(record)
      record = undefined
    }
    if (record === undefined) {
      record = this.newRecord(claim)
      this.records.set(name, record)
    }
    const ready = claim.status?.conditions?.find((condition) => condition.type === 'Ready')
    record.ready = ready?.status === 'True'
    record.readyReason = ready?.reason ?? ''
    record.readyMessage = ready?.message ?? ''
    record.podName = claim.status?.sandbox?.name ?? record.podName
    record.serviceFQDN = claim.status?.sandbox?.serviceFQDN || record.serviceFQDN
    record.shutdownTime = claim.spec?.lifecycle?.shutdownTime ?? null
    if (claim.metadata.deletionTimestamp !== undefined && !record.ending) {
      record.ending = true
      this.log(record.name, `l'infrastructure supprime le claim (${this.endReason(record)}) : anchor attendu du Pod`)
    }
    if (!record.ready && !record.ending && TERMINAL_CLAIM_REASONS.has(record.readyReason) && record.error === null) {
      record.error = `${record.readyReason} : ${record.readyMessage}`
      this.log(record.name, `le claim n'aboutira pas : ${record.error}`)
    }
    if (record.launchType === null && record.podName !== null) void this.readLaunchType(record)
    this.ensureBridge(record)
    this.emitRecord(record)
  }

  /** Warm or cold, as Agent Sandbox labels the Sandbox it bound (`agents.x-k8s.io/launch-type`). */
  private async readLaunchType(record: SandboxRecord): Promise<void> {
    try {
      const sandbox = await this.options.kube.getSandbox(record.podName ?? '')
      const labels = (sandbox?.metadata as { labels?: Record<string, string> } | undefined)?.labels
      const launchType = labels?.['agents.x-k8s.io/launch-type'] ?? null
      if (launchType !== null && record.launchType === null) {
        record.launchType = launchType
        this.emitRecord(record)
      }
    } catch {
      // The tick tries again.
    }
  }

  private newRecord(claim: Claim): SandboxRecord {
    const annotations = claim.metadata.annotations ?? {}
    const parse = <T>(value: string | undefined): T | null => {
      if (value === undefined) return null
      try {
        return JSON.parse(value) as T
      } catch {
        return null
      }
    }
    const limits = parse<Partial<Limits>>(annotations[ANNOTATION.limits]) ?? {}
    return {
      name: claim.metadata.name,
      uid: claim.metadata.uid,
      pool: claim.metadata.labels?.[POOL_LABEL] ?? claim.spec?.warmPoolRef?.name ?? '?',
      requestId: annotations[ANNOTATION.requestId] ?? '',
      createdAt: Date.parse(claim.metadata.creationTimestamp ?? new Date().toISOString()),
      limits: {
        leaseSeconds: limits.leaseSeconds ?? this.options.defaults.leaseSeconds,
        turnCapSeconds: limits.turnCapSeconds ?? this.options.defaults.turnCapSeconds,
      },
      restoreAnchor: annotations[ANNOTATION.restoreAnchor] ?? null,
      ready: false,
      readyReason: '',
      readyMessage: '',
      podName: null,
      serviceFQDN: null,
      shutdownTime: null,
      ending: false,
      instance: annotations[ANNOTATION.instance] ?? null,
      sessionId: annotations[ANNOTATION.sessionId] ?? null,
      turn: parse<Turn>(annotations[ANNOTATION.turn]),
      idleSince: annotations[ANNOTATION.idleSince] ?? null,
      restored: annotations[ANNOTATION.restored] !== undefined,
      stopped: parse<{ reason: string; at: string }>(annotations[ANNOTATION.stopped]),
      launchType: null,
      podDetail: null,
      bridge: null,
      bridgeState: 'aucune',
      reconnectTimer: null,
      hello: null,
      lastSeq: 0,
      ring: [],
      consumer: null,
      consumerPending: new Map(),
      permissions: new Set(),
      ownPending: new Map(),
      admitting: false,
      restoring: false,
      lastRenewedAt: 0,
      renewals: 0,
      lastTurn: null,
      anchor: null,
      anchorError: null,
      outbound: null,
      error: null,
      lost: null,
      uncertain: null,
    }
  }

  // ---------------------------------------------------------------- the bridge connection

  private address(record: SandboxRecord): string {
    const service = record.serviceFQDN ?? ''
    return this.options.bridgeAddress?.(service, record.podName ?? '') ?? `${service}:${String(this.options.bridgePort)}`
  }

  private token(record: SandboxRecord): string {
    return mintBridgeToken(this.options.signingKey, record.podName ?? '')
  }

  private bridgeOpen(record: SandboxRecord): boolean {
    return record.bridge !== null && record.bridge.readyState === WebSocket.OPEN && record.hello !== null
  }

  private ensureBridge(record: SandboxRecord): void {
    if (this.stopped || !record.ready || record.serviceFQDN === null || record.podName === null) return
    if (record.bridge !== null || record.reconnectTimer !== null || record.ending || record.lost !== null) return
    // In this process's lifetime, pick up exactly after the last frame seen. After a restart, the
    // position noted at the start of the turn in flight — or live, when no turn is in flight.
    const after = record.lastSeq > 0 ? record.lastSeq : record.turn !== null ? record.turn.seq : null
    const url = `ws://${this.address(record)}/acp${after === null ? '' : `?after=${String(after)}`}`
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.token(record)}` } })
    record.bridge = socket
    record.bridgeState = 'connexion'
    socket.on('message', (data) => this.onBridgeMessage(record, socket, data.toString()))
    socket.on('close', (code, reason) => this.onBridgeClose(record, socket, code, reason.toString()))
    socket.on('error', (error) => this.log(record.name, `bridge : ${error.message}`))
    this.emitRecord(record)
  }

  private onBridgeClose(record: SandboxRecord, socket: WebSocket, code: number, reason: string): void {
    if (record.bridge !== socket) return
    record.bridge = null
    record.bridgeState = 'aucune'
    if (this.records.get(record.name) !== record || this.stopped) return
    this.log(record.name, `connexion au bridge fermée (${String(code)}${reason === '' ? '' : ` ${reason}`})`)
    if (code === 1011) this.lose(record, "l'adaptateur est mort")
    else if (!record.ending && record.lost === null) {
      record.reconnectTimer = setTimeout(() => {
        record.reconnectTimer = null
        this.ensureBridge(record)
      }, 2000)
    }
    this.emitRecord(record)
  }

  /** No live context any more: the deadline is no longer re-armed (docs/executions.md, "L'échéance"). */
  private lose(record: SandboxRecord, reason: string): void {
    if (record.lost !== null) return
    record.lost = reason
    if (record.turn !== null) record.uncertain = 'la fin du tour est partie avec le processus'
    this.log(record.name, `perdu : ${reason} ; plus de renouvellement, fin à l'échéance ${String(record.shutdownTime)}`)
    this.emitRecord(record)
  }

  private onBridgeMessage(record: SandboxRecord, socket: WebSocket, text: string): void {
    if (record.bridge !== socket) return
    let message: { hello?: Hello; seq?: number; acp?: string; terminating?: unknown }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      return
    }
    if (message.hello !== undefined) this.onHello(record, message.hello)
    else if (typeof message.seq === 'number' && typeof message.acp === 'string') this.onFrame(record, message.seq, message.acp)
    else if (message.terminating !== undefined) {
      // The Pod is being destroyed: no reconnection, its anchor is on the way.
      record.ending = true
      this.log(record.name, 'le Pod a reçu SIGTERM : il pousse son anchor')
      this.toConsumer(record, { event: { type: 'terminating' } })
    }
  }

  private onHello(record: SandboxRecord, hello: Hello): void {
    record.hello = hello
    record.outbound = hello.outbound ?? null
    record.bridgeState = 'connectée'
    if (record.instance === null) {
      record.instance = hello.instance
      record.idleSince ??= new Date().toISOString()
      void this.annotate(record, { [ANNOTATION.instance]: hello.instance, [ANNOTATION.idleSince]: record.idleSince }).catch(() => {})
      this.log(record.name, `bridge joint : instance ${hello.instance}, ${String(hello.initialize?.agentInfo?.name)}@${String(hello.initialize?.agentInfo?.version)}`)
    } else if (record.instance !== hello.instance) {
      record.bridge?.close(1000, 'processus remplacé')
      this.lose(record, `processus remplacé : instance ${hello.instance}, attendue ${record.instance}`)
      return
    } else {
      this.log(record.name, `bridge rejoint${hello.replayFrom === null ? '' : `, rejeu depuis ${String(hello.replayFrom)}`}${hello.gap ? ', AVEC UN TROU' : ''}`)
    }
    if (hello.gap && record.turn !== null) record.uncertain = 'des trames du tour ont été perdues (trou au rejeu)'
    if (!hello.adapter.alive) {
      this.lose(record, `l'adaptateur est mort (code ${String(hello.adapter.exitCode)})`)
      return
    }
    this.toConsumer(record, { event: { type: 'bridge', instance: hello.instance, gap: hello.gap, replayFrom: hello.replayFrom } })
    if (record.restoreAnchor !== null && !record.restored && !record.restoring && record.error === null) void this.restore(record)
    this.emitRecord(record)
  }

  private onFrame(record: SandboxRecord, seq: number, line: string): void {
    if (seq <= record.lastSeq) return
    record.lastSeq = seq
    record.ring.push({ seq, acp: line })
    if (record.ring.length > RING_LIMIT) record.ring.splice(0, record.ring.length - RING_LIMIT)
    this.toConsumer(record, { seq, acp: line })

    let message: AcpMessage
    try {
      message = JSON.parse(line) as AcpMessage
    } catch {
      return
    }
    if (message.method === undefined && message.id !== undefined && message.id !== null) {
      const key = idKey(message.id)
      const own = record.ownPending.get(key)
      if (own !== undefined) {
        record.ownPending.delete(key)
        own(message)
      }
      if (record.turn !== null && idKey(record.turn.requestId) === key) void this.endTurn(record, message)
      const pending = record.consumerPending.get(key)
      if (pending !== undefined) {
        record.consumerPending.delete(key)
        const sessionId = pending.method === 'session/new' ? (message.result?.sessionId as string | undefined) ?? null : pending.sessionId
        if (message.error === undefined && sessionId !== null) this.setSession(record, sessionId)
      }
      return
    }
    if (message.method === 'session/request_permission' && message.id !== undefined && message.id !== null) {
      record.permissions.add(idKey(message.id))
      this.emitRecord(record)
    }
  }

  /** A confirmed end: 10 more minutes without renewal (docs/executions.md, "Entre deux tours"). */
  private async endTurn(record: SandboxRecord, message: AcpMessage): Promise<void> {
    const outcome = message.error !== undefined ? `erreur : ${String(message.error.message)}` : `fin : ${String(message.result?.stopReason)}`
    record.turn = null
    record.uncertain = null
    record.permissions.clear()
    record.idleSince = new Date().toISOString()
    record.lastTurn = { outcome, endedAt: record.idleSince }
    const grant = record.stopped === null && record.lost === null && !record.ending
    const shutdownTime = iso(Date.now() + record.limits.leaseSeconds * 1000)
    this.log(record.name, `tour clos (${outcome})${grant ? `, échéance ${shutdownTime} sans renouvellement` : ''}`)
    this.emitRecord(record)
    if (record.outbound !== null) void this.refreshOutbound(record)
    try {
      await this.annotate(record, { [ANNOTATION.turn]: null, [ANNOTATION.idleSince]: record.idleSince }, grant ? { shutdownTime } : undefined)
      if (grant) {
        record.shutdownTime = shutdownTime
        this.emitRecord(record)
      }
    } catch {
      // Logged by annotate; the deadline already granted stands.
    }
  }

  private setSession(record: SandboxRecord, sessionId: string): void {
    if (record.sessionId === sessionId) return
    record.sessionId = sessionId
    void this.annotate(record, { [ANNOTATION.sessionId]: sessionId }).catch(() => {})
    this.log(record.name, `session ${sessionId}`)
    this.emitRecord(record)
  }

  private async annotate(record: SandboxRecord, annotations: Record<string, string | null>, lifecycle?: { shutdownTime: string }): Promise<void> {
    try {
      await this.options.kube.patchClaim(record.name, {
        metadata: { uid: record.uid, annotations },
        ...(lifecycle === undefined ? {} : { spec: { lifecycle } }),
      })
    } catch (error) {
      this.log(record.name, `PATCH refusé : ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  private ownRequest(record: SandboxRecord, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<AcpMessage> {
    const id = `agora-${String(++this.ownCounter)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.ownPending.delete(idKey(id))
        reject(new Error(`${method} sans réponse après ${String(timeoutMs)} ms`))
      }, timeoutMs)
      record.ownPending.set(idKey(id), (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      record.bridge?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  // ---------------------------------------------------------------- restoration

  private async restore(record: SandboxRecord): Promise<void> {
    const anchorId = record.restoreAnchor
    if (anchorId === null) return
    record.restoring = true
    this.emitRecord(record)
    try {
      const meta = await this.options.anchors.meta(anchorId)
      const bundle = await this.options.anchors.bundle(anchorId)
      if (meta === null || bundle === null) throw new Error(`anchor ${anchorId} introuvable`)
      if (meta.sessionId === null) throw new Error(`l'anchor ${anchorId} ne connaît pas sa session`)
      const response = await fetch(`http://${this.address(record)}/anchor`, {
        method: 'PUT',
        body: bundle as unknown as BodyInit,
        headers: { authorization: `Bearer ${this.token(record)}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      const placement = (await response.json()) as { files?: unknown[]; reason?: string }
      if (!response.ok) throw new Error(`dépôt refusé (${String(response.status)}) : ${String(placement.reason)}`)
      this.log(record.name, `anchor ${anchorId} déposé : ${String(placement.files?.length)} fichier(s)`)

      const capabilities = record.hello?.initialize?.agentCapabilities
      const method = capabilities?.sessionCapabilities?.resume != null ? 'session/resume' : capabilities?.loadSession === true ? 'session/load' : null
      if (method === null) throw new Error("l'agent n'annonce ni session/resume ni session/load")
      const answer = await this.ownRequest(record, method, { sessionId: meta.sessionId, cwd: record.hello?.workspace, mcpServers: [] }, 60_000)
      if (answer.error !== undefined) throw new Error(`${method} refusé : ${String(answer.error.message)}`)

      record.restored = true
      record.sessionId = meta.sessionId
      await this.annotate(record, { [ANNOTATION.restored]: new Date().toISOString(), [ANNOTATION.sessionId]: meta.sessionId })
      this.log(record.name, `reprise par ${method} de la session ${meta.sessionId}`)
    } catch (error) {
      record.error = `restauration impossible : ${error instanceof Error ? error.message : String(error)}`
      this.log(record.name, record.error)
    } finally {
      record.restoring = false
      this.emitRecord(record)
    }
  }

  // ---------------------------------------------------------------- credentials (docs/credentials.md)

  /** Hands the bridge the proxy to go out through and its token; the token is kept nowhere here. */
  async attachCredentials(name: string, credentials: Credentials): Promise<CommandResult<OutboundView>> {
    const record = this.records.get(name)
    if (record === undefined) return refused(`exécution inconnue : ${name}`, 404)
    if (record.ending) return refused("l'infrastructure détruit déjà ce sandbox")
    if (!record.ready || record.serviceFQDN === null || record.podName === null) return refused('sandbox pas encore prêt')
    try {
      const response = await fetch(`http://${this.address(record)}/credentials`, {
        method: 'PUT',
        body: JSON.stringify(credentials),
        headers: { authorization: `Bearer ${this.token(record)}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      const answer = (await response.json()) as OutboundView & { reason?: string }
      if (!response.ok) return refused(`le bridge a refusé (${String(response.status)}) : ${String(answer.reason)}`, 502)
      record.outbound = answer
      this.log(name, `credential branché : ${credentials.proxy}${credentials.expiresAt === null ? '' : `, valable jusqu'à ${credentials.expiresAt}`}`)
      this.emitRecord(record)
      return { accepted: true, value: answer }
    } catch (error) {
      return refused(`bridge injoignable : ${error instanceof Error ? error.message : String(error)}`, 502)
    }
  }

  /** After a turn, what went out through the bridge (tunnels, the proxy's answers). */
  private async refreshOutbound(record: SandboxRecord): Promise<void> {
    try {
      const response = await fetch(`http://${this.address(record)}/info`, { headers: { authorization: `Bearer ${this.token(record)}` }, signal: AbortSignal.timeout(5000) })
      if (!response.ok) return
      record.outbound = ((await response.json()) as { outbound?: OutboundView }).outbound ?? record.outbound
      this.emitRecord(record)
    } catch {
      // Shown again at the next turn.
    }
  }

  // ---------------------------------------------------------------- the consumer relay

  attachConsumer(name: string, socket: WebSocket, after: number | null): void {
    const record = this.records.get(name)
    if (record === undefined) {
      socket.close(4404, 'exécution inconnue')
      return
    }
    if (record.consumer !== null) record.consumer.close(4000, 'remplacé par un consommateur plus récent')
    record.consumer = socket
    socket.send(JSON.stringify({ event: { type: 'attached', execution: this.view(record), initialize: record.hello?.initialize ?? null } }))
    if (after !== null) {
      const replay = record.ring.filter((frame) => frame.seq > after)
      const oldest = record.ring[0]?.seq ?? record.lastSeq + 1
      const gap = after < record.lastSeq && after + 1 < oldest
      socket.send(JSON.stringify({ event: { type: 'replay', from: replay[0]?.seq ?? null, count: replay.length, gap } }))
      for (const frame of replay) socket.send(JSON.stringify(frame))
    }
    socket.on('message', (data, isBinary) => {
      if (!isBinary) void this.onConsumerMessage(record, socket, data.toString())
    })
    socket.on('close', () => {
      if (record.consumer === socket) {
        record.consumer = null
        this.emitRecord(record)
      }
    })
    socket.on('error', () => {})
    this.emitRecord(record)
  }

  private toConsumer(record: SandboxRecord, message: unknown): void {
    if (record.consumer !== null && record.consumer.readyState === WebSocket.OPEN) record.consumer.send(JSON.stringify(message))
  }

  private answer(record: SandboxRecord, socket: WebSocket, id: Id, payload: { result?: unknown; error?: { code: number; message: string } }): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ local: JSON.stringify({ jsonrpc: '2.0', id, ...payload }) }))
    if (payload.error !== undefined) this.log(record.name, `requête ${JSON.stringify(id)} refusée : ${payload.error.message}`)
  }

  private async onConsumerMessage(record: SandboxRecord, socket: WebSocket, text: string): Promise<void> {
    let message: AcpMessage
    try {
      message = JSON.parse(text) as AcpMessage
    } catch {
      socket.send(JSON.stringify({ event: { type: 'error', message: 'JSON invalide' } }))
      return
    }
    const id = message.id
    const isRequest = message.method !== undefined && id !== undefined && id !== null
    if (isRequest && typeof id === 'string' && id.startsWith('agora-')) {
      return this.answer(record, socket, id, { error: { code: -32600, message: 'les identifiants agora-… sont réservés à Agora' } })
    }
    if (message.method === 'initialize' && isRequest) {
      if (record.hello?.initialize == null) return this.answer(record, socket, id, { error: { code: -32000, message: 'refusé : bridge pas encore joint' } })
      return this.answer(record, socket, id, { result: record.hello.initialize })
    }
    if (!this.bridgeOpen(record)) {
      if (isRequest) return this.answer(record, socket, id, { error: { code: -32000, message: `refusé : bridge non connecté (${this.state(record).state})` } })
      socket.send(JSON.stringify({ event: { type: 'error', message: 'bridge non connecté : message perdu' } }))
      return
    }
    if (message.method === 'session/prompt' && isRequest) return this.admitPrompt(record, socket, message, id, text)
    if (isRequest && (message.method === 'session/new' || message.method === 'session/load' || message.method === 'session/resume')) {
      record.consumerPending.set(idKey(id), { method: message.method, sessionId: (message.params?.sessionId as string | undefined) ?? null })
    }
    if (message.method === undefined && id !== undefined && id !== null && record.permissions.delete(idKey(id))) this.emitRecord(record)
    record.bridge?.send(text)
  }

  private async admitPrompt(record: SandboxRecord, socket: WebSocket, message: AcpMessage, id: Id, text: string): Promise<void> {
    const { state } = this.state(record)
    const refusal =
      record.admitting ? "un prompt est déjà en cours d'admission"
      : record.turn !== null ? 'un tour est déjà en cours'
      : state !== 'prêt' ? `sandbox ${state}`
      : null
    if (refusal !== null) return this.answer(record, socket, id, { error: { code: -32000, message: `refusé : ${refusal}` } })

    record.admitting = true
    const now = Date.now()
    const turn: Turn = { startedAt: new Date(now).toISOString(), requestId: id, seq: record.lastSeq, sessionId: (message.params?.sessionId as string | undefined) ?? null }
    const shutdownTime = iso(Math.min(now + record.limits.leaseSeconds * 1000, now + record.limits.turnCapSeconds * 1000))
    try {
      // One PATCH: the turn is written and its deadline accepted before the prompt leaves.
      await this.annotate(record, { [ANNOTATION.turn]: JSON.stringify(turn) }, { shutdownTime })
    } catch (error) {
      record.admitting = false
      return this.answer(record, socket, id, { error: { code: -32000, message: `refusé : échéance non acceptée (${error instanceof Error ? error.message : String(error)})` } })
    }
    record.admitting = false
    if (!this.bridgeOpen(record) || record.stopped !== null) {
      void this.annotate(record, { [ANNOTATION.turn]: null }).catch(() => {})
      return this.answer(record, socket, id, { error: { code: -32000, message: 'refusé : bridge perdu ou arrêt pendant l’admission' } })
    }
    record.turn = turn
    record.shutdownTime = shutdownTime
    record.lastRenewedAt = now
    record.renewals += 1
    record.uncertain = null
    record.bridge?.send(text)
    this.log(record.name, `tour ouvert (requête ${JSON.stringify(id)}, position ${String(turn.seq)}), échéance ${shutdownTime}`)
    this.emitRecord(record)
  }

  // ---------------------------------------------------------------- the deadline

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const record of [...this.records.values()]) {
      try {
        // Every minute (docs/executions.md); a lease shorter than three minutes, possible in the lab,
        // is re-armed three times per lease so the renewal never races the deadline.
        const every = Math.min(this.options.renewSeconds, record.limits.leaseSeconds / 3) * 1000
        if (this.renews(record) && now - record.lastRenewedAt >= every) await this.renew(record, now)
        if (!record.ready && !record.ending && record.podName !== null) await this.diagnose(record)
        if (record.launchType === null && record.podName !== null) await this.readLaunchType(record)
      } catch (error) {
        this.log(record.name, `tick : ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Re-armed only during a turn, and never once stopped, lost or already being destroyed. */
  private renews(record: SandboxRecord): boolean {
    return record.turn !== null && record.stopped === null && record.lost === null && !record.ending
  }

  private async renew(record: SandboxRecord, now: number): Promise<void> {
    const turn = record.turn
    if (turn === null) return
    const shutdownTime = iso(Math.min(now + record.limits.leaseSeconds * 1000, Date.parse(turn.startedAt) + record.limits.turnCapSeconds * 1000))
    if (shutdownTime === record.shutdownTime) return
    try {
      await this.options.kube.patchClaim(record.name, { metadata: { uid: record.uid }, spec: { lifecycle: { shutdownTime } } })
      record.shutdownTime = shutdownTime
      record.lastRenewedAt = now
      record.renewals += 1
      this.emitRecord(record)
    } catch (error) {
      if (error instanceof KubeError && error.status === 404) return
      this.log(record.name, `renouvellement refusé : ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async diagnose(record: SandboxRecord): Promise<void> {
    const pod = await this.options.kube.getPod(record.podName ?? '')
    const status = pod?.status as { phase?: string; containerStatuses?: { state?: Record<string, { reason?: string; message?: string }> }[]; conditions?: { type: string; status: string; reason?: string; message?: string }[] } | undefined
    const waiting = status?.containerStatuses?.[0]?.state?.waiting ?? status?.containerStatuses?.[0]?.state?.terminated
    const unscheduled = status?.conditions?.find((condition) => condition.type === 'PodScheduled' && condition.status === 'False')
    const detail = waiting !== undefined ? `${String(waiting.reason)}${waiting.message === undefined ? '' : ` : ${waiting.message}`}` : unscheduled !== undefined ? `${String(unscheduled.reason)} : ${String(unscheduled.message)}` : status?.phase ?? null
    if (detail !== record.podDetail) {
      record.podDetail = detail
      this.emitRecord(record)
    }
  }

  private endReason(record: SandboxRecord): string {
    if (record.stopped !== null) return record.stopped.reason
    if (record.lost !== null) return `perdu : ${record.lost}`
    if (record.turn !== null) return 'tour en cours à l’échéance (limite du tour ou fin non vue)'
    return 'échéance après le dernier tour'
  }

  // ---------------------------------------------------------------- the anchor pushed by the Pod

  /** docs/executions.md, "La réception d'un anchor": the Pod is already authenticated by TokenReview. */
  async receiveAnchor(podName: string, bundle: Bundle, raw: Uint8Array): Promise<CommandResult<{ anchorId: string | null }>> {
    const record = [...this.records.values()].find((candidate) => candidate.podName === podName)
    if (record === undefined) return refused(`aucun claim connu pour le Pod ${podName}`, 404)
    const files = bundle.files.map((file) => ({ path: file.path, byteLength: Buffer.from(file.content, 'base64').byteLength }))
    if (files.length === 0) {
      record.anchorError = bundle.error ?? 'aucun fichier natif (pas de session écrite)'
      this.log(record.name, `anchor vide reçu : ${record.anchorError}`)
    } else {
      const anchor = await this.options.anchors.save(
        {
          harness: bundle.harness,
          pool: record.pool,
          format: bundle.format,
          sessionId: record.sessionId,
          files,
          byteLength: files.reduce((total, file) => total + file.byteLength, 0),
          stable: bundle.stable,
          execution: record.name,
          reason: this.endReason(record),
        },
        raw,
      )
      record.anchor = anchor
      record.anchorError = null
      this.log(record.name, `anchor ${anchor.id} reçu du Pod : ${String(files.length)} fichier(s), ${String(anchor.byteLength)} octets${bundle.stable ? '' : ', NON stabilisé'}`)
      this.emit({ type: 'anchor', anchor })
    }
    this.finish(record)
    return { accepted: true, value: { anchorId: record.anchor?.id ?? null } }
  }

  /** The claim is gone from Kubernetes: whatever was received is all there will be. */
  private claimGone(record: SandboxRecord): void {
    if (record.anchor === null && record.anchorError === null) record.anchorError = 'aucun anchor reçu avant la disparition du claim'
    this.finish(record)
  }

  private finish(record: SandboxRecord): Ending {
    const ending: Ending = { name: record.name, pool: record.pool, reason: this.endReason(record), anchor: record.anchor, anchorError: record.anchorError, at: new Date().toISOString() }
    if (this.records.get(record.name) === record) this.records.delete(record.name)
    if (this.gone.has(record.uid)) return ending
    this.gone.add(record.uid)
    if (record.reconnectTimer !== null) clearTimeout(record.reconnectTimer)
    record.bridge?.close(1000, 'fin du sandbox')
    record.bridge = null
    record.consumer?.close(4001, `exécution terminée : ${ending.reason}`)
    for (const [, resolve] of record.ownPending) resolve({ error: { message: 'exécution terminée' } })
    this.history.unshift(ending)
    this.history.splice(HISTORY_LIMIT)
    this.log(record.name, `terminé (${ending.reason}) ; ${ending.anchor === null ? `sans anchor : ${String(ending.anchorError)}` : `anchor ${ending.anchor.id}`}`)
    this.emit({ type: 'ended', ending })
    return ending
  }

  // ---------------------------------------------------------------- commands

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
      })
    }
    this.poolCache = { at: Date.now(), pools }
    return pools
  }

  async create(input: { requestId?: unknown; pool?: unknown; anchorId?: unknown; limits?: Partial<Record<keyof Limits, unknown>> }): Promise<CommandResult<{ name: string; existing: boolean }>> {
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : ''
    if (requestId === '' || requestId.length > 200) return refused('identifiant de demande manquant ou trop long', 400)
    const poolName = typeof input.pool === 'string' ? input.pool : ''
    const name = claimName(requestId)

    const known = this.records.get(name)
    if (known !== undefined) {
      return known.requestId === requestId ? { accepted: true, value: { name, existing: true } } : refused(`le nom ${name} est déjà pris par une autre demande`)
    }

    this.poolCache = null
    const pool = (await this.pools()).find((candidate) => candidate.name === poolName)
    if (pool === undefined) return refused(`pool hors catalogue : ${poolName}`, 400)

    const limits: Record<string, number> = { ...this.options.defaults }
    for (const key of Object.keys(LIMIT_BOUNDS) as (keyof Limits)[]) {
      const raw = input.limits?.[key]
      if (raw === undefined || raw === null || raw === '') continue
      const value = Number(raw)
      const [min, max] = LIMIT_BOUNDS[key]
      if (!Number.isInteger(value) || value < min || value > max) return refused(`${key} hors bornes : ${String(raw)} (de ${String(min)} à ${String(max)})`, 400)
      limits[key] = value
    }

    let anchorId: string | null = null
    if (typeof input.anchorId === 'string' && input.anchorId !== '') {
      const meta = await this.options.anchors.meta(input.anchorId)
      if (meta === null) return refused(`anchor inconnu : ${input.anchorId}`, 400)
      if (meta.harness !== pool.harness) return refused(`anchor du harness ${meta.harness}, pool du harness ${pool.harness}`, 400)
      anchorId = meta.id
    }

    const active = [...this.records.values()].filter((record) => !record.ending).length
    if (active >= this.options.maxActive) return refused(`quota atteint : ${String(active)} exécutions actives sur ${String(this.options.maxActive)}`, 429)

    const now = Date.now()
    const claim = {
      apiVersion: 'extensions.agents.x-k8s.io/v1beta1',
      kind: 'SandboxClaim',
      metadata: {
        name,
        labels: { [MANAGED_BY]: MANAGER, [POOL_LABEL]: pool.name },
        annotations: {
          [ANNOTATION.requestId]: requestId,
          [ANNOTATION.limits]: JSON.stringify(limits),
          ...(anchorId === null ? {} : { [ANNOTATION.restoreAnchor]: anchorId }),
        },
      },
      spec: {
        warmPoolRef: { name: pool.name },
        lifecycle: { shutdownTime: iso(now + (limits.leaseSeconds ?? this.options.defaults.leaseSeconds) * 1000), shutdownPolicy: 'DeleteForeground' },
      },
    }
    try {
      const created = await this.options.kube.createClaim(claim)
      this.upsert(created)
      this.log(name, `claim créé sur ${pool.name}${anchorId === null ? '' : `, restauration de ${anchorId}`}`)
      return { accepted: true, value: { name, existing: false } }
    } catch (error) {
      if (error instanceof KubeError && error.status === 409) {
        const existing = await this.options.kube.getClaim(name)
        if (existing?.metadata.annotations?.[ANNOTATION.requestId] === requestId) {
          this.upsert(existing)
          return { accepted: true, value: { name, existing: true } }
        }
        return refused(`le nom ${name} est déjà pris par une autre demande`)
      }
      return refused(`Kubernetes a refusé : ${error instanceof Error ? error.message : String(error)}`, 502)
    }
  }

  /** Stop: close sends, cancel the turn, stop re-arming. The infrastructure destroys at the deadline. */
  async stopSandbox(name: string): Promise<CommandResult<{ name: string; shutdownTime: string | null }>> {
    const record = this.records.get(name)
    if (record === undefined) return refused(`exécution inconnue : ${name}`, 404)
    if (record.stopped !== null) return refused(`arrêt déjà demandé (${record.stopped.at})`)
    if (record.ending) return refused("l'infrastructure détruit déjà ce sandbox")
    record.stopped = { reason: 'arrêt demandé', at: new Date().toISOString() }
    try {
      await this.annotate(record, { [ANNOTATION.stopped]: JSON.stringify(record.stopped) })
    } catch (error) {
      record.stopped = null
      return refused(`PATCH refusé : ${error instanceof Error ? error.message : String(error)}`, 502)
    }
    if (record.turn !== null && this.bridgeOpen(record)) {
      record.bridge?.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: record.turn.sessionId } }))
    }
    this.log(name, `arrêt demandé : plus de renouvellement, fin à l'échéance ${String(record.shutdownTime)}`)
    this.emitRecord(record)
    return { accepted: true, value: { name, shutdownTime: record.shutdownTime } }
  }

  // ---------------------------------------------------------------- lab hooks (docs/executions.md, "Le banc")

  lab = {
    dropBridge: (name: string): CommandResult<string> => {
      const record = this.records.get(name)
      if (record === undefined) return refused(`exécution inconnue : ${name}`, 404)
      if (record.bridge === null) return refused('aucune connexion au bridge')
      record.bridge.terminate()
      this.log(name, 'banc : connexion au bridge coupée')
      return { accepted: true, value: 'coupée' }
    },
    probeAuth: async (name: string): Promise<CommandResult<{ case: string; info: number; acp: number }[]>> => {
      const record = this.records.get(name)
      if (record === undefined || record.podName === null || record.serviceFQDN === null) return refused('exécution inconnue ou sans Service', 404)
      const podName = record.podName
      const cases: [string, Record<string, string>][] = [
        ['sans jeton', {}],
        ['jeton expiré', { authorization: `Bearer ${mintBridgeToken(this.options.signingKey, podName, { now: Date.now() - 120_000 })}` }],
        ["jeton d'un autre sandbox", { authorization: `Bearer ${mintBridgeToken(this.options.signingKey, 'sbx-autre')}` }],
        ['jeton signé par une autre clé', { authorization: `Bearer ${mintBridgeToken(this.foreignKey, podName)}` }],
        ['jeton valide (témoin)', { authorization: `Bearer ${this.token(record)}` }],
      ]
      const results: { case: string; info: number; acp: number }[] = []
      for (const [label, headers] of cases) {
        const info = (await fetch(`http://${this.address(record)}/info`, { headers, signal: AbortSignal.timeout(5000) })).status
        // A bare upgrade request: only the status line matters, the socket is never kept.
        const acp = await new Promise<number>((resolve) => {
          const socket = new WebSocket(`ws://${this.address(record)}/acp?after=${String(Number.MAX_SAFE_INTEGER)}`, { headers })
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
      this.log(name, `banc : sondage du jeton ${JSON.stringify(results)}`)
      // The witness connection took the bridge over; Agora reconnects on its own.
      return { accepted: true, value: results }
    },
  }

  // ---------------------------------------------------------------- views and events

  private state(record: SandboxRecord): { state: string; reason: string } {
    if (record.ending) return { state: 'fin de vie', reason: `${this.endReason(record)} ; anchor attendu du Pod` }
    if (record.error !== null) return { state: 'erreur', reason: record.error }
    if (record.lost !== null) return { state: 'perdu', reason: record.lost }
    if (record.stopped !== null) return { state: 'arrêté', reason: `plus de renouvellement, fin à l'échéance` }
    if (!record.ready) return { state: 'démarrage', reason: [record.readyReason, record.readyMessage, record.podDetail].filter((part) => part !== '' && part !== null).join(' — ') }
    if (!this.bridgeOpen(record)) return { state: 'connexion', reason: `bridge : ${record.bridgeState}` }
    if (record.restoring) return { state: 'restauration', reason: `anchor ${String(record.restoreAnchor)}` }
    if (record.uncertain !== null) return { state: 'incertain', reason: record.uncertain }
    if (record.turn !== null) return { state: 'en tour', reason: `depuis ${record.turn.startedAt}` }
    return { state: 'prêt', reason: '' }
  }

  view(record: SandboxRecord) {
    const { state, reason } = this.state(record)
    return {
      name: record.name,
      uid: record.uid,
      pool: record.pool,
      requestId: record.requestId,
      createdAt: new Date(record.createdAt).toISOString(),
      state,
      reason,
      launchType: record.launchType,
      pod: record.podName,
      service: record.serviceFQDN,
      podDetail: record.podDetail,
      shutdownTime: record.shutdownTime,
      renewing: this.renews(record),
      limits: record.limits,
      lastRenewedAt: record.lastRenewedAt === 0 ? null : new Date(record.lastRenewedAt).toISOString(),
      renewals: record.renewals,
      bridge: {
        state: record.bridgeState,
        instance: record.hello?.instance ?? null,
        agent: record.hello?.initialize?.agentInfo ?? null,
        adapter: record.hello?.adapter ?? null,
        workspace: record.hello?.workspace ?? null,
      },
      instance: record.instance,
      sessionId: record.sessionId,
      turn: record.turn,
      lastTurn: record.lastTurn,
      idleSince: record.idleSince,
      stopped: record.stopped,
      lastSeq: record.lastSeq,
      restoreAnchor: record.restoreAnchor,
      restored: record.restored,
      consumer: record.consumer !== null,
      pendingPermissions: record.permissions.size,
      outbound: record.outbound,
    }
  }

  snapshot(): { executions: ExecutionView[]; history: Ending[]; logs: LogEntry[] } {
    return { executions: [...this.records.values()].map((record) => this.view(record)), history: [...this.history], logs: [...this.logs] }
  }

  subscribe(listener: (event: ManagerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: ManagerEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private emitRecord(record: SandboxRecord): void {
    if (this.records.get(record.name) !== record) return
    const view = this.view(record)
    this.emit({ type: 'execution', execution: view })
    this.toConsumer(record, { event: { type: 'execution', execution: view } })
  }

  private log(execution: string | null, message: string): void {
    const entry: LogEntry = { at: new Date().toISOString(), execution, message }
    this.logs.unshift(entry)
    this.logs.splice(LOG_LIMIT)
    ;(this.options.log ?? ((line: string) => console.log(line)))(`${execution ?? '-'} ${message}`)
    this.emit({ type: 'log', entry })
  }
}
