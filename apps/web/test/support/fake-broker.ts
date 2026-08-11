import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'

/**
 * Stands in for the real Broker (apps/broker) purely over HTTP — apps/web (a deployable) must
 * never import that Broker's source directly (scripts/check-architecture.mjs: "no deployable
 * imports another deployable"), so this test harness re-implements just enough of
 * `POST /v1/execution-grants`'s wire contract (one idempotent ensure) to
 * exercise apps/web's own real broker-grant-client.ts against a REAL server, matching
 * fake-controller.ts's own convention for the Session Runtime controller.
 *
 * Idempotent by sessionId (loosely — enough for these tests, not a full re-implementation of the
 * real Broker's (sessionId, requestId) idempotency): a second issue for the same sessionId
 * returns the SAME grant, matching `broker.execution_grants.session_id` being UNIQUE.
 */
export interface FakeBrokerHandle {
  readonly baseUrl: string
  /** Every ensure — a first start and a resume make the same call, so both land here. */
  readonly ensureCalls: readonly { readonly sessionId: string; readonly agentId: string }[]
  /** grantIds this fake was asked to revoke — the real Broker deletes the Session's OneCLI Agent here. */
  readonly revokeCalls: readonly string[]
  /** grantIds whose Agent this fake was asked to decommission — a suspend does that without ending the grant. */
  readonly decommissionCalls: readonly string[]
  close(): Promise<void>
}

interface FakeGrant {
  readonly grantId: string
  readonly sessionId: string
  readonly agentId: string
  readonly policyVersion: string
  readonly capabilityDigest: string
  expiresAt: string
}

function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function wireGrant(grant: FakeGrant) {
  return {
    grantId: grant.grantId,
    grantRef: grant.grantId,
    sessionId: grant.sessionId,
    agentId: grant.agentId,
    policyVersion: grant.policyVersion,
    capabilityDigest: grant.capabilityDigest,
    capabilities: [],
    mcpServers: [],
    expiresAt: grant.expiresAt,
  }
}

export async function startFakeBroker(): Promise<FakeBrokerHandle> {
  const grantsBySession = new Map<string, FakeGrant>()
  const grantsById = new Map<string, FakeGrant>()
  const ensureCalls: { readonly sessionId: string; readonly agentId: string }[] = []
  const revokeCalls: string[] = []
  const decommissionCalls: string[] = []

  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://internal')

      if (req.method === 'POST' && url.pathname === '/v1/execution-grants') {
        const body = await readJson(req)
        const sessionId = String(body['sessionId'] ?? '')
        const agentId = String(body['agentId'] ?? '')
        ensureCalls.push({ sessionId, agentId })
        let grant = grantsBySession.get(sessionId)
        if (!grant) {
          grant = {
            grantId: randomUUID(),
            sessionId,
            agentId,
            policyVersion: 'fake-test-policy-v1',
            capabilityDigest: createHash('sha256').update(sessionId).digest('hex'),
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          }
          grantsBySession.set(sessionId, grant)
          grantsById.set(grant.grantId, grant)
        }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify(wireGrant(grant)))
        return
      }

      const agentMatch = /^\/v1\/execution-grants\/([^/]+)\/agent$/.exec(url.pathname)
      if (req.method === 'DELETE' && agentMatch?.[1]) {
        // The real Broker deletes the OneCLI Agent and its mapping row, but leaves the grant
        // `issued` so a later renew provisions one again — so this fake keeps the grant, unlike
        // its revoke branch. Idempotent 204 either way.
        decommissionCalls.push(agentMatch[1])
        res.writeHead(204).end()
        return
      }
      const revokeMatch = /^\/v1\/execution-grants\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'DELETE' && revokeMatch?.[1]) {
        // Idempotent like the real Broker: revoking an absent/already-revoked grant is a no-op 204.
        revokeCalls.push(revokeMatch[1])
        const grant = grantsById.get(revokeMatch[1])
        if (grant) {
          grantsById.delete(revokeMatch[1])
          grantsBySession.delete(grant.sessionId)
        }
        res.writeHead(204)
        res.end()
        return
      }

      res.writeHead(404)
      res.end()
    })()
  })
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  const port = (httpServer.address() as { port: number }).port

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    ensureCalls,
    revokeCalls,
    decommissionCalls,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}
