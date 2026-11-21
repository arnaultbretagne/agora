// A preview (docs/specs/preview.md): the server and the client of a pull request with nothing of
// production. Its database is its own, reached on its owner's one login; its one pool runs the mock agent
// in this process, each sandbox a real bridge on the loopback; its files stay in memory; its signing key
// is made at start. Nothing of the cluster is called: no API server, no gateway, no bucket.
import { generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { startBridge, pushBundle, type Bridge } from '@agora/harness-bridge'
import { sessionsDir } from '@agora/mock-agent/storage'
import { HARNESS_LABEL, KubeError, SESSION_CONFIG_ANNOTATION, type Claim, type CredentialSource, type Json, type KubeApi, type PodIdentity, type Pool, type Sandbox, type WatchEvent } from '@agora/executions'
import { Files } from '@agora/log'

/** The owner of every Workstream of a preview: the client's own when no proxy names anyone. */
export const SHARED_OWNER = '00000000-0000-4000-8000-000000000000'
/** The namespace the preview's sandboxes say they are in: the anchor receiver takes theirs only. */
export const NAMESPACE = 'agora-preview'
/** The preview's one pool, and the harness it runs. */
export const POOL = 'mock'

/** What only production sets: a preview that is given any of them does not start. */
export const PRODUCTION = [
  'SANDBOX_NAMESPACE',
  'SIGNING_KEY_FILE',
  'KUBE_API',
  'KUBE_TOKEN_FILE',
  'LOG_WRITER_URL',
  'LOG_PROJECTOR_URL',
  'LOG_ANCHORS_URL',
  'FILES_ENDPOINT',
  'FILES_BUCKET',
  'FILES_ACCESS_KEY_ID',
  'FILES_SECRET_ACCESS_KEY',
  'GATEWAY_PROXY',
  'GRANTS_KEY_FILE',
  'OFFERED_PROFILES',
  'POD_IP',
  'GATEWAY_CA_FILE',
  'GITHUB_TEST_API',
  'IDENTITY_ISSUER',
  'IDENTITY_AUDIENCE',
  'IDENTITY_TOKENS_DIR',
] as const

/** The preview's database: `PREVIEW_DATABASE_URL`, its owner's login; refused beside anything of production. */
export function previewDatabase(env: NodeJS.ProcessEnv): string {
  const set: string[] = PRODUCTION.filter((name) => env[name] !== undefined && env[name] !== '')
  // A preview's identity is `none` (docs/specs/log.md, "Identity"): IDENTITY, when given, says so.
  if (env.IDENTITY !== undefined && env.IDENTITY !== '' && env.IDENTITY !== 'none') set.push('IDENTITY')
  if (set.length > 0) throw new Error(`PREVIEW excludes ${set.join(', ')}`)
  const url = env.PREVIEW_DATABASE_URL
  if (url === undefined || url === '') throw new Error('PREVIEW_DATABASE_URL is required')
  return url
}

/** The bucket in memory: a file lives as long as the process. */
export class MemoryFiles extends Files {
  private readonly stored = new Map<string, { bytes: Buffer; modified: number }>()

  constructor() {
    // Never reached: every call that would is replaced below.
    super({ endpoint: 'http://127.0.0.1:9', bucket: 'preview', accessKeyId: 'preview', secretAccessKey: 'preview' })
  }

  override async put(sha256: string, bytes: Buffer): Promise<void> {
    if (!this.stored.has(sha256)) this.stored.set(sha256, { bytes: Buffer.from(bytes), modified: Date.now() })
  }

  override async get(sha256: string): Promise<Buffer> {
    const found = this.stored.get(sha256)
    if (found === undefined) throw new Error('files_unavailable')
    return found.bytes
  }

  override async stream(sha256: string): Promise<{ body: Readable; size: number | undefined } | null> {
    const found = this.stored.get(sha256)
    return found === undefined ? null : { body: Readable.from([found.bytes]), size: found.bytes.byteLength }
  }

  override async *objects(): AsyncGenerator<{ sha256: string; modified: number }> {
    for (const [sha256, { modified }] of [...this.stored]) yield { sha256, modified }
  }

  override async remove(sha256s: readonly string[]): Promise<void> {
    for (const sha256 of sha256s) this.stored.delete(sha256)
  }
}

type Mutable = { metadata: Record<string, unknown> & { name: string; uid: string; labels?: Record<string, string> }; spec: Record<string, unknown>; status?: Record<string, unknown> }

function merge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key]
    else if (typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object' && target[key] !== null) merge(target[key] as Record<string, unknown>, value as Record<string, unknown>)
    else target[key] = typeof value === 'object' ? structuredClone(value) : value
  }
}

const copy = (claim: Mutable): Claim => structuredClone(claim) as unknown as Claim

interface Pod {
  readonly bridge: Bridge
  readonly home: string
  readonly uid: string
  /** The token its anchor is pushed with: `reviewToken` knows it, and nobody else. */
  readonly token: string
}

