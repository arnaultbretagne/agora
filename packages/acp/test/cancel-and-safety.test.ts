import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import { bootstrapSession, cancelSession, promptSession } from '../src/coordinator.js'
import { createFakeAgent } from '../src/fake-agent.js'
import { createInMemoryPair, seedSession, TEST_CAPABILITY, withTestDatabase } from './support.js'

test('required: cancel still accepts final racing updates', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId, sessionId } = await seedSession(pool)
    const { clientStream, agentStream } = createInMemoryPair()

    let resolveCancelSeen: () => void = () => {}
    const cancelSeen = new Promise<void>((resolve) => {
      resolveCancelSeen = resolve
    })

    const fakeAgent = createFakeAgent({
      onPrompt: async (params, context) => {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before cancel' } },
        })
        await cancelSeen
        // A racing final update sent AFTER cancellation was requested — must still be journaled.
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'final racing update' } },
        })
        return { stopReason: 'cancelled' }
      },
      onCancel: () => {
        resolveCancelSeen()
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

    const promptPromise = promptSession({
      pool,
      workstreamId,
      sessionId,
      connection: bootstrap.connection,
      storePersist: bootstrap.storePersist,
      acpSessionId: bootstrap.acpSessionId,
      prompt: [{ type: 'text', text: 'hello' }],
      purpose: 'user',
      actor: { kind: 'human', id: 'alice' },
      idempotencyKey: 'turn-1',
    })

    await cancelSession({ connection: bootstrap.connection, acpSessionId: bootstrap.acpSessionId })
    const result = await promptPromise
    assert.deepEqual(result, { outcome: 'completed', stopReason: 'cancelled' })

    const { rows } = await pool.query<{ envelope: { method?: string; params?: { update?: { content?: { text?: string } } } } }>(
      "SELECT envelope FROM product.workstream_events WHERE workstream_id = $1 AND method = 'session/update' ORDER BY workstream_seq",
      [workstreamId],
    )
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.envelope.params?.update?.content?.text, 'before cancel')
    assert.equal(rows[1]!.envelope.params?.update?.content?.text, 'final racing update')

    agentConnection.close()
    bootstrap.connection.close()
  })
})

test('required: a credential-bearing MCP descriptor is rejected before any envelope is sent', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId, sessionId } = await seedSession(pool)
    const { clientStream, agentStream } = createInMemoryPair()
    const fakeAgent = createFakeAgent()
    const agentConnection = fakeAgent.connect(agentStream)

    const unsafeMcpServers: acp.McpServer[] = [
      {
        name: 'leaky-server',
        command: '/usr/local/bin/mcp-server',
        args: [],
        env: [{ name: 'AUTHORIZATION', value: 'aoc_live_1234567890abcdef' }],
      },
    ]

    await assert.rejects(
      () =>
        bootstrapSession({
          pool,
          workstreamId,
          sessionId,
          stream: clientStream,
          cwd: '/work',
          capabilityPolicyVersion: TEST_CAPABILITY.policyVersion,
          capabilityDigest: TEST_CAPABILITY.digest,
          mcpServers: unsafeMcpServers,
        }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'secret_pattern_rejected',
    )

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM product.workstream_events WHERE workstream_id = $1', [workstreamId])
    assert.equal(rows[0].n, 0, 'nothing was journaled — the guard runs before any wire activity')

    agentConnection.close()
  })
})
