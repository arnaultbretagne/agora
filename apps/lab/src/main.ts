// The lab: Agora's executions (packages/executions) mounted with the page that exercises every
// case of docs/executions.md. Configuration comes from the environment.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnchorStore, createAnchorReceiver, createApi, ExecutionManager, HttpKube, privateKeyFrom } from '@agora/executions'
import { GrantSigner } from '@agora/credentials'

function number(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number: ${raw}`)
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
const manager = new ExecutionManager({
  kube,
  anchors,
  signingKey: privateKeyFrom(readFileSync(required('SIGNING_KEY_FILE'), 'utf8')),
  defaults: {
    leaseSeconds: number('LEASE_SECONDS', 600),
    turnCapSeconds: number('TURN_CAP_SECONDS', 3600),
  },
  renewSeconds: number('RENEW_SECONDS', 60),
  maxActive: number('MAX_ACTIVE', 4),
  bridgePort: number('BRIDGE_PORT', 8080),
})

// docs/credentials.md: without the gateway, executions have no credential and no way out.
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

await manager.start()
const server = createApi({
  manager,
  anchors,
  lab: process.env.LAB === 'true',
  page: join(import.meta.dirname, '..', 'public', 'index.html'),
  ...(credentials === undefined ? {} : { credentials }),
})
server.listen(number('PORT', 8080), () => console.log(`- lab ready on :${String(number('PORT', 8080))}`))
const receiver = createAnchorReceiver({ manager, namespace, verify: (token) => kube.reviewToken(token, audience) })
receiver.listen(number('ANCHOR_PORT', 8081), () => console.log(`- anchor receiver on :${String(number('ANCHOR_PORT', 8081))}`))

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void manager.stop().finally(() => {
      server.close()
      receiver.close()
      process.exit(0)
    })
  })
}
