// The lab: the execution mechanics (packages/executions) and the log (packages/log) mounted together,
// with the page that plays the cases of docs/specs/executions.md, credentials.md and log.md.
// Configuration comes from the environment.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAnchorReceiver, createApi, ExecutionManager, HttpKube, privateKeyFrom } from '@agora/executions'
import { LogStore, Workstreams, logHttp, telemetry } from '@agora/log'
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

const sink = (line: string): void => console.log(line)
const namespace = required('SANDBOX_NAMESPACE')
const audience = process.env.ANCHOR_AUDIENCE ?? 'agora-anchors'
const lab = process.env.LAB === 'true'
const kube = new HttpKube({
  apiBase: process.env.KUBE_API ?? 'https://kubernetes.default.svc',
  namespace,
  tokenFile: process.env.KUBE_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
})
// docs/specs/credentials.md: without the gateway, executions have no credential and no way out.
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
const store = new LogStore({ writer: required('LOG_WRITER_URL'), projector: required('LOG_PROJECTOR_URL'), anchors: required('LOG_ANCHORS_URL') })
const executions = new ExecutionManager({
  kube,
  signingKey: privateKeyFrom(readFileSync(required('SIGNING_KEY_FILE'), 'utf8')),
  bridgePort: number('BRIDGE_PORT', 8080),
})
// A fault point for tests (docs/reliability/README.md, rule 4): AGORA_FAULT=<point>[:<method>] kills
// this process there, as a crash would.
const faultSpec = process.env.AGORA_FAULT
const workstreams = new Workstreams({
  ...(faultSpec
    ? {
        fault: (point: string, detail: { method?: string | null }) => {
          const [at, method] = faultSpec.split(':')
          if (point === at && (method === undefined || detail.method === method)) process.kill(process.pid, 'SIGKILL')
        },
      }
    : {}),
  store,
  executions,
  defaults: { leaseSeconds: number('LEASE_SECONDS', 600), turnCapSeconds: number('TURN_CAP_SECONDS', 3600) },
  maxActive: number('MAX_ACTIVE', 4),
  renewSeconds: number('RENEW_SECONDS', 60),
  sink,
})

try {
  await workstreams.start()
} catch {
  telemetry({ operation: 'recover', outcome: 'failed', errorClass: 'database' }, sink)
  process.exit(1)
}

const server = createApi({
  manager: executions,
  lab,
  page: join(import.meta.dirname, '..', 'public', 'index.html'),
  handle: (req, res) => logHttp(workstreams, req, res, { lab, ...(credentials === undefined ? {} : { credentials }) }),
  ...(credentials === undefined ? {} : { credentials }),
  // docs/specs/executions.md, "The lab": a clean stop drains like a SIGTERM; a kill leaves no trace.
  onRestart: (mode) => process.kill(process.pid, mode === 'kill' ? 'SIGKILL' : 'SIGTERM'),
})
server.listen(number('PORT', 8080), () => console.log(`- lab ready on :${String(number('PORT', 8080))}`))
const receiver = createAnchorReceiver({
  receive: (pod, bundle, raw) => workstreams.receiveAnchor(pod, bundle, raw),
  namespace,
  verify: (token) => kube.reviewToken(token, audience),
})
receiver.listen(number('ANCHOR_PORT', 8081), () => console.log(`- anchor receiver on :${String(number('ANCHOR_PORT', 8081))}`))

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // docs/specs/log.md, "Backpressure and shutdown": 5 s to drain, then whatever is left breaks uncleanly.
    const forceExit = setTimeout(() => process.exit(0), 8000)
    void workstreams
      .stop()
      .then(() => store.close())
      .finally(() => {
        clearTimeout(forceExit)
        server.close()
        receiver.close()
        process.exit(0)
      })
  })
}
