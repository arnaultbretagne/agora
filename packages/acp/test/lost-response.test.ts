import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootstrapSession } from '../src/coordinator.js'
import { createFakeAgent } from '../src/fake-agent.js'
import { createInMemoryPair, seedSession, TEST_CAPABILITY, withTestDatabase } from './support.js'

test('required: a lost/failed response to session/new fails closed without binding any ID', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId, sessionId } = await seedSession(pool)
    const { clientStream, agentStream } = createInMemoryPair()

    const fakeAgent = createFakeAgent({
      onSessionNew: () => {
        throw new Error('simulated lost/failed session/new response')
      },
    })
    const agentConnection = fakeAgent.connect(agentStream)

    await assert.rejects(() =>
      bootstrapSession({
        pool,
        workstreamId,
        sessionId,
        stream: clientStream,
        cwd: '/work',
        capabilityPolicyVersion: TEST_CAPABILITY.policyVersion,
        capabilityDigest: TEST_CAPABILITY.digest,
      }),
    )

    const { rows } = await pool.query('SELECT acp_session_id, phase, failure_code FROM product.sessions WHERE id = $1', [sessionId])
    assert.equal(rows[0].acp_session_id, null, 'no fallback binding is ever invented')
    assert.equal(rows[0].phase, 'failed')
    assert.equal(rows[0].failure_code, 'acp_session_new_failed')

    agentConnection.close()
  })
})