/**
 * Kubernetes and Agent Sandbox as the execution mechanics call them, in this process: a claim is bound at
 * once to a sandbox of its own — a bridge on the loopback with the mock agent — and at its deadline the
 * sandbox ends as a Pod does, its native files pushed to the anchor receiver, then the claim goes.
 */
export class PreviewKube implements KubeApi {
  private readonly claims = new Map<string, Mutable>()
  private readonly pods = new Map<string, Pod>()
  private readonly watchers = new Set<(event: WatchEvent) => void>()
  private readonly tokens: string
  private readonly timer: NodeJS.Timeout
  private version = 1
  private counter = 0

  private readonly publicKey: KeyObject
  /** Where a sandbox pushes its anchor at its end: the server's own receiver. */
  private readonly anchorUrl: string

  constructor(publicKey: KeyObject, anchorUrl: string) {
    this.publicKey = publicKey
    this.anchorUrl = anchorUrl
    this.tokens = mkdtempSync(join(tmpdir(), 'preview-tokens-'))
    this.timer = setInterval(() => this.expire(), 500)
  }

  private emit(type: WatchEvent['type'], claim: Mutable): void {
    const event = { type, object: copy(claim) } as WatchEvent
    for (const watcher of this.watchers) watcher(event)
  }

  private bump(claim: Mutable): void {
    claim.metadata.resourceVersion = String(++this.version)
  }

  async listClaims(): Promise<{ items: Claim[]; resourceVersion: string }> {
    return { items: [...this.claims.values()].map(copy), resourceVersion: String(this.version) }
  }

