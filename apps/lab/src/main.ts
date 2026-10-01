// The lab: Agora's executions (packages/executions) mounted with the page that exercises every
// case of docs/specs/executions.md. Configuration comes from the environment.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AnchorStore,
  createAnchorReceiver,
  createApi,
  ExecutionManager,
  HttpKube,
  privateKeyFrom,
} from '@agora/executions'
import { LogStore, LogDriver, logHttp, gatewayCredentials } from '@agora/log'
import { GrantSigner } from '@agora/credentials'

function number(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
  return value
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

const namespace = required('SANDBOX_NAMESPACE')
const audience = process.env.ANCHOR_AUDIENCE ?? 'agora-anchors'
const anchors = new AnchorStore(process.env.ANCHOR_DIR ?? '/data/anchors')
const kube = new HttpKube({
  apiBase: process.env.KUBE_API ?? 'https://kubernetes.default.svc',
  namespace,
  tokenFile: process.env.KUBE_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
})
const signingKey = privateKeyFrom(readFileSync(required('SIGNING_KEY_FILE'), 'utf8'))
const credentials =
  process.env.GATEWAY_PROXY === undefined || process.env.GATEWAY_PROXY === ''
    ? undefined
    : new GrantSigner({
        proxy: process.env.GATEWAY_PROXY,
        keyFile: required('GRANTS_KEY_FILE'),
        keyId: process.env.GRANTS_KEY_ID ?? 'agora-grants-1',
        issuer: process.env.GRANTS_ISSUER ?? 'agora',
        audience: process.env.GRANTS_AUDIENCE ?? 'agora-gateway',
      })
const logConfigured = ['LOG_WRITER_URL', 'LOG_PROJECTOR_URL', 'LOG_ANCHORS_URL'].some((key) => process.env[key])
const logStore = logConfigured
  ? new LogStore({
      writer: required('LOG_WRITER_URL'),
      projector: required('LOG_PROJECTOR_URL'),
      anchors: required('LOG_ANCHORS_URL'),
    })
  : null
const logDriver = logStore
  ? new LogDriver({
      store: logStore,
      kube,
      signingKey,
      bridgePort: number('BRIDGE_PORT', 8080),
      renewSeconds: number('RENEW_SECONDS', 60),
      maxActive: number('MAX_ACTIVE', 4),
      sink: (line) => console.log(line),
      ...(credentials ? { credentials: gatewayCredentials(logStore, kube, credentials) } : {}),
    })
  : null
const manager = new ExecutionManager({
  kube,
  anchors,
  signingKey,
  defaults: {
    leaseSeconds: number('LEASE_SECONDS', 600),
    turnCapSeconds: number('TURN_CAP_SECONDS', 3600),
  },
  renewSeconds: number('RENEW_SECONDS', 60),
  maxActive: number('MAX_ACTIVE', 4),
  bridgePort: number('BRIDGE_PORT', 8080),
  ...(logConfigured ? { log: null } : {}),
})

try {
  await logDriver?.start()
} catch {
  console.error(JSON.stringify({ operation: 'recover', outcome: 'failed', errorClass: 'database' }))
  process.exit(1)
}
await manager.start()
const server = createApi({
  manager,
  anchors,
  lab: process.env.LAB === 'true',
  page: join(import.meta.dirname, '..', 'public', logDriver && process.env.LAB === 'true' ? 'log.html' : 'index.html'),
  ...(logDriver && process.env.LAB === 'true'
    ? { handle: (req, res) => logHttp(logDriver, req, res, credentials) }
    : {}),
  ...(credentials === undefined ? {} : { credentials }),
})
server.listen(number('PORT', 8080), () => console.log(`- lab ready on :${String(number('PORT', 8080))}`))
const receiver = createAnchorReceiver({
  manager: {
    receiveAnchor: async (pod, bundle, raw, podUid) => {
      if (logDriver) {
        const answer = await logDriver.receiveAnchor(pod, bundle, raw, podUid)
        if (answer.accepted) return { accepted: true, value: { anchorId: answer.command } }
        if (answer.reason === 'anchor_conflict') return { accepted: false, status: 409, reason: answer.reason }
        if (answer.reason !== 'unknown_execution') return { accepted: false, status: 503, reason: answer.reason }
      }
      return manager.receiveAnchor(pod, bundle, raw)
    },
  },
  namespace,
  verify: (token) => kube.reviewToken(token, audience),
})
receiver.listen(number('ANCHOR_PORT', 8081), () =>
  console.log(`- anchor receiver on :${String(number('ANCHOR_PORT', 8081))}`),
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // The clean-drain budget includes database pool shutdown.
    const forceExit = setTimeout(() => process.exit(0), 5000)
    void Promise.all([manager.stop(), logDriver?.stop()])
      .then(() => logStore?.close())
      .finally(() => {
        clearTimeout(forceExit)
        server.close()
        receiver.close()
        process.exit(0)
      })
  })
}
