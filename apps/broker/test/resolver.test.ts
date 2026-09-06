import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OneCliCredentialResolver } from '../src/onecli/resolver.js'
import type { AgentGrants, ConnectionGrantInput, ContainerConfig, EffectiveCredentials, OneCliAgent, OneCliClient, OneCliConnection, OneCliSecret } from '../src/onecli/client.js'

class FakeOneCliClient implements OneCliClient {
  constructor(
    private readonly secrets: readonly OneCliSecret[],
    private readonly connections: readonly OneCliConnection[],
  ) {}
  async listAgents(): Promise<readonly OneCliAgent[]> {
    return []
  }
  async createAgent(): Promise<{ id: string; name: string; identifier: string; createdAt: string }> {
    throw new Error('not exercised')
  }
  async deleteAgent(): Promise<void> {}
  async getAgentGrants(): Promise<AgentGrants> {
    throw new Error('not exercised')
  }
  async getEffectiveCredentials(): Promise<EffectiveCredentials> {
    throw new Error('not exercised')
  }
  async setAgentSecretGrant(): Promise<AgentGrants> {
    throw new Error('not exercised')
  }
  async removeAgentSecretGrant(): Promise<void> {}
  async setAgentConnectionGrant(_agentId: string, _connectionId: string, _grant: ConnectionGrantInput): Promise<AgentGrants> {
    throw new Error('not exercised')
  }
  async removeAgentConnectionGrant(): Promise<void> {}
  async listSecrets(): Promise<readonly OneCliSecret[]> {
    return this.secrets
  }
  async listConnections(): Promise<readonly OneCliConnection[]> {
    return this.connections
  }
  async getContainerConfig(): Promise<ContainerConfig> {
    throw new Error('not exercised')
  }
}

test('resolves a secret by type and a connection by provider — the catalogue\'s stable refs', async () => {
  const client = new FakeOneCliClient(
    [{ id: 'secret-1', name: 'Anthropic Token', type: 'anthropic', scope: 'project' }],
    [{ id: 'conn-1', provider: 'github-app', label: 'arnaultbretagne', scope: 'project' }],
  )
  const resolver = new OneCliCredentialResolver(client)
  await resolver.refresh()
  assert.equal(resolver.resolveSecret('anthropic'), 'secret-1')
  assert.equal(resolver.resolveConnection('github-app'), 'conn-1')
})

test('an unconfigured credential resolves to undefined, never a guess', async () => {
  const client = new FakeOneCliClient([], [])
  const resolver = new OneCliCredentialResolver(client)
  await resolver.refresh()
  assert.equal(resolver.resolveSecret('anthropic'), undefined)
  assert.equal(resolver.resolveConnection('github-app'), undefined)
})

test('before refresh, everything is unresolved rather than stale', () => {
  const resolver = new OneCliCredentialResolver(new FakeOneCliClient([], []))
  assert.equal(resolver.resolveSecret('anthropic'), undefined)
})

test('two secrets of the same type are ambiguous — neither is silently picked', async () => {
  const client = new FakeOneCliClient(
    [
      { id: 'secret-1', name: 'Anthropic Token A', type: 'anthropic', scope: 'project' },
      { id: 'secret-2', name: 'Anthropic Token B', type: 'anthropic', scope: 'project' },
    ],
    [],
  )
  const resolver = new OneCliCredentialResolver(client)
  await resolver.refresh()
  assert.equal(resolver.resolveSecret('anthropic'), undefined)
})
