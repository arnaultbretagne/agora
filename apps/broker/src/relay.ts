import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type pg from 'pg'
import { getActivationByWorkloadIdentity } from './activations-repository.js'
import { recordAudit } from './audit.js'
import { getGrant } from './grants-repository.js'
import { readUpstreamAuthority } from './onecli-agents-repository.js'

/**
 * docs/specs/10 "access relay": workload-authenticated, opaque CONNECT tunnel to OneCLI's own
 * gateway. Never terminates provider TLS, never reads a tunneled byte, never injects a
 * credential into the Agent Pod — the upstream `aoc_…` bearer is read from Broker-private
 * encrypted state and attached ONLY to this relay's OWN authenticated hop to OneCLI, never
 * returned to the caller.
 *
 * The connecting workload's identity used to be an `X-Workload-Identity` header, trusted on the
 * assumption a real deployment's service mesh sidecar (mTLS/SPIFFE) would inject it after
 * authenticating the Pod, unforgeable by the Pod itself. Found live, P11: this cluster has no such
 * mesh — nothing ever set that header, so every real CONNECT failed closed
 * (`407 missing_workload_identity`), surfaced by the real `claude` CLI's own proxy library as a
 * misleadingly generic `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` (the CA/TLS chain to the gateway
 * was always correct — verified directly). `resolveWorkloadIdentity` replaces the header: it
 * derives identity from the connection's own real source IP (`k8s-pod-lookup.ts`'s real
 * implementation — genuinely unforgeable by the Pod within this cluster's CNI, matching the "trust
 * the transport" convention already used throughout this codebase), never a client-supplied claim.
 * This relay's OWN job stays the binding check — does the resolved identity match what the
 * Controller bound at activation — not re-implementing identity verification itself.
 *
 * CONNECT's target is host:port only — no path, no query string ever reaches this process or its
 * audit log (ONECLI-SPIKE.md "Gateway stdout leaks query-string secrets" is structurally
 * impossible to reproduce here: this relay never sees a query string to begin with).
 */
export interface RelayDeps {
  readonly pool: pg.Pool
  readonly encryptionKey: Buffer
  readonly dialGateway?: (gatewayUrl: string) => Socket
  /** The connecting Session Runtime Pod's own real source IP -> its `serviceAccountName`, or `undefined` if unresolvable. Real implementation: `k8s-pod-lookup.ts`. */
  readonly resolveWorkloadIdentity: (sourceIp: string) => Promise<string | undefined>
}

function defaultDialGateway(gatewayUrl: string): Socket {
  const url = new URL(gatewayUrl)
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  return url.protocol === 'https:' ? tlsConnect({ host: url.hostname, port }) : netConnect(port, url.hostname)
}

/** Node reports an IPv4 connection over a dual-stack socket as `::ffff:x.x.x.x` — strip the prefix so it matches the plain IPv4 `status.podIP` the Kubernetes API reports. */
function normalizeSourceIp(remoteAddress: string | undefined): string | undefined {
  if (!remoteAddress) return undefined
  return remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress
}

export function createAccessRelay(deps: RelayDeps): Server {
  const server = createServer((_req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain' }).end('this endpoint only accepts CONNECT')
  })
  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    clientSocket.on('error', () => {})
    handleConnect(deps, req, clientSocket, head).catch(() => {
      clientSocket.destroy()
    })
  })
  return server
}

async function deny(deps: RelayDeps, clientSocket: Socket, status: number, code: string, sessionId?: string): Promise<void> {
  const client = await deps.pool.connect()
  try {
    await recordAudit(client, {
      id: randomUUID(),
      actorKind: 'system',
      actorId: 'access-relay',
      sessionId: sessionId ?? null,
      actionClass: 'relay.connect',
      decision: 'denied',
      policyVersion: null,
      detail: { code },
      createdAt: new Date(),
    })
  } finally {
    client.release()
  }
  clientSocket.end(`HTTP/1.1 ${status} Denied\r\n\r\n`)
}

