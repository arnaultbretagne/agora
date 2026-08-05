import { createHash } from 'node:crypto'
import { FAKE_AGENT_DEFINITION } from '@agora/agent-registry'
import { createPool, requireDatabaseUrl } from '@agora/store-pg'
import { requireEncryptionKey } from './crypto.js'
import { createOnecliSdkAdapter } from './onecli-real.js'
import { createAccessRelay } from './relay.js'
import { createBrokerServer } from './server.js'

// P09/P10 add real Claude/Codex `AgentRuntimeDefinition`s (and their entries in
// route-policy.ts's PINNED_AGENT_ROUTE_SETS) — this plan's non-goal is explicit ("No ACP
// adapter/custody implementation; P09/P10 validate those on this fixed path").
const DEFINITIONS = [FAKE_AGENT_DEFINITION]

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const controlPort = Number(process.env.PORT ?? 8443)
const relayPort = Number(process.env.RELAY_PORT ?? 8444)
const registryRevision = createHash('sha256').update(JSON.stringify(DEFINITIONS)).digest('hex').slice(0, 16)

const pool = createPool(requireDatabaseUrl())
const encryptionKey = requireEncryptionKey()
const onecli = createOnecliSdkAdapter({
  apiKey: requireEnv('ONECLI_API_KEY'),
  ...(process.env.ONECLI_URL ? { url: process.env.ONECLI_URL } : {}),
  ...(process.env.ONECLI_GATEWAY_URL ? { gatewayUrl: process.env.ONECLI_GATEWAY_URL } : {}),
  ...(process.env.ONECLI_PROJECT_ID ? { projectId: process.env.ONECLI_PROJECT_ID } : {}),
})
// The SAME operator-pinned values the Session Runtime controller mounts into every Pod
// (relay-bundle.ts) — the Broker's own job is only to verify OneCLI has not drifted from them.
const expectedRuntimeBundle = {
  caCertificate: requireEnv('AGORA_ONECLI_CA_PEM'),
  credentialStubs: JSON.parse(process.env.AGORA_ONECLI_CREDENTIAL_STUBS_JSON ?? '[]') as { containerPath: string; content: string }[],
}

const controlServer = createBrokerServer({ pool, definitions: DEFINITIONS, registryRevision, onecli, encryptionKey, expectedRuntimeBundle })
controlServer.listen(controlPort, () => {
  process.stdout.write(`broker control API listening on :${controlPort}\n`)
})

const relayServer = createAccessRelay({ pool, encryptionKey })
relayServer.listen(relayPort, () => {
  process.stdout.write(`broker access relay listening on :${relayPort}\n`)
})
