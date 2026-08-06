import { createHash } from 'node:crypto'
import { CLAUDE_CODE_DEFINITION, CODEX_DEFINITION, FAKE_AGENT_DEFINITION } from '@agora/agent-registry'
import { createPool, requireDatabaseUrl } from '@agora/store-pg'
import { requireEncryptionKey } from './crypto.js'
import { createK8sWorkloadIdentityResolver } from './k8s-pod-lookup.js'
import { createOnecliSdkAdapter } from './onecli-real.js'
import { createAccessRelay } from './relay.js'
import { createBrokerServer } from './server.js'

// P09/P10 shipped real Claude/Codex `AgentRuntimeDefinition`s — found live, P11, wiring the real
// deployment: this list was never updated to include them (only
// apps/session-runtime-controller/src/main.ts's own DEFINITIONS array was), so a real broker
// deployed as-is would reject every real Claude/Codex launch request as unlaunchable. Both are
// `rollout: 'internal'`, which `selectLaunchableAgents` already treats as launchable (staff/
// testing), matching the controller's own DEFINITIONS list exactly.
const DEFINITIONS = [FAKE_AGENT_DEFINITION, CLAUDE_CODE_DEFINITION, CODEX_DEFINITION]

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

// Found live, P11: relay.ts's real workload-identity source — see k8s-pod-lookup.ts's own doc.
// `agora.dev/app=session-runtime` matches apps/session-runtime-controller/src/labels.ts's own
// constants exactly (deployables never import each other, so this is a narrow, literal copy).
const resolveWorkloadIdentity = createK8sWorkloadIdentityResolver({
  namespace: requireEnv('AGORA_NAMESPACE'), // matches apps/session-runtime-controller's own AGORA_NAMESPACE naming (agora-runs)
  labelSelector: 'agora.dev/app=session-runtime',
})
const relayServer = createAccessRelay({ pool, encryptionKey, resolveWorkloadIdentity })
relayServer.listen(relayPort, () => {
  process.stdout.write(`broker access relay listening on :${relayPort}\n`)
})
