// The Kubernetes calls of docs/specs/executions.md ("The four operations") and nothing else: Agora never
// deletes anything — the infrastructure destroys at the deadline. Plain REST over fetch: the
// ServiceAccount token is re-read on every call (projected tokens rotate), and the cluster CA is
// trusted through NODE_EXTRA_CA_CERTS, set on the Deployment.
import { readFile } from 'node:fs/promises'

export const CLAIMS = '/apis/extensions.agents.x-k8s.io/v1beta1'
export const SANDBOXES = '/apis/agents.x-k8s.io/v1beta1'

export interface Condition {
  readonly type: string
  readonly status: string
  readonly reason?: string
  readonly message?: string
}

export interface ObjectMeta {
  readonly name: string
  readonly uid: string
  readonly resourceVersion?: string
  readonly creationTimestamp?: string
  readonly deletionTimestamp?: string
  readonly labels?: Record<string, string>
  readonly annotations?: Record<string, string>
}

export interface Claim {
  readonly metadata: ObjectMeta
  readonly spec?: { readonly warmPoolRef?: { readonly name?: string }; readonly lifecycle?: { readonly shutdownTime?: string } }
  readonly status?: { readonly conditions?: readonly Condition[]; readonly sandbox?: { readonly name?: string; readonly serviceFQDN?: string } }
}

export interface WatchEvent {
  readonly type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR'
  readonly object: Claim & { readonly code?: number; readonly message?: string }
}

export interface Pool {
  readonly metadata: ObjectMeta
  readonly spec?: { readonly replicas?: number; readonly sandboxTemplateRef?: { readonly name?: string } }
  readonly status?: { readonly replicas?: number; readonly readyReplicas?: number }
}

export type Json = Record<string, unknown>

export class KubeError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'KubeError'
    this.status = status
  }
}

/** Raised when a watch's resourceVersion is too old: the caller lists again. */
export class WatchGone extends Error {}

export interface KubeApi {
  listClaims(selector: string): Promise<{ items: Claim[]; resourceVersion: string }>
  watchClaims(selector: string, resourceVersion: string, onEvent: (event: WatchEvent) => void, signal: AbortSignal): Promise<void>
  createClaim(claim: Json): Promise<Claim>
  getClaim(name: string): Promise<Claim | null>
  patchClaim(name: string, patch: Json): Promise<Claim>
  listPools(selector: string): Promise<Pool[]>
  getTemplate(name: string): Promise<Json | null>
  getSandbox(name: string): Promise<Json | null>
  getPod(name: string): Promise<Json | null>
  /** Who holds this projected ServiceAccount token, as the API server sees it (TokenReview). */
  reviewToken(token: string, audience: string): Promise<PodIdentity | null>
}

export interface PodIdentity {
  readonly namespace: string
  readonly podName: string
  readonly podUid: string
}

export interface HttpKubeOptions {
  readonly apiBase: string
  readonly namespace: string
  readonly tokenFile: string
}

export class HttpKube implements KubeApi {
  private readonly options: HttpKubeOptions

  constructor(options: HttpKubeOptions) {
    this.options = options
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = (await readFile(this.options.tokenFile, 'utf8')).trim()
    return { authorization: `Bearer ${token}`, accept: 'application/json', ...extra }
  }

  private url(group: string, resource: string, name = '', query = ''): string {
    return `${this.options.apiBase}${group}/namespaces/${this.options.namespace}/${resource}${name === '' ? '' : `/${name}`}${query}`
  }

