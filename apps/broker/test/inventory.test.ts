import assert from 'node:assert/strict'
import { test } from 'node:test'
import { equals } from '@agora/domain'
import type { Authorization } from '@agora/domain'
import { normalizeAttached, readConsistentInventory } from '../src/inventory.js'
import type { AgentGrants, ConnectionGrantInput, ContainerConfig, EffectiveCredentials, OneCliAgent, OneCliClient, OneCliConnection, OneCliSecret } from '../src/onecli/client.js'

function grants(overrides: Partial<AgentGrants> = {}): AgentGrants {
  return { agentId: 'a1', connections: [], secrets: [], ...overrides }
}

class ScriptedOneCliClient implements OneCliClient {
  #attachedReads: readonly AgentGrants[]
  #effectiveReads: readonly EffectiveCredentials[]
  #attachedIndex = 0
  #effectiveIndex = 0
  attachedReadCount = 0

  constructor(attachedReads: readonly AgentGrants[], effectiveReads: readonly EffectiveCredentials[]) {
    this.#attachedReads = attachedReads
    this.#effectiveReads = effectiveReads
  }

  async getAgentGrants(): Promise<AgentGrants> {
    this.attachedReadCount += 1
    const value = this.#attachedReads[Math.min(this.#attachedIndex, this.#attachedReads.length - 1)]!
    this.#attachedIndex += 1
    return value
  }

  async getEffectiveCredentials(): Promise<EffectiveCredentials> {
    const value = this.#effectiveReads[Math.min(this.#effectiveIndex, this.#effectiveReads.length - 1)]!
    this.#effectiveIndex += 1
    return value
  }

  async listAgents(): Promise<readonly OneCliAgent[]> {
    return []
  }
  async createAgent(): Promise<{ id: string; name: string; identifier: string; createdAt: string }> {
    throw new Error('not exercised')
  }
  async deleteAgent(): Promise<void> {}
  async setAgentSecretGrant(): Promise<AgentGrants> {
    throw new Error('not exercised')
  }
  async removeAgentSecretGrant(): Promise<void> {}
  async setAgentConnectionGrant(_agentId: string, _connectionId: string, _grant: ConnectionGrantInput): Promise<AgentGrants> {
    throw new Error('not exercised')
  }
  async removeAgentConnectionGrant(): Promise<void> {}
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

test('normalizeAttached: a full-access connection and an all-or-nothing secret', () => {
  const set = normalizeAttached(grants({ secrets: [{ secretId: 's1', name: 'x', type: 'anthropic' }], connections: [{ connectionId: 'c1', provider: 'github-app', access: 'full', allow: [], ask: [] }] }))
  assert.equal(set.size, 2)
})

test('normalizeAttached: a custom connection splits into an unconditional grant and a gated one', () => {
  const set = normalizeAttached(grants({ connections: [{ connectionId: 'c1', provider: 'github-app', access: 'custom', allow: ['get_repo'], ask: ['git_push'] }] }))
  const list = [...set]
  assert.equal(list.length, 2)
  assert.ok(list.some((a) => a.approval === 'unconditional' && (a.tools as Set<string>).has('get_repo')))
  assert.ok(list.some((a) => a.approval === 'required' && (a.tools as Set<string>).has('git_push')))
})

test('readConsistentInventory: attached agrees on the first bracket — one round trip', async () => {
  const stable = grants({ secrets: [{ secretId: 's1', name: 'x', type: 'anthropic' }] })
  const client = new ScriptedOneCliClient([stable, stable], [{ agentId: 'a1', mode: 'selective', secrets: [{ kind: 'secret', id: 's1', status: 'usable' }], connections: [] }])
  const result = await readConsistentInventory(client, 'a1')
  assert.ok(result)
  assert.equal(client.attachedReadCount, 2)
  assert.ok(equals(result!.effective, new Set<Authorization>([{ kind: 'secret', credential: 's1', tools: 'full', approval: 'unconditional', restrictions: [] }])))
})

test('readConsistentInventory: an attached change mid-read forces a retry, not a fabricated pairing', async () => {
  const first = grants({ secrets: [{ secretId: 's1', name: 'x', type: 'anthropic' }] })
  const changedMidRead = grants({ secrets: [{ secretId: 's1', name: 'x', type: 'anthropic' }, { secretId: 's2', name: 'y', type: 'openai' }] })
  const settled = changedMidRead
  // Sequence of getAgentGrants calls: before(1st bracket)=first, after(1st bracket)=changedMidRead (mismatch, retry),
  // before(2nd bracket, reused)=changedMidRead, after(2nd bracket)=settled (match).
  const client = new ScriptedOneCliClient(
    [first, changedMidRead, settled],
    [
      { agentId: 'a1', mode: 'selective', secrets: [{ kind: 'secret', id: 's1', status: 'usable' }], connections: [] },
      { agentId: 'a1', mode: 'selective', secrets: [{ kind: 'secret', id: 's1', status: 'usable' }, { kind: 'secret', id: 's2', status: 'usable' }], connections: [] },
    ],
  )
  const result = await readConsistentInventory(client, 'a1')
  assert.ok(result)
  assert.equal(result!.attached.size, 2, 'the settled pair, not the mid-flight one')
})

test('readConsistentInventory: a read that never settles within the budget produces no set', async () => {
  const alwaysDifferent = () => grants({ secrets: [{ secretId: `s-${Math.random()}`, name: 'x', type: 'anthropic' }] })
  const client = new ScriptedOneCliClient([alwaysDifferent(), alwaysDifferent(), alwaysDifferent(), alwaysDifferent(), alwaysDifferent(), alwaysDifferent(), alwaysDifferent()], [
    { agentId: 'a1', mode: 'selective', secrets: [], connections: [] },
  ])
  const result = await readConsistentInventory(client, 'a1', 3)
  assert.equal(result, undefined)
})

test('an effective credential not reported usable contributes nothing, even if attached', async () => {
  const stable = grants({ secrets: [{ secretId: 's1', name: 'x', type: 'anthropic' }] })
  const client = new ScriptedOneCliClient([stable, stable], [{ agentId: 'a1', mode: 'selective', secrets: [{ kind: 'secret', id: 's1', status: 'blocked' }], connections: [] }])
  const result = await readConsistentInventory(client, 'a1')
  assert.equal(result!.effective.size, 0)
  assert.equal(result!.attached.size, 1, 'attached is unaffected by organization-level restriction')
})
