// The sandbox back-end (sandbox-backend.md). It holds ONE connection per bridge, follows turns by
// watching the ACP traffic it relays, renews each claim's safety deadline, decides deletions and
// captures the anchor right before each one. Everything it must know after a restart is written on
// the claim itself (agent-sandbox.md, "Ce qu'Agora écrit sur le claim"): this process keeps no
// other state about living sandboxes.
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { WebSocket } from 'ws'
import type { AnchorMeta, AnchorStore } from './anchors.ts'
import { KubeError, WatchGone, type Claim, type KubeApi, type WatchEvent } from './kube.ts'
import { mintBridgeToken } from '../shared/token.ts'

export const MANAGED_BY = 'app.kubernetes.io/managed-by'
export const MANAGER = 'agora-sandbox-backend'
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
} as const
const SELECTOR = `${MANAGED_BY}=${MANAGER}`
const RING_LIMIT = 2000
const HISTORY_LIMIT = 100
const LOG_LIMIT = 300
const TERMINAL_CLAIM_REASONS = new Set(['WarmPoolNotFound', 'EnvVarsInjectionRejected', 'VolumeClaimTemplatesRejected'])

export interface Limits {
  readonly leaseSeconds: number
  readonly idleSeconds: number
  readonly turnCapSeconds: number
}

export const LIMIT_BOUNDS: Record<keyof Limits, readonly [number, number]> = {
  leaseSeconds: [60, 600],
  idleSeconds: [30, 3600],
  turnCapSeconds: [30, 3600],
}

export interface ManagerOptions {
  readonly kube: KubeApi
  readonly anchors: AnchorStore
  readonly signingKey: KeyObject
  readonly defaults: Limits
  readonly renewSeconds: number
  readonly maxActive: number
  readonly startupTimeoutSeconds: number
  readonly stopTurnWaitMs: number
  readonly bridgePort: number
  /** Test seam: where to reach a sandbox's bridge. Defaults to its first Pod IP. */
  readonly bridgeAddress?: (podIP: string, podName: string) => string
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
}

interface Stopping {
  readonly reason: string
  readonly at: string
  promise?: Promise<Removal>
}

export interface Removal {
  readonly name: string
  readonly pool: string
  readonly reason: string
  readonly anchor: AnchorMeta | null
  readonly anchorError: string | null
  readonly at: string
}

export interface LogEntry {
  readonly at: string
  readonly sandbox: string | null
  readonly message: string
}

interface SandboxRecord {
  readonly name: string
  readonly uid: string
  readonly pool: string
  readonly requestId: string
  readonly createdAt: number
  /** When this process first saw the claim: after a restart, startup delays count from here. */
  readonly firstSeenAt: number
  readonly limits: Limits
  readonly restoreAnchor: string | null
  // From the claim, refreshed on every event.
  ready: boolean
  readyReason: string
  readyMessage: string
  podName: string | null
  podIP: string | null
  shutdownTime: string | null
  // Written on the claim by the back-end; read from it only once, when the record is first built.
  instance: string | null
  sessionId: string | null
  turn: Turn | null
  idleSince: string | null
  restored: boolean
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
  turnWaiters: (() => void)[]
  admitting: boolean
  restoring: boolean
  renewalPaused: boolean
  lastRenewedAt: number
  renewals: number
  lastTurn: { outcome: string; endedAt: string } | null
  error: string | null
  lost: string | null
  uncertain: string | null
  stopping: Stopping | null
}

interface AcpMessage {
  readonly id?: Id | null
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: Record<string, unknown> | null
  readonly error?: { code?: number; message?: string }
}

export type ManagerEvent =
  | { readonly type: 'sandbox'; readonly sandbox: SandboxView }
  | { readonly type: 'removed'; readonly removal: Removal }
  | { readonly type: 'anchor'; readonly anchor: AnchorMeta }
  | { readonly type: 'log'; readonly entry: LogEntry }

export type SandboxView = ReturnType<SandboxManager['view']>

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

