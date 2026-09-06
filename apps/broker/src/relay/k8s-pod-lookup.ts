// Read-only Pod lookup by IP (P10, field-findings §3.3: the relay resolves a connecting Pod's
// workload identity from its own source IP against the Kubernetes Pod inventory — this cluster has
// no service mesh to inject a workload-identity header, and the Pod cannot forge its source IP
// within the CNI). Scoped to get/list Pods in one namespace; no write authority at all — a
// deliberately narrower surface than apps/runtime-control's own K8sClient, which this deployable
// cannot import (ADR 0001: no deployable depends on another).
import { readFileSync } from 'node:fs'
import { request } from 'node:https'

export type K8sObject = Record<string, unknown>

export interface K8sPodLookup {
  findByPodIP(ip: string): Promise<K8sObject | undefined>
}

export interface HttpK8sPodLookupOptions {
  readonly namespace: string
  readonly token?: string
  readonly ca?: Buffer
  readonly host?: string
  readonly port?: number
}

export class HttpK8sPodLookup implements K8sPodLookup {
  readonly #namespace: string
  readonly #token: string
  readonly #ca: Buffer | undefined
  readonly #host: string
  readonly #port: number

  constructor(options: HttpK8sPodLookupOptions) {
    this.#namespace = options.namespace
    this.#token = options.token ?? readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim()
    this.#ca = options.ca ?? (options.token ? undefined : readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'))
    this.#host = options.host ?? 'kubernetes.default.svc'
    this.#port = options.port ?? 443
  }

  async findByPodIP(ip: string): Promise<K8sObject | undefined> {
    // `::ffff:`-mapped IPv4 addresses must be normalized before matching status.podIP (field-findings §3.3).
    const normalized = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip
    const path = `/api/v1/namespaces/${this.#namespace}/pods?fieldSelector=${encodeURIComponent(`status.podIP=${normalized}`)}`
    const list = (await this.call(path)) as { items?: readonly K8sObject[] }
    return list.items?.[0]
  }

  private call(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = request(
        { method: 'GET', hostname: this.#host, port: this.#port, path, ca: this.#ca, headers: { authorization: `Bearer ${this.#token}` } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const status = res.statusCode ?? 0
            const text = Buffer.concat(chunks).toString('utf8')
            if (status >= 200 && status < 300) return resolve(text ? JSON.parse(text) : undefined)
            reject(new Error(`k8s API GET ${path} -> ${status}: ${text}`))
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
  }
}
