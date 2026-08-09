import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { test } from 'node:test'
import { FAKE_AGENT_DEFINITION } from '@agora/agent-registry'
import { EQUIPMENT_CATALOGUE_VERSION } from '@agora/equipment-policy'
import type pg from 'pg'
import { createBrokerServer, type BrokerServerDeps } from '../src/server.js'
import { FakeOneCliControlAdapter } from '../src/onecli-fake.js'
import { randomId, testEncryptionKey, testExpectedRuntimeBundle, withTestDatabase } from './support.js'

interface Response {
  readonly status: number
  readonly body: unknown
}

function startServer(pool: pg.Pool): Promise<{ server: Server; port: number; deps: BrokerServerDeps }> {
  const deps: BrokerServerDeps = {
    pool,
    definitions: [FAKE_AGENT_DEFINITION],
    registryRevision: 'test-revision',
    onecli: new FakeOneCliControlAdapter(),
    encryptionKey: testEncryptionKey(),
    expectedRuntimeBundle: testExpectedRuntimeBundle(),
  }
  const server = createBrokerServer(deps)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, deps }))
  })
}

function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

const VAULT_READ = { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'vault', access: 'read' }] }

function issueBody(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: randomId(),
    agentId: 'fake-agent',
    principalId: 'alice',
    workstreamCategory: 'discussion',
    equipment: VAULT_READ,
    ...overrides,
  }
}

test('GET /v1/equipment-catalogue returns the broker-authoritative catalogue', async () => {
  await withTestDatabase(async (pool) => {
    const { server, port } = await startServer(pool)
    try {
      const result = await call(port, 'GET', '/v1/equipment-catalogue')
      assert.equal(result.status, 200)
      assert.ok(result.body && typeof result.body === 'object')
    } finally {
      server.close()
    }
  })
})

test('POST /v1/execution-grants without X-Request-Id is rejected', async () => {
  await withTestDatabase(async (pool) => {
    const { server, port } = await startServer(pool)
    try {
      const result = await call(port, 'POST', '/v1/execution-grants', issueBody())
      assert.equal(result.status, 400)
      assert.equal((result.body as { code: string }).code, 'missing_request_id')
    } finally {
      server.close()
    }
  })
})

test('POST /v1/execution-grants with a schema-invalid body (unknown extra field) is rejected before any mutation', async () => {
  await withTestDatabase(async (pool) => {
    const { server, port } = await startServer(pool)
    try {
      const result = await call(port, 'POST', '/v1/execution-grants', issueBody({ notARealField: true }), { 'x-request-id': randomUUID() })
      assert.equal(result.status, 400)
      assert.equal((result.body as { code: string }).code, 'invalid_request')
    } finally {
      server.close()
    }
  })
})

test('POST /v1/execution-grants for a non-launchable agentId is denied', async () => {
  await withTestDatabase(async (pool) => {
    const { server, port } = await startServer(pool)
    try {
      const result = await call(port, 'POST', '/v1/execution-grants', issueBody({ agentId: 'no-such-agent' }), { 'x-request-id': randomUUID() })
      assert.equal(result.status, 403)
      assert.equal((result.body as { code: string }).code, 'agent_not_launchable')
    } finally {
      server.close()
    }
  })
})

test('POST /v1/execution-grants for an unresolvable equipment intent is denied with the PolicyDenialError code', async () => {
  await withTestDatabase(async (pool) => {
    const { server, port } = await startServer(pool)
    try {
      const badEquipment = { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'nonexistent', access: 'read' }] }
      const result = await call(port, 'POST', '/v1/execution-grants', issueBody({ equipment: badEquipment }), { 'x-request-id': randomUUID() })
      assert.equal(result.status, 403)
      assert.equal((result.body as { code: string }).code, 'unknown_resource_or_access')
    } finally {
      server.close()
    }
  })
})

