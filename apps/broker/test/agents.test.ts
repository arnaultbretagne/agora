import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentIdentifierFor, ensureAgent, retireAgent } from '../src/agents.js'
import type { AgentGrants, ConnectionGrantInput, ContainerConfig, EffectiveCredentials, HttpError, OneCliAgent, OneCliClient, OneCliConnection, OneCliSecret } from '../src/onecli/client.js'

class FakeOneCliClient implements OneCliClient {
  #agents = new Map<string, OneCliAgent>()
  #nextId = 1
  #failNextCreateWith409 = false
  createCalls = 0

  failNextCreateWith409(): void {
    this.#failNextCreateWith409 = true
  }

  seedAgent(agent: OneCliAgent): void {
    this.#agents.set(agent.id, agent)
  }

  async listAgents(): Promise<readonly OneCliAgent[]> {
    return [...this.#agents.values()]
  }

  async createAgent(name: string, identifier: string): Promise<{ id: string; name: string; identifier: string; createdAt: string }> {
    this.createCalls += 1
    if (this.#failNextCreateWith409) {
      this.#failNextCreateWith409 = false
      throw Object.assign(new Error('already exists'), { status: 409 }) satisfies HttpError
    }
    if ([...this.#agents.values()].some((a) => a.identifier === identifier)) {
      throw Object.assign(new Error('already exists'), { status: 409 }) satisfies HttpError
    }
    const id = `agent-${this.#nextId++}`
    const createdAt = new Date().toISOString()
    this.#agents.set(id, { id, name, identifier, isDefault: false, createdAt })
    return { id, name, identifier, createdAt }
  }

  async deleteAgent(agentId: string): Promise<void> {
    this.#agents.delete(agentId)
  }

  async getAgentGrants(): Promise<AgentGrants> {
    throw new Error('not exercised')
  }

  async getEffectiveCredentials(): Promise<EffectiveCredentials> {
    throw new Error('not exercised')
  }

  async setAgentSecretGrant(): Promise<AgentGrants> {
    throw new Error('not exercised')
  }

  async removeAgentSecretGrant(): Promise<void> {
    throw new Error('not exercised')
  }

  async setAgentConnectionGrant(_agentId: string, _connectionId: string, _grant: ConnectionGrantInput): Promise<AgentGrants> {
    throw new Error('not exercised')
  }

  async removeAgentConnectionGrant(): Promise<void> {
    throw new Error('not exercised')
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

test('agentIdentifierFor is deterministic and hyphen-safe', () => {
  const a = agentIdentifierFor('pod-uid-1')
  const b = agentIdentifierFor('pod-uid-1')
  const c = agentIdentifierFor('pod-uid-2')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^[a-z0-9][a-z0-9-]{0,49}$/)
})

test('ensureAgent creates exactly one Agent per incarnation', async () => {
  const client = new FakeOneCliClient()
  const agent = await ensureAgent(client, 'incarnation-1')
  assert.equal(agent.identifier, agentIdentifierFor('incarnation-1'))
  assert.equal(client.createCalls, 1)
})

test('ensureAgent on a 409 (crash-then-retry) discovers the already-created Agent instead of failing', async () => {
  const client = new FakeOneCliClient()
  const identifier = agentIdentifierFor('incarnation-2')
  client.seedAgent({ id: 'existing-agent', name: identifier, identifier, isDefault: false, createdAt: new Date().toISOString() })
  client.failNextCreateWith409()
  const agent = await ensureAgent(client, 'incarnation-2')
  assert.equal(agent.id, 'existing-agent')
})

test('retireAgent deletes the incarnation\'s Agent and is a no-op if none was ever created', async () => {
  const client = new FakeOneCliClient()
  await retireAgent(client, 'never-created') // must not throw
  const agent = await ensureAgent(client, 'incarnation-3')
  await retireAgent(client, 'incarnation-3')
  assert.deepEqual(await client.listAgents(), [])
  void agent
})

test('two different incarnations never collide on the same Agent', async () => {
  const client = new FakeOneCliClient()
  const first = await ensureAgent(client, 'incarnation-a')
  const second = await ensureAgent(client, 'incarnation-b')
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.identifier, second.identifier)
})
