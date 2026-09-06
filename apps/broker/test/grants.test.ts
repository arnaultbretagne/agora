import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Authorization } from '@agora/domain'
import { attachDesiredGrants, revokeExcessGrants } from '../src/grants.js'
import type { AgentGrantConnection, AgentGrantSecret, AgentGrants, ConnectionGrantInput, ContainerConfig, EffectiveCredentials, OneCliAgent, OneCliClient, OneCliConnection, OneCliSecret } from '../src/onecli/client.js'

/** A stateful fake standing in for OneCLI's own grant state — PUT replaces, DELETE removes. */
class StatefulOneCliClient implements OneCliClient {
  secrets = new Map<string, AgentGrantSecret>()
  connections = new Map<string, AgentGrantConnection>()
  calls: string[] = []

  async getAgentGrants(): Promise<AgentGrants> {
    return { agentId: 'a1', secrets: [...this.secrets.values()], connections: [...this.connections.values()] }
  }
  async setAgentSecretGrant(_agentId: string, secretId: string): Promise<AgentGrants> {
    this.calls.push(`setSecret:${secretId}`)
    this.secrets.set(secretId, { secretId, name: secretId, type: 'anthropic' })
    return this.getAgentGrants()
  }
  async removeAgentSecretGrant(_agentId: string, secretId: string): Promise<void> {
    this.calls.push(`removeSecret:${secretId}`)
    this.secrets.delete(secretId)
  }
  async setAgentConnectionGrant(_agentId: string, connectionId: string, grant: ConnectionGrantInput): Promise<AgentGrants> {
    this.calls.push(`setConnection:${connectionId}:${JSON.stringify(grant)}`)
    this.connections.set(connectionId, grant.access === 'full' ? { connectionId, provider: 'github-app', access: 'full', allow: [], ask: [] } : { connectionId, provider: 'github-app', access: 'custom', allow: grant.allow, ask: grant.ask })
    return this.getAgentGrants()
  }
  async removeAgentConnectionGrant(_agentId: string, connectionId: string): Promise<void> {
    this.calls.push(`removeConnection:${connectionId}`)
    this.connections.delete(connectionId)
  }
  async listAgents(): Promise<readonly OneCliAgent[]> {
    return []
  }
  async createAgent(): Promise<{ id: string; name: string; identifier: string; createdAt: string }> {
    throw new Error('not exercised')
  }
  async deleteAgent(): Promise<void> {}
  async getEffectiveCredentials(): Promise<EffectiveCredentials> {
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

function secretAuth(credential: string): Authorization {
  return { kind: 'secret', credential, tools: 'full', approval: 'unconditional', restrictions: [] }
}

test('attachDesiredGrants: attaches a missing secret and leaves nothing else', async () => {
  const client = new StatefulOneCliClient()
  await attachDesiredGrants(client, 'a1', new Set([secretAuth('s1')]))
  assert.deepEqual(client.calls, ['setSecret:s1'])
})

test('attachDesiredGrants: already-exact attachment issues no call (idempotent retry)', async () => {
  const client = new StatefulOneCliClient()
  const desired = new Set([secretAuth('s1')])
  await attachDesiredGrants(client, 'a1', desired)
  client.calls = []
  await attachDesiredGrants(client, 'a1', desired)
  assert.deepEqual(client.calls, [], 'never re-issues an already-satisfied grant')
})

test('attachDesiredGrants: a connection split across unconditional and gated tools lands in one combined PUT', async () => {
  const client = new StatefulOneCliClient()
  const desired = new Set<Authorization>([
    { kind: 'connection', credential: 'c1', tools: new Set(['get_repo']), approval: 'unconditional', restrictions: [] },
    { kind: 'connection', credential: 'c1', tools: new Set(['git_push']), approval: 'required', restrictions: [] },
  ])
  await attachDesiredGrants(client, 'a1', desired)
  assert.equal(client.calls.length, 1, 'one PUT per connection, not one per Authorization entry')
  const grant = client.connections.get('c1')!
  assert.deepEqual([...grant.allow].sort(), ['get_repo'])
  assert.deepEqual([...grant.ask].sort(), ['git_push'])
})

test('attachDesiredGrants never touches a credential absent from desired', async () => {
  const client = new StatefulOneCliClient()
  client.secrets.set('untouched', { secretId: 'untouched', name: 'untouched', type: 'openai' })
  await attachDesiredGrants(client, 'a1', new Set([secretAuth('s1')]))
  assert.ok(client.secrets.has('untouched'), 'GRANT is not REVOKE')
})

test('revokeExcessGrants: detaches a secret absent from desired', async () => {
  const client = new StatefulOneCliClient()
  client.secrets.set('s1', { secretId: 's1', name: 's1', type: 'anthropic' })
  await revokeExcessGrants(client, 'a1', new Set())
  assert.deepEqual(client.calls, ['removeSecret:s1'])
})

test('revokeExcessGrants: narrows a connection to the desired tool scope rather than detaching it', async () => {
  const client = new StatefulOneCliClient()
  client.connections.set('c1', { connectionId: 'c1', provider: 'github-app', access: 'custom', allow: ['get_repo', 'list_repos'], ask: [] })
  const desired = new Set<Authorization>([{ kind: 'connection', credential: 'c1', tools: new Set(['get_repo']), approval: 'unconditional', restrictions: [] }])
  await revokeExcessGrants(client, 'a1', desired)
  assert.equal(client.calls.length, 1)
  assert.ok(client.calls[0]!.startsWith('setConnection:c1'), 'narrows via PUT, does not detach')
  assert.deepEqual(client.connections.get('c1')!.allow, ['get_repo'])
})

test('revokeExcessGrants: an attached secret already equal to desired is left alone', async () => {
  const client = new StatefulOneCliClient()
  client.secrets.set('s1', { secretId: 's1', name: 's1', type: 'anthropic' })
  await revokeExcessGrants(client, 'a1', new Set([secretAuth('s1')]))
  assert.deepEqual(client.calls, [])
})