export class SandboxManager {
  private readonly options: ManagerOptions
  private readonly records = new Map<string, SandboxRecord>()
  private readonly gone = new Set<string>()
  private readonly history: Removal[] = []
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
      record.consumer?.close(1001, 'arrêt du back-end')
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
            for (const record of [...this.records.values()]) {
              if (!seen.has(record.name) && record.stopping === null) this.finalize(record, 'supprimé hors du back-end', null, 'aucune capture : Agora n\'a pas décidé cette suppression')
            }
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
      if (record !== undefined && record.uid === event.object.metadata.uid && record.stopping === null) {
        this.finalize(record, 'supprimé hors du back-end (échéance de secours ?)', null, "aucune capture : Agora n'a pas décidé cette suppression")
      }
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
      // Same name, another object: the old one is over for us.
      this.finalize(record, 'remplacé par un autre objet du même nom', null, 'aucune capture')
      record = undefined
    }
    if (claim.metadata.deletionTimestamp !== undefined) {
      if (record !== undefined && record.stopping === null) {
        this.finalize(record, 'supprimé hors du back-end (échéance de secours ?)', null, "aucune capture : Agora n'a pas décidé cette suppression")
      }
      return
    }
    if (record === undefined) {
      record = this.newRecord(claim)
      this.records.set(name, record)
    }
    const ready = claim.status?.conditions?.find((condition) => condition.type === 'Ready')
    record.ready = ready?.status === 'True'
    record.readyReason = ready?.reason ?? ''
    record.readyMessage = ready?.message ?? ''
    record.podName = claim.status?.sandbox?.name ?? null
    record.podIP = claim.status?.sandbox?.podIPs?.[0] ?? null
    record.shutdownTime = claim.spec?.lifecycle?.shutdownTime ?? null
    if (!record.ready && TERMINAL_CLAIM_REASONS.has(record.readyReason) && record.error === null) {
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
    return {
      name: claim.metadata.name,
      uid: claim.metadata.uid,
      pool: claim.metadata.labels?.[POOL_LABEL] ?? claim.spec?.warmPoolRef?.name ?? '?',
      requestId: annotations[ANNOTATION.requestId] ?? '',
      createdAt: Date.parse(claim.metadata.creationTimestamp ?? new Date().toISOString()),
      firstSeenAt: Date.now(),
      limits: { ...this.options.defaults, ...(parse<Partial<Limits>>(annotations[ANNOTATION.limits]) ?? {}) },
      restoreAnchor: annotations[ANNOTATION.restoreAnchor] ?? null,
      ready: false,
      readyReason: '',
      readyMessage: '',
      podName: null,
      podIP: null,
      shutdownTime: null,
      instance: annotations[ANNOTATION.instance] ?? null,
      sessionId: annotations[ANNOTATION.sessionId] ?? null,
      turn: parse<Turn>(annotations[ANNOTATION.turn]),
      idleSince: annotations[ANNOTATION.idleSince] ?? null,
      restored: annotations[ANNOTATION.restored] !== undefined,
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
      turnWaiters: [],
      admitting: false,
      restoring: false,
      renewalPaused: false,
      lastRenewedAt: 0,
      renewals: 0,
      lastTurn: null,
      error: null,
      lost: null,
      uncertain: null,
      stopping: null,
    }
  }

  // ---------------------------------------------------------------- the bridge connection

  private address(record: SandboxRecord): string {
    const podIP = record.podIP ?? ''
    return this.options.bridgeAddress?.(podIP, record.podName ?? '') ?? `${podIP.includes(':') ? `[${podIP}]` : podIP}:${String(this.options.bridgePort)}`
  }

  private token(record: SandboxRecord): string {
    return mintBridgeToken(this.options.signingKey, record.podName ?? '')
  }

  private bridgeOpen(record: SandboxRecord): boolean {
    return record.bridge !== null && record.bridge.readyState === WebSocket.OPEN && record.hello !== null
  }

  private ensureBridge(record: SandboxRecord): void {
    if (this.stopped || !record.ready || record.podIP === null || record.podName === null) return
    if (record.bridge !== null || record.reconnectTimer !== null || record.stopping !== null || record.lost !== null) return
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
    if (this.records.get(record.name) !== record || record.stopping !== null || this.stopped) return
    this.log(record.name, `connexion au bridge fermée (${String(code)}${reason === '' ? '' : ` ${reason}`})`)
    if (code === 1011) {
      record.lost = "l'adaptateur est mort"
      void this.reap(record, 'adaptateur perdu')
      return
    }
    record.reconnectTimer = setTimeout(() => {
      record.reconnectTimer = null
      this.ensureBridge(record)
    }, 2000)
    this.emitRecord(record)
  }

  private onBridgeMessage(record: SandboxRecord, socket: WebSocket, text: string): void {
    if (record.bridge !== socket) return
    let message: { hello?: Hello; seq?: number; acp?: string }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      return
    }
    if (message.hello !== undefined) this.onHello(record, message.hello)
    else if (typeof message.seq === 'number' && typeof message.acp === 'string') this.onFrame(record, message.seq, message.acp)
  }

  private onHello(record: SandboxRecord, hello: Hello): void {
    record.hello = hello
    record.bridgeState = 'connectée'
    if (record.instance === null) {
      record.instance = hello.instance
      record.idleSince ??= new Date().toISOString()
      void this.annotate(record, { [ANNOTATION.instance]: hello.instance, [ANNOTATION.idleSince]: record.idleSince })
      this.log(record.name, `bridge joint : instance ${hello.instance}, ${String(hello.initialize?.agentInfo?.name)}@${String(hello.initialize?.agentInfo?.version)}`)
    } else if (record.instance !== hello.instance) {
      record.lost = `processus remplacé : instance ${hello.instance}, attendue ${record.instance}`
      if (record.turn !== null) record.uncertain = 'la fin du tour est partie avec le processus'
      this.log(record.name, record.lost)
      void this.reap(record, 'processus remplacé')
      return
    } else {
      this.log(record.name, `bridge rejoint${hello.replayFrom === null ? '' : `, rejeu depuis ${String(hello.replayFrom)}`}${hello.gap ? ', AVEC UN TROU' : ''}`)
    }
    if (hello.gap && record.turn !== null) record.uncertain = 'des trames du tour ont été perdues (trou au rejeu)'
    if (!hello.adapter.alive) {
      record.lost = `l'adaptateur est mort (code ${String(hello.adapter.exitCode)})`
      void this.reap(record, 'adaptateur perdu')
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
      if (record.turn !== null && idKey(record.turn.requestId) === key) this.endTurn(record, message)
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

  private endTurn(record: SandboxRecord, message: AcpMessage): void {
    const outcome = message.error !== undefined ? `erreur : ${String(message.error.message)}` : `fin : ${String(message.result?.stopReason)}`
    record.turn = null
    record.uncertain = null
    record.permissions.clear()
    record.idleSince = new Date().toISOString()
    record.lastTurn = { outcome, endedAt: record.idleSince }
    void this.annotate(record, { [ANNOTATION.turn]: null, [ANNOTATION.idleSince]: record.idleSince })
    for (const wake of record.turnWaiters.splice(0)) wake()
    this.log(record.name, `tour clos (${outcome})`)
    this.emitRecord(record)
  }

  private setSession(record: SandboxRecord, sessionId: string): void {
    if (record.sessionId === sessionId) return
    record.sessionId = sessionId
    void this.annotate(record, { [ANNOTATION.sessionId]: sessionId })
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
      this.log(record.name, `annotation refusée : ${error instanceof Error ? error.message : String(error)}`)
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
      const bytes = await this.options.anchors.bytes(anchorId)
      if (bytes === null) throw new Error(`anchor ${anchorId} introuvable`)
      const response = await fetch(`http://${this.address(record)}/anchor`, {
        method: 'PUT',
        body: bytes as unknown as BodyInit,
        headers: { authorization: `Bearer ${this.token(record)}`, 'content-type': 'application/octet-stream' },
        signal: AbortSignal.timeout(30_000),
      })
      const placement = (await response.json()) as { sessionId?: string; reason?: string; path?: string }
      if (!response.ok || placement.sessionId === undefined) throw new Error(`dépôt refusé (${String(response.status)}) : ${String(placement.reason)}`)
      this.log(record.name, `anchor ${anchorId} déposé : ${String(placement.path)}`)

      const capabilities = record.hello?.initialize?.agentCapabilities
      const method = capabilities?.sessionCapabilities?.resume != null ? 'session/resume' : capabilities?.loadSession === true ? 'session/load' : null
      if (method === null) throw new Error("l'agent n'annonce ni session/resume ni session/load")
      const answer = await this.ownRequest(record, method, { sessionId: placement.sessionId, cwd: record.hello?.workspace, mcpServers: [] }, 60_000)
      if (answer.error !== undefined) throw new Error(`${method} refusé : ${String(answer.error.message)}`)

      record.restored = true
      record.sessionId = placement.sessionId
      await this.annotate(record, { [ANNOTATION.restored]: new Date().toISOString(), [ANNOTATION.sessionId]: placement.sessionId })
      this.log(record.name, `reprise par ${method} de la session ${placement.sessionId}`)
    } catch (error) {
      record.error = `restauration impossible : ${error instanceof Error ? error.message : String(error)}`
      this.log(record.name, record.error)
    } finally {
      record.restoring = false
      this.emitRecord(record)
    }
  }

  // ---------------------------------------------------------------- the consumer relay

  attachConsumer(name: string, socket: WebSocket, after: number | null): void {
    const record = this.records.get(name)
    if (record === undefined) {
      socket.close(4404, 'sandbox inconnu')
      return
    }
    if (record.consumer !== null) record.consumer.close(4000, 'remplacé par un consommateur plus récent')
    record.consumer = socket
    socket.send(JSON.stringify({ event: { type: 'attached', sandbox: this.view(record), initialize: record.hello?.initialize ?? null } }))
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
      return this.answer(record, socket, id, { error: { code: -32600, message: 'les identifiants agora-… sont réservés au back-end' } })
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
      record.stopping !== null ? 'arrêt décidé'
      : record.admitting ? "un prompt est déjà en cours d'admission"
      : record.turn !== null ? 'un tour est déjà en cours'
      : state !== 'prêt' ? `sandbox ${state}`
      : null
    if (refusal !== null) return this.answer(record, socket, id, { error: { code: -32000, message: `refusé : ${refusal}` } })

    record.admitting = true
    const now = Date.now()
    const turn: Turn = { startedAt: new Date(now).toISOString(), requestId: id, seq: record.lastSeq, sessionId: (message.params?.sessionId as string | undefined) ?? null }
    const shutdownTime = iso(now + record.limits.leaseSeconds * 1000)
    try {
      // One PATCH: the turn is written and its deadline accepted before the prompt leaves.
      await this.annotate(record, { [ANNOTATION.turn]: JSON.stringify(turn) }, { shutdownTime })
    } catch (error) {
      record.admitting = false
      return this.answer(record, socket, id, { error: { code: -32000, message: `refusé : échéance non acceptée (${error instanceof Error ? error.message : String(error)})` } })
    }
    record.admitting = false
    if (!this.bridgeOpen(record) || record.stopping !== null) {
      void this.annotate(record, { [ANNOTATION.turn]: null }).catch(() => {})
      return this.answer(record, socket, id, { error: { code: -32000, message: 'refusé : bridge perdu pendant l’admission' } })
    }
    record.turn = turn
    record.shutdownTime = shutdownTime
    record.lastRenewedAt = now
    record.renewals += 1
    record.uncertain = null
    record.bridge?.send(text)
    this.log(record.name, `tour ouvert (requête ${JSON.stringify(id)}, position ${String(turn.seq)})`)
    this.emitRecord(record)
  }

  // ---------------------------------------------------------------- lease, deadlines, deletion

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const record of [...this.records.values()]) {
      if (record.stopping !== null) continue
      try {
        if (!record.renewalPaused && now - record.lastRenewedAt >= this.options.renewSeconds * 1000) await this.renew(record, now)
        const inService = record.hello !== null
        const waitingSince = Math.max(record.createdAt, record.firstSeenAt)
        if (!inService && now - waitingSince > this.options.startupTimeoutSeconds * 1000 && record.lost === null) {
          void this.reap(record, 'démarrage trop long')
        } else if (record.turn !== null && now - Date.parse(record.turn.startedAt) > record.limits.turnCapSeconds * 1000) {
          void this.reap(record, 'tour trop long')
        } else if (record.turn === null && inService && !record.restoring && record.idleSince !== null && now - Date.parse(record.idleSince) > record.limits.idleSeconds * 1000) {
          void this.reap(record, 'inactivité')
        } else if (record.error !== null && now - waitingSince > 60_000 && !inService) {
          void this.reap(record, `erreur : ${record.error}`)
        }
        if (!record.ready && record.podName !== null) await this.diagnose(record)
        if (record.launchType === null && record.podName !== null) await this.readLaunchType(record)
      } catch (error) {
        this.log(record.name, `tick : ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async renew(record: SandboxRecord, now: number): Promise<void> {
    const shutdownTime = iso(now + record.limits.leaseSeconds * 1000)
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

  private waitTurnEnd(record: SandboxRecord, timeoutMs: number): Promise<boolean> {
    if (record.turn === null) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      record.turnWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  /** Close sends, cancel the turn in flight, capture the anchor, then delete (sandbox-backend.md). */
  reap(record: SandboxRecord, reason: string): Promise<Removal> {
    if (record.stopping?.promise !== undefined) return record.stopping.promise
    const stopping: Stopping = { reason, at: new Date().toISOString() }
    record.stopping = stopping
    this.log(record.name, `suppression décidée : ${reason}`)
    this.emitRecord(record)
    stopping.promise = (async () => {
      if (record.turn !== null && this.bridgeOpen(record)) {
        record.bridge?.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: record.turn.sessionId } }))
        this.log(record.name, 'session/cancel envoyé, attente de la fin du tour')
        const ended = await this.waitTurnEnd(record, this.options.stopTurnWaitMs)
        if (!ended) this.log(record.name, `le tour n'a pas fini en ${String(this.options.stopTurnWaitMs)} ms`)
      }

      let anchor: AnchorMeta | null = null
      let anchorError: string | null = null
      if (record.sessionId === null) anchorError = 'aucune session ouverte'
      else if (record.podIP === null || record.podName === null) anchorError = 'Pod injoignable'
      else {
        try {
          const response = await fetch(`http://${this.address(record)}/anchor?sessionId=${encodeURIComponent(record.sessionId)}`, {
            headers: { authorization: `Bearer ${this.token(record)}` },
            signal: AbortSignal.timeout(20_000),
          })
          if (response.ok) {
            const bytes = new Uint8Array(await response.arrayBuffer())
            anchor = await this.options.anchors.save(
              {
                harness: (await this.pools()).find((pool) => pool.name === record.pool)?.harness ?? '?',
                pool: record.pool,
                format: response.headers.get('x-anchor-format') ?? '?',
                sessionId: response.headers.get('x-anchor-session') ?? record.sessionId,
                checksum: response.headers.get('x-anchor-checksum') ?? '?',
                byteLength: bytes.byteLength,
                sandbox: record.name,
                reason,
              },
              bytes,
            )
            this.log(record.name, `anchor ${anchor.id} capturé (${String(anchor.byteLength)} octets)`)
            this.emit({ type: 'anchor', anchor })
          } else {
            anchorError = `capture refusée (${String(response.status)}) : ${String(((await response.json().catch(() => ({}))) as { reason?: string }).reason)}`
          }
        } catch (error) {
          anchorError = `capture impossible : ${error instanceof Error ? error.message : String(error)}`
        }
      }
      if (anchorError !== null) this.log(record.name, `pas d'anchor : ${anchorError}`)

      record.bridge?.close(1000, 'suppression')
      for (let attempt = 1; ; attempt++) {
        try {
          const outcome = await this.options.kube.deleteClaim(record.name, record.uid)
          this.log(record.name, outcome === 'accepted' ? 'suppression acceptée' : 'claim déjà absent')
          break
        } catch (error) {
          this.log(record.name, `suppression refusée (essai ${String(attempt)}) : ${error instanceof Error ? error.message : String(error)}`)
          if (attempt >= 5) break
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
        }
      }
      return this.finalize(record, reason, anchor, anchorError)
    })()
    return stopping.promise
  }

  private finalize(record: SandboxRecord, reason: string, anchor: AnchorMeta | null, anchorError: string | null): Removal {
    const removal: Removal = { name: record.name, pool: record.pool, reason, anchor, anchorError, at: new Date().toISOString() }
    if (this.records.get(record.name) === record) this.records.delete(record.name)
    if (this.gone.has(record.uid)) return removal
    this.gone.add(record.uid)
    if (record.reconnectTimer !== null) clearTimeout(record.reconnectTimer)
    record.bridge?.close(1000, 'suppression')
    record.bridge = null
    record.consumer?.close(4001, `sandbox supprimé : ${reason}`)
    for (const wake of record.turnWaiters.splice(0)) wake()
    this.history.unshift(removal)
    this.history.splice(HISTORY_LIMIT)
    this.log(record.name, `retiré : ${reason}`)
    this.emit({ type: 'removed', removal })
    return removal
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
    if (requestId === '' || requestId.length > 200) return refused("identifiant de demande manquant ou trop long", 400)
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

    const active = [...this.records.values()].filter((record) => record.stopping === null).length
    if (active >= this.options.maxActive) return refused(`quota atteint : ${String(active)} sandboxes actifs sur ${String(this.options.maxActive)}`, 429)

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
      const record = this.records.get(name)
      if (record !== undefined) record.lastRenewedAt = now
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

  async stopSandbox(name: string): Promise<CommandResult<Removal>> {
    const record = this.records.get(name)
    if (record === undefined) return refused(`sandbox inconnu : ${name}`, 404)
    if (record.stopping !== null) return refused(`arrêt déjà en cours (${record.stopping.reason})`)
    return { accepted: true, value: await this.reap(record, 'arrêt demandé') }
  }

  // ---------------------------------------------------------------- lab hooks (sandbox-backend.md, "Le banc")

  lab = {
    dropBridge: (name: string): CommandResult<string> => {
      const record = this.records.get(name)
      if (record === undefined) return refused(`sandbox inconnu : ${name}`, 404)
      if (record.bridge === null) return refused('aucune connexion au bridge')
      record.bridge.terminate()
      this.log(name, 'banc : connexion au bridge coupée')
      return { accepted: true, value: 'coupée' }
    },
    pauseRenewal: (name: string, paused: boolean): CommandResult<string> => {
      const record = this.records.get(name)
      if (record === undefined) return refused(`sandbox inconnu : ${name}`, 404)
      record.renewalPaused = paused
      this.log(name, paused ? 'banc : renouvellement suspendu' : 'banc : renouvellement repris')
      this.emitRecord(record)
      return { accepted: true, value: paused ? 'suspendu' : 'repris' }
    },
    probeAuth: async (name: string): Promise<CommandResult<{ case: string; info: number; acp: number }[]>> => {
      const record = this.records.get(name)
      if (record === undefined || record.podName === null || record.podIP === null) return refused('sandbox inconnu ou sans Pod', 404)
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
      // The witness connection took the bridge over; the back-end reconnects on its own.
      return { accepted: true, value: results }
    },
    deletePod: async (name: string): Promise<CommandResult<string>> => {
      const record = this.records.get(name)
      if (record === undefined || record.podName === null) return refused('sandbox inconnu ou sans Pod', 404)
      await this.options.kube.deletePod(record.podName)
      this.log(name, `banc : Pod ${record.podName} supprimé seul`)
      return { accepted: true, value: record.podName }
    },
  }

  // ---------------------------------------------------------------- views and events

  private state(record: SandboxRecord): { state: string; reason: string } {
    if (record.stopping !== null) return { state: 'arrêt', reason: record.stopping.reason }
    if (record.error !== null) return { state: 'erreur', reason: record.error }
    if (record.lost !== null) return { state: 'perdu', reason: record.lost }
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
      podIP: record.podIP,
      podDetail: record.podDetail,
      shutdownTime: record.shutdownTime,
      limits: record.limits,
      renewalPaused: record.renewalPaused,
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
      lastSeq: record.lastSeq,
      restoreAnchor: record.restoreAnchor,
      restored: record.restored,
      consumer: record.consumer !== null,
      pendingPermissions: record.permissions.size,
    }
  }

  snapshot(): { sandboxes: SandboxView[]; history: Removal[]; logs: LogEntry[] } {
    return { sandboxes: [...this.records.values()].map((record) => this.view(record)), history: [...this.history], logs: [...this.logs] }
  }

  has(name: string): boolean {
    return this.records.has(name)
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
    this.emit({ type: 'sandbox', sandbox: view })
    this.toConsumer(record, { event: { type: 'sandbox', sandbox: view } })
  }

  private log(sandbox: string | null, message: string): void {
    const entry: LogEntry = { at: new Date().toISOString(), sandbox, message }
    this.logs.unshift(entry)
    this.logs.splice(LOG_LIMIT)
    ;(this.options.log ?? ((line: string) => console.log(line)))(`${sandbox ?? '-'} ${message}`)
    this.emit({ type: 'log', entry })
  }
}
