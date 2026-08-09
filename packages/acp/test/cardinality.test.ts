import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootstrapSession, promptSession } from '../src/coordinator.js'
import { createFakeAgent } from '../src/fake-agent.js'
import { createInMemoryPair, seedSession, TEST_CAPABILITY, withTestDatabase } from './support.js'

test('required: invocation cardinality remains enforced at command acceptance', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId, sessionId } = await seedSession(pool, { category: 'invocation' })
    const { clientStream, agentStream } = createInMemoryPair()

    const fakeAgent = createFakeAgent()
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

    const first = await promptSession({
      pool,
      workstreamId,
      sessionId,
      connection: bootstrap.connection,
      storePersist: bootstrap.storePersist,
      acpSessionId: bootstrap.acpSessionId,
      prompt: [{ type: 'text', text: 'the one and only prompt' }],
      purpose: 'user',
      actor: { kind: 'human', id: 'alice' },
      idempotencyKey: 'first-prompt',
    })
    assert.deepEqual(first, { outcome: 'completed', stopReason: 'end_turn' })

    // A second, genuinely NEW user-purpose prompt on an invocation Workstream is rejected.
    await assert.rejects(
      () =>
        promptSession({
          pool,
          workstreamId,
          sessionId,
          connection: bootstrap.connection,
      storePersist: bootstrap.storePersist,
          acpSessionId: bootstrap.acpSessionId,
          prompt: [{ type: 'text', text: 'a second prompt, not allowed' }],
          purpose: 'user',
          actor: { kind: 'human', id: 'alice' },
          idempotencyKey: 'second-prompt',
        }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'invocation_cardinality_exceeded',
    )

    // Handoff-purpose exemption from cardinality is a domain-level guarantee already proven in
    // packages/domain (assertPromptCardinalityAllowed never counts purpose='handoff'). Actually
    // dispatching a handoff PromptSession command needs the source-range/seed-policy fields ADR
    // 0008 defines — that is P07 "Cross-Agent handoff" scope, explicitly out of this plan's reach
    // (non-goal: "No cross-Agent handoff"), so it is not exercised end-to-end here.

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM product.commands WHERE workstream_id = $1 AND purpose = 'user'",
      [workstreamId],
    )
    assert.equal(rows[0].n, 1, 'only the first user-purpose command was ever accepted')

    agentConnection.close()
    bootstrap.connection.close()
  })
})
