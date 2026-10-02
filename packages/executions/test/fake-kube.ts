// An in-memory stand-in for the Kubernetes API and for Agent Sandbox's controller: claims with merge
// patches and UID preconditions, a watch, allocation that starts a real bridge with the mock agent,
// and the deadline — at `shutdownTime` the claim is deleted and its Pod terminated, which makes the
// bridge push its anchor exactly as in a real Pod (docs/specs/executions.md, "The end of the Pod and the anchor").
import { randomUUID, type KeyObject } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KubeError, type Claim, type Json, type KubeApi, type PodIdentity, type Pool, type WatchEvent } from '../src/kube.ts'
import { pushBundle } from '@agora/harness-bridge/anchor'
import { mockBridge, type LabBridge } from '@agora/testkit'

type Mutable = { metadata: Record<string, unknown> & { annotations?: Record<string, string> }; spec: Record<string, unknown>; status?: Record<string, unknown> }

function merge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key]
    else if (typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object' && target[key] !== null) {
      merge(target[key] as Record<string, unknown>, value as Record<string, unknown>)
    } else target[key] = typeof value === 'object' ? structuredClone(value) : value
  }
}

export const NAMESPACE = 'agora-sandboxes'

export class FakeKube implements KubeApi {
  readonly claims = new Map<string, Mutable>()
  readonly bridges = new Map<string, LabBridge>()
  /** Every PATCH of a claim's deadline, in order: the tests read the renewal policy from it. */
  readonly deadlines: { name: string; shutdownTime: string; at: number }[] = []
  /** Every claim created, by name, in order. */
  readonly created: string[] = []
  private readonly watchers = new Set<(event: WatchEvent) => void>()
  private readonly tokens = mkdtempSync(join(tmpdir(), 'tokens-'))
  private version = 1
  private podCounter = 0
  private readonly publicKey: KeyObject
  private readonly controller: NodeJS.Timeout
  /** Where the Pods push their anchor: the executions' receiver, set once it listens. */
  anchorUrl = ''
  allocationDelayMs = 50
  failPatches = false
  /** Foreground deletion held: past its deadline a claim gets its deletionTimestamp, and stays with its Pod. */
  holdDeletion = false
  bridgeFactory: (publicKey: KeyObject, podName: string) => Promise<LabBridge> = mockBridge
  private closed = false

  constructor(publicKey: KeyObject) {
    this.publicKey = publicKey
    this.controller = setInterval(() => this.expire(), 100)
  }

  address = (_service: string, podName: string): string => this.bridges.get(podName)?.url ?? '127.0.0.1:1'

  private emit(type: WatchEvent['type'], claim: Mutable): void {
    const event = { type, object: structuredClone(claim) } as unknown as WatchEvent
    for (const watcher of this.watchers) watcher(event)
  }

  private bump(claim: Mutable): void {
    claim.metadata.resourceVersion = String(++this.version)
  }

  async listClaims(): Promise<{ items: Claim[]; resourceVersion: string }> {
    return { items: [...this.claims.values()].map((claim) => structuredClone(claim) as unknown as Claim), resourceVersion: String(this.version) }
  }