test('required: full issue -> activate -> renew -> revoke lifecycle over real HTTP', async () => {
  await withTestDatabase(async (pool) => {
    const { server, port } = await startServer(pool)
    try {
      const issued = await call(port, 'POST', '/v1/execution-grants', issueBody(), { 'x-request-id': randomUUID() })
      assert.equal(issued.status, 201)
      const grant = issued.body as { grantId: string; grantRef: string; sessionId: string; agentId: string; capabilityDigest: string; expiresAt: string }
      assert.ok(grant.grantId)
      assert.equal(grant.grantRef, grant.grantId)
      assert.match(grant.capabilityDigest, /^[a-f0-9]{64}$/)

      const activated = await call(
        port,
        'POST',
        '/v1/execution-grant-activations',
        { grantRef: grant.grantId, sessionId: grant.sessionId, agentId: grant.agentId, workloadIdentity: 'workload-http-1' },
        { 'x-request-id': randomUUID() },
      )
      assert.equal(activated.status, 201)
      assert.equal((activated.body as { workloadIdentity: string }).workloadIdentity, 'workload-http-1')

      const renewed = await call(port, 'POST', `/v1/execution-grants/${grant.grantId}/renew`, undefined, { 'x-request-id': randomUUID() })
      assert.equal(renewed.status, 200)
      const renewedGrant = renewed.body as { capabilityDigest: string; expiresAt: string }
      assert.equal(renewedGrant.capabilityDigest, grant.capabilityDigest)
      assert.ok(new Date(renewedGrant.expiresAt).getTime() >= new Date(grant.expiresAt).getTime())

      const revoked = await call(port, 'DELETE', `/v1/execution-grants/${grant.grantId}`, undefined, { 'x-request-id': randomUUID() })
      assert.equal(revoked.status, 204)

      // Idempotent: revoking again (or an unknown grant) is still a clean 204, not an error.
      const revokedAgain = await call(port, 'DELETE', `/v1/execution-grants/${grant.grantId}`, undefined, { 'x-request-id': randomUUID() })
      assert.equal(revokedAgain.status, 204)
    } finally {
      server.close()
    }
  })
})

test('POST /v1/execution-grant-activations with a schema-invalid body (missing workloadIdentity) is rejected', async () => {
  await withTestDatabase(async (pool) => {
    const { server, port } = await startServer(pool)
    try {
      const issued = await call(port, 'POST', '/v1/execution-grants', issueBody(), { 'x-request-id': randomUUID() })
      const grant = issued.body as { grantId: string; sessionId: string; agentId: string }
      const result = await call(
        port,
        'POST',
        '/v1/execution-grant-activations',
        { grantRef: grant.grantId, sessionId: grant.sessionId, agentId: grant.agentId },
        { 'x-request-id': randomUUID() },
      )
      assert.equal(result.status, 400)
      assert.equal((result.body as { code: string }).code, 'invalid_request')
    } finally {
      server.close()
    }
  })
})

test('a second issue with a distinct requestId for a session that already holds a grant is a conflict', async () => {
  await withTestDatabase(async (pool) => {
    const { server, port } = await startServer(pool)
    try {
      const sessionId = randomId()
      const first = await call(port, 'POST', '/v1/execution-grants', issueBody({ sessionId }), { 'x-request-id': randomUUID() })
      assert.equal(first.status, 201)
      const second = await call(port, 'POST', '/v1/execution-grants', issueBody({ sessionId }), { 'x-request-id': randomUUID() })
      assert.equal(second.status, 409)
      assert.equal((second.body as { code: string }).code, 'grant_conflict')
    } finally {
      server.close()
    }
  })
})

test('renewing an unknown grantId is a clean Problem, not a crash', async () => {
  await withTestDatabase(async (pool) => {
    const { server, port } = await startServer(pool)
    try {
      const result = await call(port, 'POST', `/v1/execution-grants/${randomUUID()}/renew`, undefined, { 'x-request-id': randomUUID() })
      assert.equal(result.status, 409)
    } finally {
      server.close()
    }
  })
})

test('an unrouted method/path returns a 404 Problem', async () => {
  await withTestDatabase(async (pool) => {
    const { server, port } = await startServer(pool)
    try {
      const result = await call(port, 'GET', '/v1/nope')
      assert.equal(result.status, 404)
      assert.equal((result.body as { code: string }).code, 'not_found')
    } finally {
      server.close()
    }
  })
})
