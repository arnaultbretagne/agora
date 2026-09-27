// The back-end process: configuration from the environment, then the manager and its API.
import { readFileSync } from 'node:fs'
import { AnchorStore } from './anchors.ts'
import { createApi } from './http.ts'
import { HttpKube } from './kube.ts'
import { SandboxManager } from './manager.ts'
import { privateKeyFrom } from '../shared/token.ts'

function number(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} doit être un nombre : ${raw}`)
  return value
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} est requis`)
  return value
}

const anchors = new AnchorStore(process.env.ANCHOR_DIR ?? '/data/anchors')
const manager = new SandboxManager({
  kube: new HttpKube({
    apiBase: process.env.KUBE_API ?? 'https://kubernetes.default.svc',
    namespace: required('SANDBOX_NAMESPACE'),
    tokenFile: process.env.KUBE_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
  }),
  anchors,
  signingKey: privateKeyFrom(readFileSync(required('SIGNING_KEY_FILE'), 'utf8')),
  defaults: {
    leaseSeconds: number('LEASE_SECONDS', 600),
    idleSeconds: number('IDLE_SECONDS', 3600),
    turnCapSeconds: number('TURN_CAP_SECONDS', 3600),
  },
  renewSeconds: number('RENEW_SECONDS', 60),
  maxActive: number('MAX_ACTIVE', 4),
  startupTimeoutSeconds: number('STARTUP_TIMEOUT_SECONDS', 300),
  stopTurnWaitMs: number('STOP_TURN_WAIT_MS', 20_000),
  bridgePort: number('BRIDGE_PORT', 8080),
})

await manager.start()
const server = createApi({ manager, anchors, lab: process.env.LAB === 'true' })
server.listen(number('PORT', 8080), () => console.log(`- back-end prêt sur :${String(number('PORT', 8080))}`))

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void manager.stop().finally(() => {
      server.close()
      process.exit(0)
    })
  })
}