async function handleConnect(deps: RelayDeps, req: IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
  const target = req.url ?? ''
  const separatorIndex = target.lastIndexOf(':')
  const host = separatorIndex > 0 ? target.slice(0, separatorIndex) : ''
  const port = separatorIndex > 0 ? Number(target.slice(separatorIndex + 1)) : NaN

  if (!host || !Number.isInteger(port)) return deny(deps, clientSocket, 400, 'invalid_target')

  const sourceIp = normalizeSourceIp(clientSocket.remoteAddress)
  const workloadIdentity = sourceIp ? await deps.resolveWorkloadIdentity(sourceIp) : undefined
  if (!workloadIdentity) return deny(deps, clientSocket, 403, 'unresolvable_workload_identity')

  const client = await deps.pool.connect()
  let sessionId: string | undefined
  try {
    const activation = await getActivationByWorkloadIdentity(client, workloadIdentity)
    if (!activation) return deny(deps, clientSocket, 403, 'unknown_workload_identity')
    sessionId = activation.sessionId
    if (activation.expiresAt <= new Date()) return deny(deps, clientSocket, 403, 'activation_expired', sessionId)

    const grant = await getGrant(client, activation.grantId)
    if (!grant || grant.sessionId !== activation.sessionId) return deny(deps, clientSocket, 403, 'grant_missing', sessionId)
    // Revocation check: required test "Revocation immediately blocks the relay" — this is the ONE
    // place that enforcement happens, evaluated fresh on every CONNECT, never cached.
    if (grant.state !== 'issued' || grant.expiresAt <= new Date()) return deny(deps, clientSocket, 403, 'grant_not_active', sessionId)

    const authority = await readUpstreamAuthority(client, deps.encryptionKey, activation.sessionId)
    if (!authority) return deny(deps, clientSocket, 502, 'upstream_authority_unavailable', sessionId)

    const dial = deps.dialGateway ?? defaultDialGateway
    const upstream = dial(authority.gatewayUrl)
    upstream.on('error', () => {
      clientSocket.destroy()
    })
    upstream.once('connect', () => {
      void bridgeThroughGateway(upstream, clientSocket, head, `${host}:${port}`, authority.proxyCredential)
        .then(() =>
          recordApprovedConnect(deps, activation.sessionId, activation.agentId, grant.policyVersion, host).catch(() => {
            /* audit failure must not tear down an already-bridged tunnel */
          }),
        )
        .catch((error) => {
          upstream.destroy()
          // The gateway itself rejected the CONNECT (e.g. route not allow-listed) — this is a clean
          // denial, not a transport failure, so the caller gets a real status line, not ECONNRESET.
          if (error instanceof GatewayRejectedError) {
            void deny(deps, clientSocket, error.status, 'gateway_rejected', activation.sessionId)
          } else {
            clientSocket.destroy()
          }
        })
    })
  } finally {
    client.release()
  }
}

async function recordApprovedConnect(deps: RelayDeps, sessionId: string, agentId: string, policyVersion: string, host: string): Promise<void> {
  const client = await deps.pool.connect()
  try {
    await recordAudit(client, {
      id: randomUUID(),
      actorKind: 'system',
      actorId: 'access-relay',
      sessionId,
      actionClass: 'relay.connect',
      decision: 'approved',
      policyVersion,
      detail: { agentId, host },
      createdAt: new Date(),
    })
  } finally {
    client.release()
  }
}

/** A clean denial from OneCLI's own gateway (e.g. the target host is not route-allow-listed) — as
 * opposed to a transport-level failure, this carries a real status the caller should see. */
class GatewayRejectedError extends Error {
  constructor(readonly status: number) {
    super(`onecli gateway CONNECT rejected: HTTP ${status}`)
    this.name = 'GatewayRejectedError'
  }
}

/** Speaks the CONNECT handshake to OneCLI's gateway, then pipes raw bytes both ways with zero inspection. */
function bridgeThroughGateway(upstream: Socket, clientSocket: Socket, head: Buffer, target: string, upstreamProxyCredential: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const terminator = buffered.indexOf('\r\n\r\n')
      if (terminator === -1) return
      upstream.removeListener('data', onData)
      const statusLine = buffered.subarray(0, terminator).toString('utf8').split('\r\n')[0] ?? ''
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
      const status = match ? Number(match[1]) : 0
      const remainder = buffered.subarray(terminator + 4)
      if (status !== 200) {
        reject(new GatewayRejectedError(status))
        return
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (remainder.length) clientSocket.write(remainder)
      if (head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
      resolve()
    }
    upstream.on('data', onData)
    upstream.once('error', reject)
    // Basic, not Bearer (found live, P11): OneCLI's gateway speaks HTTP Basic proxy auth. Sent as
    // `Bearer`, the gateway does not recognize the credential, silently falls back to
    // unauthenticated passthrough — no TLS interception, no provider-credential injection — and
    // the Agent receives a bare 401 from the provider. Proven live against the real gateway by
    // comparing the peer certificate: `Bearer` -> the provider's own public cert (passthrough);
    // `Basic` -> a cert issued by "OneCLI Local Gateway CA" (intercepting, injecting).
    const basic = Buffer.from(upstreamProxyCredential).toString('base64')
    upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`)
  })
}
