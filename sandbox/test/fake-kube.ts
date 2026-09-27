// An in-memory stand-in for the Kubernetes API of agent-sandbox.md: claims with merge patches,
// UID preconditions, a watch, and "allocation" that starts a real bridge with the mock agent.
import { randomUUID, type KeyObject } from 'node:crypto'
import { KubeError, type Claim, type Json, type KubeApi, type Pool, type WatchEvent } from '../src/backend/kube.ts'
import { mockBridge, type LabBridge } from './helpers.ts'

type Mutable = { metadata: Record<string, unknown> & { annotations?: Record<string, string> }; spec: Record<string, unknown>; status?: Record<string, unknown> }

function merge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key]
    else if (typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object' && target[key] !== null) {
      merge(target[key] as Record<string, unknown>, value as Record<string, unknown>)
    } else target[key] = typeof value === 'object' ? structuredClone(value) : value
  }
}

export class FakeKube implements KubeApi {
  readonly claims = new Map<string, Mutable>()
  readonly bridges = new Map<string, LabBridge>()
  private readonly watchers = new Set<(event: WatchEvent) => void>()
  private version = 1
  private podCounter = 0
  private readonly publicKey: KeyObject
  allocationDelayMs = 50
  failPatches = false

  constructor(publicKey: KeyObject) {
    this.publicKey = publicKey
  }

  address = (_podIP: string, podName: string): string => this.bridges.get(podName)?.url ?? '127.0.0.1:1'

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
    if (pool === 'pool-inexistant') {
      claim.status = { conditions: [{ type: 'Ready', status: 'False', reason: 'WarmPoolNotFound', message: 'pool absent' }] }
    } else {
      const podName = `${pool}-${String(++this.podCounter)}`
      this.bridges.set(podName, await mockBridge(this.publicKey, podName))
      claim.status = { conditions: [{ type: 'Ready', status: 'True', reason: 'SandboxReady' }], sandbox: { name: podName, podIPs: ['127.0.0.1'] } }
    }
    this.bump(claim)
    this.emit('MODIFIED', claim)
  }

  async getClaim(name: string): Promise<Claim | null> {
    const claim = this.claims.get(name)
    return claim === undefined ? null : (structuredClone(claim) as unknown as Claim)
  }

  async patchClaim(name: string, patch: Json): Promise<Claim> {
    if (this.failPatches) throw new KubeError(500, 'patch refusé (test)')
    const claim = this.claims.get(name)
    if (claim === undefined) throw new KubeError(404, 'absent')
    const uid = (patch.metadata as { uid?: string } | undefined)?.uid
    if (uid !== undefined && uid !== claim.metadata.uid) throw new KubeError(409, 'uid ne correspond pas')
    merge(claim as unknown as Record<string, unknown>, patch)
    this.bump(claim)
    this.emit('MODIFIED', claim)
    return structuredClone(claim) as unknown as Claim
  }

  async deleteClaim(name: string, uid: string): Promise<'accepted' | 'absent'> {
    const claim = this.claims.get(name)
    if (claim === undefined) return 'absent'
    if (claim.metadata.uid !== uid) throw new KubeError(409, 'précondition UID')
    claim.metadata.deletionTimestamp = new Date().toISOString()
    this.bump(claim)
    this.emit('MODIFIED', claim)
    const podName = (claim.status?.sandbox as { name?: string } | undefined)?.name
    setTimeout(() => {
      this.claims.delete(name)
      this.emit('DELETED', claim)
      if (podName !== undefined) void this.bridges.get(podName)?.bridge.close()
    }, 20)
    return 'accepted'
  }

  /** What the safety deadline does: the infrastructure deletes the claim on its own. */
  expire(name: string): void {
    const claim = this.claims.get(name)
    if (claim === undefined) return
    claim.metadata.deletionTimestamp = new Date().toISOString()
    this.bump(claim)
    this.emit('MODIFIED', claim)
    this.claims.delete(name)
    this.emit('DELETED', claim)
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

  async getPod(): Promise<Json | null> {
    return { status: { phase: 'Running' } }
  }

  /** The Sandbox controller recreates a deleted Pod: same name, new bridge instance, empty home. */
  async deletePod(name: string): Promise<void> {
    await this.bridges.get(name)?.bridge.close()
    this.bridges.set(name, await mockBridge(this.publicKey, name))
  }

  async closeAll(): Promise<void> {
    for (const lab of this.bridges.values()) await lab.bridge.close().catch(() => {})
  }
}
