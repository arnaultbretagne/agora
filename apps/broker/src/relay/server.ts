// The CONNECT relay (ADR 0009; S7 Step 5). Confined transport only: it never terminates provider
// TLS, never reads tunneled bytes, never authorizes on its own — packages/policy's reachability
// projection of the FRESH effective set is the one decision made per CONNECT, before any upstream
// socket opens. The authenticated hop to OneCLI's gateway happens here (HTTP Basic, the private-
// store bearer as password — field-findings §3.2); the Pod never sees that credential.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect as connectTcp, type Socket } from 'node:net'
import type { OneCliClient } from '../onecli/client.js'
import type { PrivateStore } from '../private-store.js'
import { decideConnect } from './decision.js'
import { resolveIdentity } from './identity.js'
import type { K8sPodLookup } from './k8s-pod-lookup.js'
import { TunnelRegistry } from './tunnels.js'
import type { EffectiveCredentialForReachability, EgressHostCatalogue } from '@agora/policy'

export interface RelayOptions {
  readonly podLookup: K8sPodLookup
  readonly client: OneCliClient
  readonly privateStore: PrivateStore
  readonly egressHosts: EgressHostCatalogue
  readonly tunnels: TunnelRegistry
  readonly gatewayHost: string
  readonly gatewayPort: number
  /** The Agent already bound to this incarnation (Step 2/6) — the relay never creates one. */
  readonly boundAgentFor: (incarnation: string) => Promise<string | undefined>
  readonly onDenied?: (reason: string, targetHostPort: string) => void
}

export function createRelay(options: RelayOptions): Server {
  const server = createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('this endpoint only accepts CONNECT')
  })
  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    void handleConnect(options, req, clientSocket, head)
  })
  return server
}

async function handleConnect(options: RelayOptions, req: IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
  const targetHostPort = req.url ?? ''
  const targetHost = targetHostPort.split(':')[0] ?? ''
  const deny = (status: number, reason: string): void => {
    options.onDenied?.(reason, targetHostPort)
    clientSocket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`)
    clientSocket.destroy()
  }

  const sourceIp = clientSocket.remoteAddress
  const identity = sourceIp !== undefined ? await resolveIdentity(options.podLookup, sourceIp) : undefined
  const agentId = identity !== undefined ? await options.boundAgentFor(identity.incarnation) : undefined
  const effective = agentId !== undefined ? await safeEffectiveCredentials(options.client, agentId) : undefined
  const bearerAvailable = identity !== undefined && options.privateStore.get(identity.incarnation) !== undefined

  const decision = decideConnect({ identity, agentId, effective, bearerAvailable, targetHost, egressHosts: options.egressHosts })
  if (!decision.allow) return deny(decision.reason === 'unresolved_identity' ? 407 : 403, decision.reason)

  const bearer = options.privateStore.get(identity!.incarnation)!
  const upstream = connectTcp(options.gatewayPort, options.gatewayHost)
  upstream.on('error', () => deny(502, 'gateway_unreachable'))
  upstream.once('connect', () => {
    const auth = Buffer.from(`x:${bearer}`).toString('base64')
    upstream.write(`CONNECT ${targetHostPort} HTTP/1.1\r\nHost: ${targetHostPort}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`)
  })
  upstream.once('data', (chunk: Buffer) => {
    if (!chunk.toString('utf8').startsWith('HTTP/1.1 200')) {
      clientSocket.destroy()
      upstream.destroy()
      return
    }
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    options.tunnels.register(identity!.incarnation, clientSocket)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  clientSocket.on('error', () => upstream.destroy())
  clientSocket.on('close', () => upstream.destroy())
}

async function safeEffectiveCredentials(client: OneCliClient, agentId: string): Promise<readonly EffectiveCredentialForReachability[] | undefined> {
  try {
    const credentials = await client.getEffectiveCredentials(agentId)
    return [...credentials.secrets, ...credentials.connections]
  } catch {
    return undefined // a failed read produces no set (002) — decideConnect treats this as host_not_reachable, never as unrestricted.
  }
}
