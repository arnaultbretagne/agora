import { readFileSync } from 'node:fs'
import { request } from 'node:https'

/**
 * Found live, P11: `relay.ts`'s own module doc originally assumed a service mesh sidecar
 * (mTLS/SPIFFE) would inject `X-Workload-Identity` on every CONNECT — no such mesh exists in this
 * cluster, so nothing ever set that header and every real relay CONNECT failed closed
 * (`407 missing_workload_identity`, surfaced by the real `claude` CLI's own proxy library as a
 * misleadingly-generic `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` — the CA/TLS chain itself was
 * always correct, verified directly against a live gateway connection).
 *
 * This resolves the SAME identity from something genuinely unforgeable by the Session Runtime Pod
 * itself instead: its own real source IP within this cluster's CNI, looked up against the
 * Kubernetes API to find which Pod (and therefore which `serviceAccountName(sessionId)`, the same
 * identity `apps/session-runtime-controller/src/labels.ts` already assigns at Pod creation) owns
 * it — the same "trust the transport" convention already used throughout this codebase
 * (`X-Forwarded-Email`, the control APIs' own mutualTLS assumption), reusing
 * `apps/session-runtime-controller/src/k8s-client.ts`'s own minimal in-cluster REST pattern
 * (deployables never import each other, so this is its own narrow copy, read-only, `get`/`list`
 * `pods` in `agora-runs` ONLY — the Broker otherwise owns no Kubernetes API access at all,
 * broker.yaml's own module doc).
 */
const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'
const CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'
const API_HOST = 'kubernetes.default.svc'
const API_PORT = 443

export interface WorkloadIdentityResolverOptions {
  readonly namespace: string
  readonly labelSelector: string
  /** Override for tests — production always reads the in-cluster mounted files. */
  readonly token?: string
  readonly ca?: Buffer
  readonly host?: string
  readonly port?: number
}

interface PodListItem {
  readonly spec?: { readonly serviceAccountName?: string }
  readonly status?: { readonly podIP?: string }
}

function listPods(options: {
  readonly namespace: string
  readonly labelSelector: string
  readonly token: string
  readonly ca: Buffer | undefined
  readonly host: string
  readonly port: number
}): Promise<readonly PodListItem[]> {
  const path = `/api/v1/namespaces/${options.namespace}/pods?labelSelector=${encodeURIComponent(options.labelSelector)}`
  return new Promise((resolve, reject) => {
    const req = request(
      { method: 'GET', hostname: options.host, port: options.port, path, ca: options.ca, headers: { authorization: `Bearer ${options.token}` } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) return reject(new Error(`k8s API GET ${path} -> ${status}: ${text}`))
          try {
            resolve((JSON.parse(text) as { items?: readonly PodListItem[] }).items ?? [])
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** `sourceIp` -> that Pod's own `spec.serviceAccountName`, or `undefined` if no Pod in the target namespace/label set currently has that address. */
export function createK8sWorkloadIdentityResolver(options: WorkloadIdentityResolverOptions): (sourceIp: string) => Promise<string | undefined> {
  const namespace = options.namespace
  const labelSelector = options.labelSelector
  const token = options.token ?? readFileSync(TOKEN_PATH, 'utf8').trim()
  const ca = options.ca ?? (options.token ? undefined : readFileSync(CA_PATH))
  const host = options.host ?? API_HOST
  const port = options.port ?? API_PORT

  return async function resolveWorkloadIdentity(sourceIp: string): Promise<string | undefined> {
    const items = await listPods({ namespace, labelSelector, token, ca, host, port })
    return items.find((item) => item.status?.podIP === sourceIp)?.spec?.serviceAccountName
  }
}
