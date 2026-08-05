import { createHash } from 'node:crypto'
import { FAKE_AGENT_DEFINITION } from '@agora/agent-registry'
import { createPool, requireDatabaseUrl } from '@agora/store-pg'
import { BridgeCredentialIssuer } from './bridge-credentials.js'
import { createHttpBrokerActivationClient } from './broker-activation-client.js'
import { K8sClient } from './k8s-client.js'
import type { RelayBundle } from './relay-bundle.js'
import { CustodyStreamIssuer } from './restore-credentials.js'
import { createServer } from './server.js'

// P09/P10 add real Claude/Codex `AgentRuntimeDefinition`s here; P04's non-goal is explicit
// ("No real Claude/Codex integration") so only the fake Agent is wired for now.
const DEFINITIONS = [FAKE_AGENT_DEFINITION]

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const namespace = requireEnv('AGORA_NAMESPACE')
const controllerRevision = requireEnv('CONTROLLER_REVISION')
const port = Number(process.env.PORT ?? 8443)
const runtimeClassName = process.env.RUNTIME_CLASS_NAME
const runAsUser = process.env.RUN_AS_USER ? Number(process.env.RUN_AS_USER) : undefined
const imagePullSecretName = process.env.IMAGE_PULL_SECRET_NAME
const registryRevision = createHash('sha256').update(JSON.stringify(DEFINITIONS)).digest('hex').slice(0, 16)
// `agora_custody_runtime`-role connection (contracts/database/002-access.sql) — deliberately a
// SEPARATE credential from any product/control-plane database user (docs/specs/07 "Access control").
const custodyPool = createPool(requireDatabaseUrl({ DATABASE_URL: process.env.CUSTODY_DATABASE_URL }))
const custodyControllerBaseUrl = requireEnv('CUSTODY_CONTROLLER_BASE_URL')
// P08's own operator-managed values (relay-bundle.ts's own doc comment: "P08 supplies the real
// VALUES ... through the identical RelayBundle shape"), never Session-specific, never secret.
const relayBundle: RelayBundle = {
  relayEndpoint: requireEnv('AGORA_BROKER_RELAY_ENDPOINT'),
  oneCliCaPem: requireEnv('AGORA_ONECLI_CA_PEM'),
  authStubs: JSON.parse(process.env.AGORA_ONECLI_AUTH_STUBS_JSON ?? '{}') as Record<string, string>,
}
const brokerActivationClient = createHttpBrokerActivationClient(requireEnv('BROKER_CONTROL_BASE_URL'))

const server = createServer({
  k8s: new K8sClient({ namespace }),
  definitions: DEFINITIONS,
  registryRevision,
  bridgeIssuer: new BridgeCredentialIssuer(),
  controllerRevision,
  custodyPool,
  restoreIssuer: new CustodyStreamIssuer(),
  custodyControllerBaseUrl,
  relayBundle,
  brokerActivationClient,
  ...(runAsUser !== undefined ? { runAsUser } : {}),
  ...(runtimeClassName ? { runtimeClassName } : {}),
  ...(imagePullSecretName ? { imagePullSecretName } : {}),
})

server.listen(port, () => {
  process.stdout.write(`session-runtime-controller listening on :${port} (namespace=${namespace})\n`)
})
