import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FAKE_AGENT_DEFINITION } from '../src/fake-definition.js'
import { AgentNotLaunchableError, resolveLaunchableDefinition, selectLaunchableAgents } from '../src/registry.js'
import type { AgentRuntimeDefinition } from '../src/types.js'

function withRollout(rollout: AgentRuntimeDefinition['rollout'], agentId = 'fake-agent'): AgentRuntimeDefinition {
  return { ...FAKE_AGENT_DEFINITION, agentId, rollout }
}

test('selectLaunchableAgents exposes only safe public fields, never image/command/custody', () => {
  const result = selectLaunchableAgents([FAKE_AGENT_DEFINITION], 'rev-1')
  assert.equal(result.registryRevision, 'rev-1')
  assert.deepEqual(result.items, [
    {
      agentId: 'fake-agent',
      runtimeDefinitionVersion: '2026-08-03',
      label: 'Fake Agent (tests)',
      description: 'Deterministic in-process fake ACP Agent, wrapped for Session Runtime controller tests.',
      availability: 'enabled',
      // Reviewed personas are a safe public field (a name the operator approved, never a credential
      // or an image detail) and are ALWAYS present — an Agent with none yields [], which the product
      // surface reads as "offer no persona choice".
      personas: [],
    },
  ])
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('imageDigest'), false)
  assert.equal(serialized.includes('acpCommand'), false)
  assert.equal(serialized.includes('captureRoots'), false)
})

test('disabled and retired definitions never appear in the projection', () => {
  const result = selectLaunchableAgents(
    [withRollout('disabled', 'a'), withRollout('retired', 'b'), withRollout('enabled', 'c')],
    'rev-1',
  )
  assert.deepEqual(
    result.items.map((i) => i.agentId),
    ['c'],
  )
})

test('internal and deprecated definitions are listed with the right availability', () => {
  const result = selectLaunchableAgents([withRollout('internal', 'a'), withRollout('deprecated', 'b')], 'rev-1')
  assert.equal(result.items.find((i) => i.agentId === 'a')?.availability, 'enabled')
  assert.equal(result.items.find((i) => i.agentId === 'b')?.availability, 'deprecated')
})

test('required (task): resolves only enabled, exact registry definitions', () => {
  const definitions = [FAKE_AGENT_DEFINITION]
  const resolved = resolveLaunchableDefinition(definitions, 'fake-agent', '2026-08-03')
  assert.equal(resolved, FAKE_AGENT_DEFINITION)

  assert.throws(
    () => resolveLaunchableDefinition(definitions, 'fake-agent', 'wrong-version'),
    AgentNotLaunchableError,
  )
  assert.throws(() => resolveLaunchableDefinition(definitions, 'unknown-agent', '2026-08-03'), AgentNotLaunchableError)

  const deprecated = [withRollout('deprecated')]
  assert.throws(
    () => resolveLaunchableDefinition(deprecated, 'fake-agent', '2026-08-03'),
    (error: unknown) => error instanceof AgentNotLaunchableError && error.message.includes('deprecated'),
  )
})
