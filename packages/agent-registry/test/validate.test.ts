import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FAKE_AGENT_DEFINITION } from '../src/fake-definition.js'
import { InvalidAgentRuntimeDefinitionError, validateAgentRuntimeDefinition, validateRegistry } from '../src/validate.js'

test('the fake Agent definition validates against contracts/schemas/agent-runtime.schema.json', async () => {
  const validated = await validateAgentRuntimeDefinition(FAKE_AGENT_DEFINITION)
  assert.deepEqual(validated, FAKE_AGENT_DEFINITION)
})

test('required (task): arbitrary/malformed definitions are schema-rejected', async () => {
  await assert.rejects(
    () => validateAgentRuntimeDefinition({ ...FAKE_AGENT_DEFINITION, imageDigest: 'not-a-digest' }),
    InvalidAgentRuntimeDefinitionError,
  )
  await assert.rejects(
    () => validateAgentRuntimeDefinition({ ...FAKE_AGENT_DEFINITION, extraField: 'not allowed' }),
    InvalidAgentRuntimeDefinitionError,
  )
  const { acpCommand, ...withoutAcpCommand } = FAKE_AGENT_DEFINITION
  void acpCommand
  await assert.rejects(() => validateAgentRuntimeDefinition(withoutAcpCommand), InvalidAgentRuntimeDefinitionError)
})

test('validateRegistry validates every entry and preserves order', async () => {
  const definitions = await validateRegistry([FAKE_AGENT_DEFINITION, { ...FAKE_AGENT_DEFINITION, agentId: 'fake-agent-2' }])
  assert.equal(definitions.length, 2)
  assert.equal(definitions[1]?.agentId, 'fake-agent-2')
})