  watchClaims(_selector: string, _version: string, onEvent: (event: WatchEvent) => void, signal: AbortSignal): Promise<void> {
    this.watchers.add(onEvent)
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        this.watchers.delete(onEvent)
        resolve()
      })
    })
  }

  async createClaim(input: Json): Promise<Claim> {
    const claim = structuredClone(input) as unknown as Mutable
    const name = claim.metadata.name as string
    if (this.claims.has(name)) throw new KubeError(409, `sandboxclaims "${name}" already exists`)
    this.created.push(name)
    claim.metadata.uid = randomUUID()
    claim.metadata.creationTimestamp = new Date().toISOString()
    claim.status = { conditions: [{ type: 'Ready', status: 'False', reason: 'SandboxNotReady' }] }
    this.bump(claim)
    this.claims.set(name, claim)
    this.emit('ADDED', claim)
    setTimeout(() => void this.allocate(name), this.allocationDelayMs)
    return structuredClone(claim) as unknown as Claim
  }

  private async allocate(name: string): Promise<void> {
    const claim = this.claims.get(name)
    if (claim === undefined) return
    const pool = (claim.spec.warmPoolRef as { name: string }).name
    if (pool === 'no-such-pool') {
      claim.status = { conditions: [{ type: 'Ready', status: 'False', reason: 'WarmPoolNotFound', message: 'pool absent' }] }
    } else {
      const podName = `${pool}-${String(++this.podCounter)}`
      const bridge = await this.bridgeFactory(this.publicKey, podName)
      // Closed while the Pod was starting: it never runs.
      if (this.closed) return void (await bridge.bridge.close())
      this.bridges.set(podName, bridge)
      claim.status = { conditions: [{ type: 'Ready', status: 'True', reason: 'SandboxReady' }], sandbox: { name: podName, serviceFQDN: `${podName}.${NAMESPACE}.svc.cluster.local` } }
    }
    this.bump(claim)
    this.emit('MODIFIED', claim)
  }

  /** Agent Sandbox at the deadline: delete the claim (foreground), terminate the Pod, then forget. */
  private expire(): void {
    for (const [name, claim] of this.claims) {
      const deadline = Date.parse(String((claim.spec.lifecycle as { shutdownTime?: string } | undefined)?.shutdownTime))
      if (claim.metadata.deletionTimestamp !== undefined || !(deadline <= Date.now())) continue
      claim.metadata.deletionTimestamp = new Date().toISOString()
      this.bump(claim)
      this.emit('MODIFIED', claim)
      if (this.holdDeletion) continue
      const podName = (claim.status?.sandbox as { name?: string } | undefined)?.name
      void (async () => {
        const lab = podName === undefined ? undefined : this.bridges.get(podName)
        if (lab !== undefined && podName !== undefined) {
          // SIGTERM: the bridge stops the adapter and pushes its native files with the Pod's token.
          const bundle = await lab.bridge.terminate()
          const tokenFile = join(this.tokens, podName)
          writeFileSync(tokenFile, `pod:${podName}`)
          if (this.anchorUrl !== '') await pushBundle(this.anchorUrl, tokenFile, bundle, { attempts: 1 })
          await lab.bridge.close()
        }
        this.claims.delete(name)
        this.emit('DELETED', claim)
      })()
    }
  }

  /** Ends a held foreground deletion: the Pod is terminated and pushes its anchor, then the claim goes. */
  releaseDeletion(): void {
    this.holdDeletion = false
    for (const claim of this.claims.values()) if (claim.metadata.deletionTimestamp !== undefined) delete claim.metadata.deletionTimestamp
  }

  /** A claim removed by someone else than Agent Sandbox at the deadline: gone at once, Pod left as is. */
  deleteClaim(name: string): void {
    const claim = this.claims.get(name)
    if (claim === undefined) return
    this.claims.delete(name)
    this.bump(claim)
    this.emit('DELETED', claim)
  }

  /** The deadline moved by the cluster, not by Agora: not recorded in `deadlines`. */
  expireAt(name: string, shutdownTime: Date): void {
    const claim = this.claims.get(name)
    if (claim === undefined) return
    ;(claim.spec.lifecycle as { shutdownTime?: string }).shutdownTime = shutdownTime.toISOString()
    this.bump(claim)
    this.emit('MODIFIED', claim)
  }

  async getClaim(name: string): Promise<Claim | null> {
    const claim = this.claims.get(name)
    return claim === undefined ? null : (structuredClone(claim) as unknown as Claim)
  }

  async patchClaim(name: string, patch: Json): Promise<Claim> {
    if (this.failPatches) throw new KubeError(500, 'patch refused (test)')
    const claim = this.claims.get(name)
    if (claim === undefined) throw new KubeError(404, 'absent')
    const uid = (patch.metadata as { uid?: string } | undefined)?.uid
    if (uid !== undefined && uid !== claim.metadata.uid) throw new KubeError(409, 'uid does not match')
    merge(claim as unknown as Record<string, unknown>, patch)
    const shutdownTime = ((patch.spec as { lifecycle?: { shutdownTime?: string } } | undefined)?.lifecycle)?.shutdownTime
    if (shutdownTime !== undefined) this.deadlines.push({ name, shutdownTime, at: Date.now() })
    this.bump(claim)
    this.emit('MODIFIED', claim)
    return structuredClone(claim) as unknown as Claim
  }

  async listPools(): Promise<Pool[]> {
    const pool = (name: string, harness: string): Pool => ({
      metadata: { name, uid: name, labels: { 'agora.bretagne.dev/harness': harness } },
      spec: { replicas: 2, sandboxTemplateRef: { name } },
      status: { readyReplicas: 2 },
    })
    return [pool('mock-test', 'mock'), pool('claude-test', 'claude-code')]
  }

  async getTemplate(name: string): Promise<Json | null> {
    return { spec: { podTemplate: { spec: { containers: [{ image: `ghcr.io/test/${name}@sha256:0` }] } } } }
  }

  async getSandbox(): Promise<Json | null> {
    return { metadata: { labels: { 'agents.x-k8s.io/launch-type': 'warm' } } }
  }

  /** A Pod recreated under the same name gets another UID than the one its old tokens carry. */
  readonly podUids = new Map<string, string>()

  async getPod(name = ''): Promise<Json | null> {
    return { metadata: { uid: this.podUids.get(name) ?? `uid-${name}` }, status: { phase: 'Running' } }
  }

  /** A projected token is `pod:<name>` here; anything else is refused, as TokenReview would. */
  async reviewToken(token: string): Promise<PodIdentity | null> {
    return token.startsWith('pod:') ? { namespace: NAMESPACE, podName: token.slice(4), podUid: `uid-${token.slice(4)}` } : null
  }

  /** The Sandbox controller recreating a Pod that vanished: same name, new bridge instance. */
  async replacePod(name: string): Promise<void> {
    await this.bridges.get(name)?.bridge.close()
    this.bridges.set(name, await this.bridgeFactory(this.publicKey, name))
  }

  async closeAll(): Promise<void> {
    this.closed = true
    clearInterval(this.controller)
    for (const lab of this.bridges.values()) await lab.bridge.close().catch(() => {})
  }
}
