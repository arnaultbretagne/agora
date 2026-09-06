import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import pg from 'pg'
import { PgOwnerGate, payloadDigest, type OwnerRequest } from '@agora/owner-requests'
import { toWireGrantSet, type Authorization } from '@agora/domain'
import { createBrokerApi } from '../src/owner-api.js'
import type { AgentGrantConnection, AgentGrantSecret, AgentGrants, ConnectionGrantInput, ContainerConfig, EffectiveCredentials, OneCliAgent, OneCliClient, OneCliConnection, OneCliSecret } from '../src/onecli/client.js'

// Same trimmed, local bootstrap as packages/owner-requests/test/pg-gate.test.ts — @agora/testkit
// would create a package cycle if pulled in here transitively (see that file's header comment for
// why); broker is a deployable so it CAN depend on testkit without a cycle, but staying consistent
// with the one place this pattern had to be solved keeps both readable the same way.
const SCHEMA_PATH = fileURLToPath(new URL('../../../../contracts/db/schema.sql', import.meta.url))

function maintenanceUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL (or DATABASE_URL) is required')
  return url
}

async function withTestDatabase<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const database = `agora_test_${randomUUID().replaceAll('-', '')}`
  const maintenance = new pg.Pool({ connectionString: maintenanceUrl(), max: 2 })
  try {
    await maintenance.query(`CREATE DATABASE "${database}"`)
  } finally {
    await maintenance.end()
  }
  const testUrl = new URL(maintenanceUrl())
  testUrl.pathname = `/${database}`
  const pool = new pg.Pool({ connectionString: testUrl.toString() })
  try {
    await pool.query(readFileSync(SCHEMA_PATH, 'utf8'))
    return await run(pool)
  } finally {
    await pool.end()
    const cleanup = new pg.Pool({ connectionString: maintenanceUrl(), max: 2 })
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    } finally {
      await cleanup.end()
    }
  }
}

class StatefulOneCliClient implements OneCliClient {
  #agents = new Map<string, OneCliAgent>()
  #nextId = 1
  secrets = new Map<string, AgentGrantSecret>()
  connections = new Map<string, AgentGrantConnection>()

  async listAgents(): Promise<readonly OneCliAgent[]> {
    return [...this.#agents.values()]
  }
  async createAgent(name: string, identifier: string): Promise<{ id: string; name: string; identifier: string; createdAt: string }> {
    if ([...this.#agents.values()].some((a) => a.identifier === identifier)) throw Object.assign(new Error('exists'), { status: 409 })
    const id = `agent-${this.#nextId++}`
    const createdAt = new Date().toISOString()
    this.#agents.set(id, { id, name, identifier, isDefault: false, createdAt })
    return { id, name, identifier, createdAt }
  }
  async deleteAgent(agentId: string): Promise<void> {
    this.#agents.delete(agentId)
  }
  async getAgentGrants(): Promise<AgentGrants> {
    return { agentId: 'a', secrets: [...this.secrets.values()], connections: [...this.connections.values()] }
  }
  async getEffectiveCredentials(): Promise<EffectiveCredentials> {
    return {
      agentId: 'a',
      mode: 'selective',
      secrets: [...this.secrets.values()].map((s) => ({ kind: 'secret' as const, id: s.secretId, status: 'usable' })),
      connections: [...this.connections.values()].map((c) => ({ kind: 'connection' as const, id: c.connectionId, status: 'usable' })),
    }
  }
  async setAgentSecretGrant(_agentId: string, secretId: string): Promise<AgentGrants> {
    this.secrets.set(secretId, { secretId, name: secretId, type: 'anthropic' })
    return this.getAgentGrants()
  }
  async removeAgentSecretGrant(_agentId: string, secretId: string): Promise<void> {
    this.secrets.delete(secretId)
  }
  async setAgentConnectionGrant(_agentId: string, connectionId: string, grant: ConnectionGrantInput): Promise<AgentGrants> {
    this.connections.set(connectionId, grant.access === 'full' ? { connectionId, provider: 'p', access: 'full', allow: [], ask: [] } : { connectionId, provider: 'p', access: 'custom', allow: grant.allow, ask: grant.ask })
    return this.getAgentGrants()
  }
  async removeAgentConnectionGrant(_agentId: string, connectionId: string): Promise<void> {
    this.connections.delete(connectionId)
  }
  async listSecrets(): Promise<readonly OneCliSecret[]> {
    return []
  }
  async listConnections(): Promise<readonly OneCliConnection[]> {
    return []
  }
  async getContainerConfig(): Promise<ContainerConfig> {
    throw new Error('not exercised')
  }
}

const WORKSTREAM_ID = '00000000-0000-4000-8000-000000000001'

async function insertWorkstream(pool: pg.Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [id, 'p', 't', randomUUID()])
}

function request(overrides: Partial<OwnerRequest> = {}): OwnerRequest {
  const payload = overrides.payload ?? {}
  return {
    epoch: 1,
    workstreamId: WORKSTREAM_ID,
    attemptKey: 'attempt-1',
    operation: 'attach_grant',
    target: { kind: 'concrete', id: 'incarnation-1' },
    payload,
    payloadDigest: payloadDigest(payload),
    revisionSet: {},
    ...overrides,
  }
}

async function post(port: number, req: OwnerRequest): Promise<{ kind: string; [key: string]: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/owner-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
  return (await res.json()) as { kind: string; [key: string]: unknown }
}

test('owner-api attach_grant: ensures the incarnation\'s Agent and attaches the compiled desired set', async () => {
  await withTestDatabase(async (pool) => {
    await insertWorkstream(pool, WORKSTREAM_ID)
    const client = new StatefulOneCliClient()
    const gate = new PgOwnerGate(pool, 'broker')
    const server = createBrokerApi({ client, gate })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const desired: readonly Authorization[] = [{ kind: 'secret', credential: 's1', tools: 'full', approval: 'unconditional', restrictions: [] }]
      const result = await post(port, request({ payload: { grants: toWireGrantSet(new Set(desired)) } }))
      assert.equal(result.kind, 'completed')
      assert.ok(client.secrets.has('s1'))
    } finally {
      server.close()
    }
  })
})

test('owner-api attach_grant: an idempotent replay attaches nothing twice', async () => {
  await withTestDatabase(async (pool) => {
    await insertWorkstream(pool, WORKSTREAM_ID)
    const client = new StatefulOneCliClient()
    const gate = new PgOwnerGate(pool, 'broker')
    const server = createBrokerApi({ client, gate })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const desired: readonly Authorization[] = [{ kind: 'secret', credential: 's1', tools: 'full', approval: 'unconditional', restrictions: [] }]
      const req = request({ payload: { grants: toWireGrantSet(new Set(desired)) } })
      const first = await post(port, req)
      const replay = await post(port, req)
      assert.deepEqual(replay, first)
    } finally {
      server.close()
    }
  })
})

