import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootstrapSession, promptSession } from '../src/coordinator.js'
import { createFakeAgent } from '../src/fake-agent.js'
import { createInMemoryPair, seedSession, TEST_CAPABILITY, withTestDatabase } from './support.js'

test('required: a duplicate dispatcher wakeup does not send an already-acknowledged prompt twice', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId, sessionId } = await seedSession(pool)
    const { clientStream, agentStream } = createInMemoryPair()

    let promptInvocations = 0
    const fakeAgent = createFakeAgent({
      onPrompt: () => {
        promptInvocations += 1
        return { stopReason: 'end_turn' }
      },
    })
    const agentConnection = fakeAgent.connect(agentStream)

    const bootstrap = await bootstrapSession({
      pool,
      workstreamId,
      sessionId,
      stream: clientStream,
      cwd: '/work',
      capabilityPolicyVersion: TEST_CAPABILITY.policyVersion,
      capabilityDigest: TEST_CAPABILITY.digest,
    })

    const promptInput = {
      pool,
      workstreamId,
      sessionId,
      connection: bootstrap.connection,
      storePersist: bootstrap.storePersist,
      acpSessionId: bootstrap.acpSessionId,
      prompt: [{ type: 'text' as const, text: 'hello' }],
      purpose: 'user' as const,
      actor: { kind: 'human' as const, id: 'alice' },
      idempotencyKey: 'turn-1',
    }

    const first = await promptSession(promptInput)
    assert.deepEqual(first, { outcome: 'completed', stopReason: 'end_turn' })
    assert.equal(promptInvocations, 1)

    // A "duplicate dispatcher wakeup": same idempotency key, command already past `accepted`.
    const second = await promptSession(promptInput)
    assert.deepEqual(second, { outcome: 'already_dispatched', state: 'completed' })
    assert.equal(promptInvocations, 1, 'the Agent must not be asked to prompt a second time')

    const third = await promptSession(promptInput)
    assert.deepEqual(third, { outcome: 'already_dispatched', state: 'completed' })
    assert.equal(promptInvocations, 1)

    agentConnection.close()
    bootstrap.connection.close()
  })
})
