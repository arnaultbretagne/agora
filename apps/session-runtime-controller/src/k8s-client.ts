import { readFileSync } from 'node:fs'
import { request } from 'node:https'

/**
 * Minimal in-cluster Kubernetes API client: raw `node:https` against `kubernetes.default.svc`
 * with the mounted ServiceAccount token, no `@kubernetes/client-node` dependency. Reused (with
 * adaptation) from `/srv/agent-runtime/src/k8s.ts` (agent-runtime ADR 0010 §1.3) per this plan's
 * reuse audit — "candidate reuse: Kubernetes client primitives" — extended here with ServiceAccount
 * CRUD (Pod-only in the source). The controller polls; it never watches, matching the source's
 * design ("the manager polls, it never watches").
 */

const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'
const CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'
const API_HOST = 'kubernetes.default.svc'
const API_PORT = 443

/**
 * Builds the message an API refusal travels under. The API's own `Status.message` says WHY, and it
 * is the only thing that does — it was being captured on `err.body` and then dropped, because only
 * the message survives the trip up through the controller's Problem response into the Session's
 * `failure_detail`.
 *
 * Found live 2026-08-07: a Session failed with "unexpected controller error: k8s API POST
 * /api/v1/namespaces/agora-runs/pods -> 403" and nothing else. Chasing it went through RBAC and
 * admission policy before a hand-built dry-run finally revealed the real cause — "exceeded quota:
 * agora-runs-quota" — which the API had said all along. A bare status code turns a
 * self-explanatory refusal into an investigation.
 */
export function describeK8sError(method: string, path: string, status: number, body: unknown): string {
  const message = typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
    ? (body as { message: string }).message
    : undefined
  return `k8s API ${method} ${path} -> ${status}${message ? `: ${message}` : ''}`
}

export interface HttpError extends Error {
  status: number
  body?: unknown
}

export interface K8sObject {
  readonly apiVersion?: string
  readonly kind?: string
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string>; [key: string]: unknown }
  readonly [key: string]: unknown
}

export interface K8sList {
  readonly items: readonly K8sObject[]
}

export interface K8sClientOptions {
  readonly namespace: string
  /** Override for local/unit tests — production always reads the in-cluster mounted files. */
  readonly token?: string
  readonly ca?: Buffer
  /** Override for out-of-cluster verification (e.g. from the node host against `localhost:6443`)
   * — production always talks to the in-cluster API service DNS name. */
  readonly host?: string
  readonly port?: number
}

/** The subset of the Kubernetes API this controller needs — implemented by `K8sClient` (real) and
 * test doubles (in-memory), so reconciliation/PodSpec logic is unit-testable without a live cluster. */
export interface KubernetesPods {
  createPod(pod: K8sObject): Promise<K8sObject>
  getPod(name: string): Promise<K8sObject | undefined>
  listPods(labelSelector: string): Promise<readonly K8sObject[]>
  deletePod(name: string, gracePeriodSeconds?: number): Promise<void>
  createServiceAccount(serviceAccount: K8sObject): Promise<K8sObject>
  getServiceAccount(name: string): Promise<K8sObject | undefined>
  deleteServiceAccount(name: string): Promise<void>
}

export class K8sClient implements KubernetesPods {
  private readonly namespace: string
  private readonly token: string
  private readonly ca: Buffer | undefined
  private readonly host: string
  private readonly port: number

  constructor(options: K8sClientOptions) {
    this.namespace = options.namespace
    this.token = options.token ?? readFileSync(TOKEN_PATH, 'utf8').trim()
    this.ca = options.ca ?? (options.token ? undefined : readFileSync(CA_PATH))
    this.host = options.host ?? API_HOST
    this.port = options.port ?? API_PORT
  }

  createPod(pod: K8sObject): Promise<K8sObject> {
    return this.call('POST', `/api/v1/namespaces/${this.namespace}/pods`, pod)
  }

  async getPod(name: string): Promise<K8sObject | undefined> {
    return this.getOrUndefined(`/api/v1/namespaces/${this.namespace}/pods/${name}`)
  }

  async listPods(labelSelector: string): Promise<readonly K8sObject[]> {
    const path = `/api/v1/namespaces/${this.namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`
    const res = (await this.call('GET', path)) as unknown as K8sList
    return res.items ?? []
  }

  async deletePod(name: string, gracePeriodSeconds?: number): Promise<void> {
    await this.deleteIgnoring404(
      `/api/v1/namespaces/${this.namespace}/pods/${name}${gracePeriodSeconds !== undefined ? `?gracePeriodSeconds=${gracePeriodSeconds}` : ''}`,
    )
  }

  createServiceAccount(serviceAccount: K8sObject): Promise<K8sObject> {
    return this.call('POST', `/api/v1/namespaces/${this.namespace}/serviceaccounts`, serviceAccount)
  }

  async getServiceAccount(name: string): Promise<K8sObject | undefined> {
    return this.getOrUndefined(`/api/v1/namespaces/${this.namespace}/serviceaccounts/${name}`)
  }

  async deleteServiceAccount(name: string): Promise<void> {
    await this.deleteIgnoring404(`/api/v1/namespaces/${this.namespace}/serviceaccounts/${name}`)
  }

  private async getOrUndefined(path: string): Promise<K8sObject | undefined> {
    try {
      return await this.call('GET', path)
    } catch (err) {
      if ((err as HttpError).status === 404) return undefined
      throw err
    }
  }

  private async deleteIgnoring404(path: string): Promise<void> {
    try {
      await this.call('DELETE', path)
    } catch (err) {
      if ((err as HttpError).status === 404) return
      throw err
    }
  }

  private call(method: string, path: string, body?: unknown): Promise<K8sObject> {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined
      const req = request(
        {
          method,
          hostname: this.host,
          port: this.port,
          path,
          ca: this.ca,
          headers: {
            authorization: `Bearer ${this.token}`,
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
            const err = new Error(describeK8sError(method, path, status, json)) as HttpError
            err.status = status
            err.body = json
            reject(err)
          })
        },
      )
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  }
}