test('owner-api detach_grant: narrows an over-broad connection to the desired scope', async () => {
  await withTestDatabase(async (pool) => {
    await insertWorkstream(pool, WORKSTREAM_ID)
    const client = new StatefulOneCliClient()
    // Pre-seed via a create then an over-broad attach, bypassing the API to set up the scenario.
    await client.createAgent('x', 'incarnation-2')
    client.connections.set('c1', { connectionId: 'c1', provider: 'github-app', access: 'custom', allow: ['get_repo', 'list_repos'], ask: [] })
    const gate = new PgOwnerGate(pool, 'broker')
    const server = createBrokerApi({ client, gate })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const desired: readonly Authorization[] = [{ kind: 'connection', credential: 'c1', tools: new Set(['get_repo']), approval: 'unconditional', restrictions: [] }]
      const result = await post(port, request({ operation: 'detach_grant', target: { kind: 'concrete', id: 'incarnation-2' }, payload: { grants: toWireGrantSet(new Set(desired)) } }))
      assert.equal(result.kind, 'completed')
      assert.deepEqual(client.connections.get('c1')!.allow, ['get_repo'])
    } finally {
      server.close()
    }
  })
})

test('owner-api detach_grant: closes the relay to the incarnation before narrowing authority (003 verbs REVOKE)', async () => {
  await withTestDatabase(async (pool) => {
    await insertWorkstream(pool, WORKSTREAM_ID)
    const client = new StatefulOneCliClient()
    await client.createAgent('x', 'incarnation-3')
    const terminated: string[] = []
    const tunnels = {
      terminateAll: (incarnation: string): number => {
        terminated.push(incarnation)
        return 1
      },
    }
    const gate = new PgOwnerGate(pool, 'broker')
    const server = createBrokerApi({ client, gate, tunnels })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      await post(port, request({ operation: 'detach_grant', target: { kind: 'concrete', id: 'incarnation-3' }, payload: { grants: [] } }))
      assert.deepEqual(terminated, ['incarnation-3'])
    } finally {
      server.close()
    }
  })
})

test('owner-api cleanup_agent: deletes the Agent and retires the target for future positive operations', async () => {
  await withTestDatabase(async (pool) => {
    await insertWorkstream(pool, WORKSTREAM_ID)
    const client = new StatefulOneCliClient()
    const gate = new PgOwnerGate(pool, 'broker')
    const server = createBrokerApi({ client, gate })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      await post(port, request({ payload: { grants: [] } })) // creates the Agent for incarnation-1
      const cleanup = await post(port, request({ operation: 'cleanup_agent', attemptKey: 'attempt-cleanup' }))
      assert.equal(cleanup.kind, 'completed')
      assert.deepEqual(await client.listAgents(), [])

      const retriedAttach = await post(port, request({ attemptKey: 'attempt-after-retirement', epoch: 2 }))
      assert.equal(retriedAttach.kind, 'rejected_stale_epoch', 'a retired incarnation refuses a new positive operation forever')
    } finally {
      server.close()
    }
  })
})
