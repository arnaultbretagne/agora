// Carried over from archive/pre-design-cleanup-2026-09-05:apps/session-runtime-controller/src/k8s-client.ts
// (commit archive tag; findings §7); changes: watch with resourceVersion and relist on 410 Gone
// (the archived client only polled), Pod-only surface, and the same describeK8sError discipline.
import { readFileSync } from 'node:fs'
import { request } from 'node:https'

/** The API's own Status.message says WHY (quota, RBAC, admission) — a bare code turns a
 * self-explanatory refusal into an investigation (findings §4). */
export function describeK8sError(method: string, path: string, status: number, body: unknown): string {
  const message = typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
    ? (body as { message: string }).message
    : typeof body === 'string' && body.length > 0
      ? body
      : undefined
  return `k8s API ${method} ${path} -> ${status}${message ? `: ${message}` : ''}`
}

export interface HttpError extends Error {
  status: number
  body?: unknown
}

export type K8sObject = Record<string, unknown>

export interface K8sList {
  readonly items?: readonly K8sObject[]
  readonly metadata?: { readonly resourceVersion?: string }
}

export interface K8sClientOptions {
  readonly namespace: string
  readonly token?: string
  readonly ca?: Buffer
  readonly host?: string
  readonly port?: number
}

export interface K8sClient {
  readonly namespace: string
  createPod(pod: K8sObject): Promise<K8sObject>
  getPod(name: string): Promise<K8sObject | undefined>
  listPods(labelSelector?: string, resourceVersion?: string): Promise<K8sList & { readonly items: readonly K8sObject[] }>
  deletePod(name: string, gracePeriodSeconds?: number): Promise<void>
  /** Cluster-scoped: read-only, used only for P6 fencing evidence (a node's own Ready condition). */
  getNode(name: string): Promise<K8sObject | undefined>
  watchPods(labelSelector: string, resourceVersion: string): AsyncGenerator<{ type: string; object: K8sObject; resourceVersion: string | null }>
}

export class HttpK8sClient implements K8sClient {
  readonly namespace: string
  readonly #token: string
  readonly #ca: Buffer | undefined
  readonly #host: string
  readonly #port: number

  constructor(options: K8sClientOptions) {
    this.namespace = options.namespace
    this.#token = options.token ?? readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim()
    this.#ca = options.ca ?? (options.token ? undefined : readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'))
    this.#host = options.host ?? 'kubernetes.default.svc'
    this.#port = options.port ?? 443
  }

  createPod(pod: K8sObject): Promise<K8sObject> {
    return this.call('POST', `/api/v1/namespaces/${this.namespace}/pods`, pod)
  }

  async getPod(name: string): Promise<K8sObject | undefined> {
    try {
      return await this.call('GET', `/api/v1/namespaces/${this.namespace}/pods/${name}`)
    } catch (error) {
      if ((error as HttpError).status === 404) return undefined
      throw error
    }
  }

  async listPods(labelSelector?: string, resourceVersion?: string): Promise<K8sList & { readonly items: readonly K8sObject[] }> {
    const params = new URLSearchParams()
    if (labelSelector) params.set('labelSelector', labelSelector)
    if (resourceVersion) params.set('resourceVersion', resourceVersion)
    const query = params.size > 0 ? `?${params.toString()}` : ''
    const list = (await this.call('GET', `/api/v1/namespaces/${this.namespace}/pods${query}`)) as unknown as K8sList
    return { ...list, items: list.items ?? [] }
  }

  async deletePod(name: string, gracePeriodSeconds?: number): Promise<void> {
    try {
      await this.call('DELETE', `/api/v1/namespaces/${this.namespace}/pods/${name}${gracePeriodSeconds !== undefined ? `?gracePeriodSeconds=${gracePeriodSeconds}` : ''}`)
    } catch (error) {
      if ((error as HttpError).status === 404) return
      throw error
    }
  }