  private async call(method: string, url: string, body?: Json, contentType = 'application/json'): Promise<Response> {
    const response = await fetch(url, {
      method,
      headers: await this.headers(body === undefined ? {} : { 'content-type': contentType }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    })
    return response
  }

  private async expect<T>(response: Response, ...ok: number[]): Promise<T> {
    if (ok.includes(response.status)) return (await response.json()) as T
    let message = `${String(response.status)} ${response.statusText}`
    try {
      message = ((await response.json()) as { message?: string }).message ?? message
    } catch {
      // keep the status line
    }
    throw new KubeError(response.status, message)
  }

  async listClaims(selector: string): Promise<{ items: Claim[]; resourceVersion: string }> {
    const list = await this.expect<{ items: Claim[]; metadata: { resourceVersion: string } }>(
      await this.call('GET', this.url(CLAIMS, 'sandboxclaims', '', `?labelSelector=${encodeURIComponent(selector)}`)),
      200,
    )
    return { items: list.items, resourceVersion: list.metadata.resourceVersion }
  }

  async watchClaims(selector: string, resourceVersion: string, onEvent: (event: WatchEvent) => void, signal: AbortSignal): Promise<void> {
    const query = `?watch=1&allowWatchBookmarks=true&timeoutSeconds=300&resourceVersion=${encodeURIComponent(resourceVersion)}&labelSelector=${encodeURIComponent(selector)}`
    const response = await fetch(this.url(CLAIMS, 'sandboxclaims', '', query), { headers: await this.headers(), signal })
    if (response.status === 410) throw new WatchGone('resourceVersion too old')
    if (!response.ok || response.body === null) throw new KubeError(response.status, `watch refused: ${String(response.status)}`)
    const decoder = new TextDecoder()
    let pending = ''
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk as Uint8Array, { stream: true })
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (line.trim() === '') continue
        const event = JSON.parse(line) as WatchEvent
        if (event.type === 'ERROR') {
          if (event.object.code === 410) throw new WatchGone(event.object.message ?? 'watch expired')
          throw new KubeError(event.object.code ?? 500, event.object.message ?? 'watch error')
        }
        onEvent(event)
      }
    }
  }

  async createClaim(claim: Json): Promise<Claim> {
    return this.expect<Claim>(await this.call('POST', this.url(CLAIMS, 'sandboxclaims'), claim), 201, 200)
  }

  async getClaim(name: string): Promise<Claim | null> {
    const response = await this.call('GET', this.url(CLAIMS, 'sandboxclaims', name))
    if (response.status === 404) return null
    return this.expect<Claim>(response, 200)
  }

  async patchClaim(name: string, patch: Json): Promise<Claim> {
    return this.expect<Claim>(await this.call('PATCH', this.url(CLAIMS, 'sandboxclaims', name), patch, 'application/merge-patch+json'), 200)
  }

  async listPools(selector: string): Promise<Pool[]> {
    const list = await this.expect<{ items: Pool[] }>(
      await this.call('GET', this.url(CLAIMS, 'sandboxwarmpools', '', `?labelSelector=${encodeURIComponent(selector)}`)),
      200,
    )
    return list.items
  }

  private async getOptional(url: string): Promise<Json | null> {
    const response = await this.call('GET', url)
    if (response.status === 404) return null
    return this.expect<Json>(response, 200)
  }

  getTemplate(name: string): Promise<Json | null> {
    return this.getOptional(this.url(CLAIMS, 'sandboxtemplates', name))
  }

  getSandbox(name: string): Promise<Json | null> {
    return this.getOptional(this.url(SANDBOXES, 'sandboxes', name))
  }

  getPod(name: string): Promise<Json | null> {
    return this.getOptional(this.url('/api/v1', 'pods', name))
  }

  async reviewToken(token: string, audience: string): Promise<PodIdentity | null> {
    const review = await this.expect<{ status?: { authenticated?: boolean; audiences?: string[]; user?: { username?: string; extra?: Record<string, string[]> } } }>(
      await this.call('POST', `${this.options.apiBase}/apis/authentication.k8s.io/v1/tokenreviews`, {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenReview',
        spec: { token, audiences: [audience] },
      }),
      200,
      201,
    )
    const status = review.status
    if (status?.authenticated !== true || !(status.audiences ?? []).includes(audience)) return null
    // system:serviceaccount:<namespace>:<name>, plus the Pod the token is bound to.
    const namespace = /^system:serviceaccount:([^:]+):/.exec(status.user?.username ?? '')?.[1]
    const podName = status.user?.extra?.['authentication.kubernetes.io/pod-name']?.[0]
    const podUid = status.user?.extra?.['authentication.kubernetes.io/pod-uid']?.[0]
    if (namespace === undefined || podName === undefined || podUid === undefined) return null
    return { namespace, podName, podUid }
  }
}