  watchClaims(_selector: string, _version: string, onEvent: (event: WatchEvent) => void, signal: AbortSignal): Promise<void> {
    this.watchers.add(onEvent)
    return new Promise((resolve) => {
      const stop = () => {
        this.watchers.delete(onEvent)
        resolve()
      }
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop)
    })
  }

  async createClaim(input: Json): Promise<Claim> {
    const claim = structuredClone(input) as unknown as Mutable
    const name = claim.metadata.name
    if (this.claims.has(name)) throw new KubeError(409, `sandboxclaims "${name}" already exists`)
    claim.metadata.uid = randomUUID()
    claim.metadata.creationTimestamp = new Date().toISOString()
    claim.status = { conditions: [{ type: 'Ready', status: 'False', reason: 'SandboxNotReady' }] }
    this.bump(claim)
    this.claims.set(name, claim)
    this.emit('ADDED', claim)
    void this.bind(name)
    return copy(claim)
  }

  /** The claim's sandbox: a bridge with the mock agent, its home a directory of its own. */
  private async bind(name: string): Promise<void> {
    const claim = this.claims.get(name)
    if (claim === undefined) return
    const pool = (claim.spec.warmPoolRef as { name?: string } | undefined)?.name
    if (pool !== POOL) {
      claim.status = { conditions: [{ type: 'Ready', status: 'False', reason: 'WarmPoolNotFound', message: `no pool ${String(pool)}` }] }
    } else {
      const podName = `${POOL}-${String(++this.counter)}`
      const home = mkdtempSync(join(tmpdir(), `${podName}-`))
      const workspace = join(home, 'work')
      const bridge = await startBridge({
        port: 0,
        host: '127.0.0.1',
        // Its environment is its own: nothing of the server's reaches the agent.
        adapterCommand: ['env', '-i', `HOME=${home}`, `PATH=${process.env.PATH ?? '/usr/bin:/bin'}`, 'NODE_NO_WARNINGS=1', process.execPath, fileURLToPath(import.meta.resolve('@agora/mock-agent/agent'))],
        workspace,
        podName,
        publicKey: this.publicKey,
        harness: POOL,
        nativeDir: sessionsDir(home, workspace),
        adapterStopMs: 1000,
        log: () => {},
      })
      if (!this.claims.has(name)) {
        await bridge.close()
        rmSync(home, { recursive: true, force: true })
        return
      }
      this.pods.set(podName, { bridge, home, uid: randomUUID(), token: randomBytes(24).toString('hex') })
      claim.status = {
        conditions: [{ type: 'Ready', status: 'True', reason: 'SandboxReady' }],
        sandbox: { name: podName, serviceFQDN: `127.0.0.1:${String(bridge.port())}` },
      }
    }
    this.bump(claim)
    this.emit('MODIFIED', claim)
  }

  /** At its deadline a claim is deleted: its sandbox ends and pushes its anchor, as a Pod at its SIGTERM. */
  private expire(): void {
    for (const [name, claim] of this.claims) {
      const deadline = Date.parse(String((claim.spec.lifecycle as { shutdownTime?: string } | undefined)?.shutdownTime))
      if (claim.metadata.deletionTimestamp !== undefined || !(deadline <= Date.now())) continue
      claim.metadata.deletionTimestamp = new Date().toISOString()
      this.bump(claim)
      this.emit('MODIFIED', claim)
      const podName = (claim.status?.sandbox as { name?: string } | undefined)?.name
      void (async () => {
        const pod = podName === undefined ? undefined : this.pods.get(podName)
        if (pod !== undefined) {
          try {
            const bundle = await pod.bridge.terminate()
            const tokenFile = join(this.tokens, podName!)
            writeFileSync(tokenFile, pod.token)
            await pushBundle(this.anchorUrl, tokenFile, bundle, { attempts: 2 })
          } finally {
            await pod.bridge.close().catch(() => {})
            rmSync(pod.home, { recursive: true, force: true })
          }
        }
        this.claims.delete(name)
        if (podName !== undefined) this.pods.delete(podName)
        this.bump(claim)
        this.emit('DELETED', claim)
      })().catch(() => {})
    }
  }

  async getClaim(name: string): Promise<Claim | null> {
    const claim = this.claims.get(name)
    return claim === undefined ? null : copy(claim)
  }

  async patchClaim(name: string, patch: Json): Promise<Claim> {
    const claim = this.claims.get(name)
    if (claim === undefined) throw new KubeError(404, `sandboxclaims "${name}" not found`)
    const uid = (patch.metadata as { uid?: string } | undefined)?.uid
    if (uid !== undefined && uid !== claim.metadata.uid) throw new KubeError(409, 'the object has been modified: uid precondition failed')
    merge(claim as unknown as Record<string, unknown>, patch)
    this.bump(claim)
    this.emit('MODIFIED', claim)
    return copy(claim)
  }

  /** The one pool, always ready: its sandboxes are made when a claim comes, none waits warm. */
  async listPools(): Promise<Pool[]> {
    return [
      {
        metadata: { name: POOL, uid: POOL, labels: { [HARNESS_LABEL]: POOL }, annotations: { [SESSION_CONFIG_ANNOTATION]: 'mode=full-access' } },
        spec: { replicas: 2, sandboxTemplateRef: { name: POOL } },
        status: { replicas: 2, readyReplicas: 2 },
      },
    ]
  }

  async getTemplate(): Promise<Json | null> {
    return { spec: { podTemplate: { spec: { containers: [{ name: 'sandbox', image: 'agora-mock-agent (preview)' }] } } } }
  }

  async getSandbox(name: string): Promise<Json | null> {
    return this.pods.has(name) ? { metadata: { name, labels: { 'agents.x-k8s.io/launch-type': 'cold' } }, status: { podIPs: ['127.0.0.1'] } } : null
  }

  async listSandboxes(): Promise<Sandbox[]> {
    return [...this.claims.values()].flatMap((claim) => {
      const sandbox = claim.status?.sandbox as { name?: string; serviceFQDN?: string } | undefined
      if (sandbox?.name === undefined) return []
      return [{ metadata: { name: sandbox.name, uid: this.pods.get(sandbox.name)?.uid ?? sandbox.name, ownerReferences: [{ kind: 'SandboxClaim', name: claim.metadata.name }] }, status: { conditions: [{ type: 'Ready', status: 'True' }], serviceFQDN: sandbox.serviceFQDN ?? '', podIPs: ['127.0.0.1'] } }]
    })
  }

  async getPod(name: string): Promise<Json | null> {
    const pod = this.pods.get(name)
    return pod === undefined ? null : { metadata: { name, uid: pod.uid }, status: { phase: 'Running' } }
  }

  async reviewToken(token: string): Promise<PodIdentity | null> {
    for (const [podName, pod] of this.pods) if (pod.token === token) return { namespace: NAMESPACE, podName, podUid: pod.uid }
    return null
  }

  async close(): Promise<void> {
    clearInterval(this.timer)
    for (const pod of this.pods.values()) {
      await pod.bridge.close().catch(() => {})
      rmSync(pod.home, { recursive: true, force: true })
    }
  }
}

/** The preview's signing key: made at start, its public half handed to its own bridges. */
export function previewKeys(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('ed25519')
}

/**
 * What a preview's access picker offers (docs/specs/preview.md, "The offer"): what each of its entries folds,
 * the repositories invented. Said by `GET /api/config` alone: nothing signs for it, and an execution
 * given any of them reaches no more than one given none.
 */
export const PREVIEW_OFFERED = ['internet', 'zai', 'chatgpt', 'antigravity', 'github:example/app:write', 'github:example/docs:write', 'github:example/site:read', 'vault:write', 'kubernetes:read', 'agora:read', 'agora:delegate', 'previews'] as const

/** The offer as the configuration says it: no proxy, no profile of its own, and never a token. */
export function previewOffer(): CredentialSource {
  return {
    offered: PREVIEW_OFFERED,
    describe: () => ({ proxy: null, profiles: [], base: [], offered: [...PREVIEW_OFFERED] }),
    mint: () => Promise.reject(new Error('preview_signs_nothing')),
  }
}
