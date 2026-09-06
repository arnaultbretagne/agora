// Broker entrypoint (S7): owner API (control: attach_grant/detach_grant/cleanup_agent) and the
// CONNECT relay, one deployable (ADR 0001) whose only Kubernetes authority is read-only Pods (P10
// identity resolution) — it never creates or deletes a workload, unlike runtime-control.
import pg from 'pg'
import { PgOwnerGate } from '@agora/owner-requests'
import { loadEgressHostCatalogue, selectRevision } from '@agora/policy'
import { HttpOneCliClient, type OneCliClient } from './onecli/client.js'
import { OneCliCredentialResolver } from './onecli/resolver.js'
import { createBrokerApi } from './owner-api.js'
import { createRelay } from './relay/server.js'
import { HttpK8sPodLookup } from './relay/k8s-pod-lookup.js'
import { TunnelRegistry } from './relay/tunnels.js'
import { EncryptedPrivateStore } from './private-store.js'
import { agentIdentifierFor } from './agents.js'

export interface MainOptions {
  readonly env?: NodeJS.ProcessEnv
}

export function main(options: MainOptions = {}): { readonly stop: () => void } {
  const env = options.env ?? process.env
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const onecliUrl = env.ONECLI_URL
  if (!onecliUrl) throw new Error('ONECLI_URL is required')
  const onecliApiKey = env.ONECLI_API_KEY
  if (!onecliApiKey) throw new Error('ONECLI_API_KEY is required')
  const encryptionKey = env.BROKER_ENCRYPTION_KEY
  if (!encryptionKey) throw new Error('BROKER_ENCRYPTION_KEY is required')
  const gatewayUrl = new URL(env.ONECLI_GATEWAY_URL ?? 'http://onecli.agora-onecli.svc.cluster.local:10255')

  const pool = new pg.Pool({ connectionString: databaseUrl })
  const client = new HttpOneCliClient({ baseUrl: onecliUrl, apiKey: onecliApiKey })
  const gate = new PgOwnerGate(pool, 'broker')
  const tunnels = new TunnelRegistry()
  const privateStore = new EncryptedPrivateStore(encryptionKey)
  const egressHosts = loadEgressHostCatalogue(env.POLICY_EGRESS_HOSTS_PATH ?? '/etc/agora/egress-hosts.json')
  const podLookup = new HttpK8sPodLookup({ namespace: env.AGORA_NAMESPACE ?? 'agora-runs' })
  const catalogue = selectRevision(env)
  const resolver = new OneCliCredentialResolver(client)

  const controlServer = createBrokerApi({ client, gate, tunnels, privateStore, catalogue, resolver })
  controlServer.listen(Number(env.PORT ?? 8443), '0.0.0.0', () => {
    console.log(`broker control API on :${env.PORT ?? 8443}`)
  })

  const relayServer = createRelay({
    podLookup,
    client,
    privateStore,
    egressHosts,
    tunnels,
    gatewayHost: gatewayUrl.hostname,
    gatewayPort: Number(gatewayUrl.port),
    // The relay never creates an Agent — BUILD's Broker part (attach_grant) already does. A Pod
    // whose Agent doesn't exist yet gets no tunnel, not a freshly-created ungranted one.
    boundAgentFor: (incarnation) => findExistingAgentId(client, incarnation),
    onDenied: (reason, target) => console.warn(`relay denied ${target}: ${reason}`),
  })
  relayServer.listen(Number(env.RELAY_PORT ?? 8444), '0.0.0.0', () => {
    console.log(`broker relay on :${env.RELAY_PORT ?? 8444}`)
  })

  return {
    stop: () => {
      controlServer.close()
      relayServer.close()
      void pool.end()
    },
  }
}

async function findExistingAgentId(client: OneCliClient, incarnation: string): Promise<string | undefined> {
  const identifier = agentIdentifierFor(incarnation)
  const agents = await client.listAgents()
  return agents.find((a) => a.identifier === identifier)?.id
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  main()
}
