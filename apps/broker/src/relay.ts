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
 * `X-Workload-Identity` is trusted the same way `apps/session-runtime-controller/src/server.ts`
 * trusts its own transport ("this listener itself speaks plain HTTP... deployment-level policy
 * (cluster mesh/NetworkPolicy) terminates and enforces it"): a real deployment's mesh sidecar
 * authenticates the connecting Session Runtime Pod via mTLS/SPIFFE and injects this header only
 * after that succeeds, unforgeable by the Pod itself. This relay's OWN job is the binding check —
 * does the identity presented match what the Controller bound at activation — not re-implementing
 * mTLS validation, matching the one transport-trust convention already established in this
 * codebase.
 *
 * CONNECT's target is host:port only — no path, no query string ever reaches this process or its
 * audit log (ONECLI-SPIKE.md "Gateway stdout leaks query-string secrets" is structurally
 * impossible to reproduce here: this relay never sees a query string to begin with).
 */
export interface RelayDeps {
  readonly pool: pg.Pool
  readonly encryptionKey: Buffer
  readonly dialGateway?: (gatewayUrl: string) => Socket
}

function defaultDialGateway(gatewayUrl: string): Socket {
  const url = new URL(gatewayUrl)
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  return url.protocol === 'https:' ? tlsConnect({ host: url.hostname, port }) : netConnect(port, url.hostname)
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
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
  const workloadIdentity = headerValue(req, 'x-workload-identity')
  const target = req.url ?? ''
  const separatorIndex = target.lastIndexOf(':')
  const host = separatorIndex > 0 ? target.slice(0, separatorIndex) : ''
  const port = separatorIndex > 0 ? Number(target.slice(separatorIndex + 1)) : NaN

  if (!workloadIdentity) return deny(deps, clientSocket, 407, 'missing_workload_identity')
  if (!host || !Number.isInteger(port)) return deny(deps, clientSocket, 400, 'invalid_target')

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
      void bridgeThroughGateway(upstream, clientSocket, head, `${host}:${port}`, authority.bearer)
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
function bridgeThroughGateway(upstream: Socket, clientSocket: Socket, head: Buffer, target: string, upstreamBearer: string): Promise<void> {
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
    upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Bearer ${upstreamBearer}\r\n\r\n`)
  })
}