  async getNode(name: string): Promise<K8sObject | undefined> {
    try {
      return await this.call('GET', `/api/v1/nodes/${name}`)
    } catch (error) {
      if ((error as HttpError).status === 404) return undefined
      throw error
    }
  }

  /**
   * Streams watch events as they arrive — a real watch is only a recovery-sweep replacement when
   * events are delivered as they happen, not buffered until the connection eventually closes
   * (engine.md — watches are live-source mechanisms). The watch ends (relist required) on a 410
   * Gone `ERROR` event, on connection close, or when the caller stops iterating.
   */
  async *watchPods(labelSelector: string, resourceVersion: string): AsyncGenerator<{ type: string; object: K8sObject; resourceVersion: string | null }> {
    const path = `/api/v1/namespaces/${this.namespace}/pods?watch=true&allowWatchBookmarks=true&labelSelector=${encodeURIComponent(labelSelector)}&resourceVersion=${encodeURIComponent(resourceVersion)}`
    for await (const line of this.stream(path)) {
      const parsed = JSON.parse(line) as { type?: string; object?: K8sObject }
      if (parsed.type === 'ERROR') {
        throw Object.assign(new Error(describeK8sError('WATCH', path, 410, parsed.object)), { status: 410 })
      }
      const rv = (parsed.object?.['metadata'] as { resourceVersion?: string } | undefined)?.resourceVersion ?? null
      yield { type: parsed.type ?? 'MODIFIED', object: parsed.object ?? {}, resourceVersion: rv }
    }
  }

  /** Yields each newline-delimited chunk as it arrives on the still-open response body. */
  private stream(path: string): AsyncGenerator<string> {
    const host = this.#host
    const port = this.#port
    const ca = this.#ca
    const token = this.#token
    async function* generate(): AsyncGenerator<string> {
      const req = request({
        method: 'GET',
        hostname: host,
        port,
        path,
        ca,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
      req.end()
      const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        req.on('response', resolve)
        req.on('error', reject)
      })
      let buffer = ''
      for await (const chunk of res as AsyncIterable<Buffer>) {
        buffer += chunk.toString('utf8')
        let newline: number
        // eslint-disable-next-line no-cond-assign
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line.trim().length > 0) yield line
        }
      }
      if (buffer.trim().length > 0) yield buffer
    }
    return generate()
  }

  /**
   * Every Kubernetes call, timed, with anything slow said out loud. The Pod inventory measured
   * 175-796 ms from the control plane for what a shell does in 53 ms, and the variance said waiting
   * rather than work — but "the apiserver was slow" and "this process was busy" are the same
   * duration from outside, so the request itself has to be the thing that reports.
   */
  private call(method: string, path: string, body?: unknown): Promise<K8sObject> {
    const started = Date.now()
    const done = <T>(value: T): T => {
      const elapsed = Date.now() - started
      if (elapsed >= 100) console.log(`k8s ${method} ${path.split('?')[0] ?? path} took ${String(elapsed)}ms`)
      return value
    }
    return new Promise<K8sObject>((resolveRaw, rejectRaw) => {
      const resolve = (value: K8sObject): void => resolveRaw(done(value))
      const reject = (error: unknown): void => {
        done(null)
        rejectRaw(error)
      }
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined
      const req = request(
        {
          method,
          hostname: this.#host,
          port: this.#port,
          path,
          ca: this.#ca,
          headers: {
            authorization: `Bearer ${this.#token}`,
            'content-type': 'application/json',
            ...(data ? { 'content-length': String(data.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            const status = res.statusCode ?? 0
            let json: unknown
            try {
              json = text ? JSON.parse(text) : undefined
            } catch {
              json = text
            }
            if (status >= 200 && status < 300) return resolve(json as K8sObject)
            reject(Object.assign(new Error(describeK8sError(method, path, status, json)), { status, body: json }))
          })
        },
      )
      req.on('error', reject)
      if (data !== undefined) req.write(data)
      req.end()
    })
  }
}
