import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootstrapSession, promptSession } from '../src/coordinator.js'
import { createFakeAgent } from '../src/fake-agent.js'
import { createInMemoryPair, seedSession, TEST_CAPABILITY, withTestDatabase } from './support.js'

interface AcpEnvelope {
  readonly method?: string
  readonly params?: {
    readonly update?: {
      readonly sessionUpdate?: string
      readonly messageId?: string
      readonly toolCallId?: string
      readonly content?: { readonly _meta?: Record<string, unknown> }
    }
  }
  readonly result?: Record<string, unknown>
}

interface EventRow {
  readonly direction: string
  readonly rpc_kind: string
  readonly method: string | null
  readonly command_id: string | null
  // pg auto-parses `jsonb` columns into JS values — this is already an object, not raw text.
  readonly envelope: AcpEnvelope
  readonly workstream_seq: number
  readonly session_seq: number
}

test('required: golden transcript for initialize/new/prompt/update/response, with _meta surviving readback', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId, sessionId } = await seedSession(pool)
    const { clientStream, agentStream } = createInMemoryPair()

    const fakeAgent = createFakeAgent({
      acpSessionId: 'acp-golden',
      onPrompt: async (params, context) => {
        await context.client.notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'message-1',
            content: { type: 'text', text: 'first chunk', _meta: { 'vendor/content': 'preserved' } },
          },
        })
        await context.client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'second chunk' } },
        })
        await context.client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: 'tool-call-1', title: 'Read a file', status: 'pending' },
        })
        return { stopReason: 'end_turn', _meta: { 'vendor/response': 'preserved' } }
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
    assert.equal(bootstrap.acpSessionId, 'acp-golden')
    assert.equal(bootstrap.protocolVersion, 1)

    const result = await promptSession({
      pool,
      workstreamId,
      sessionId,
      connection: bootstrap.connection,
      storePersist: bootstrap.storePersist,
      acpSessionId: bootstrap.acpSessionId,
      prompt: [{ type: 'text', text: 'hello agent' }],
      purpose: 'user',
      actor: { kind: 'human', id: 'alice' },
      idempotencyKey: 'turn-1',
    })
    assert.deepEqual(result, { outcome: 'completed', stopReason: 'end_turn' })

    const { rows } = await pool.query<EventRow>(
      'SELECT direction, rpc_kind, method, command_id, envelope, workstream_seq, session_seq FROM product.workstream_events WHERE workstream_id = $1 ORDER BY workstream_seq',
      [workstreamId],
    )

    const methodOf = (row: EventRow) => row.method ?? row.envelope.method
    const initializeRequest = rows.find((r) => r.direction === 'client_to_agent' && r.rpc_kind === 'request' && r.method === 'initialize')
    assert.ok(initializeRequest, 'initialize request journaled')
    const initializeResponse = rows.find(
      (r) => r.direction === 'agent_to_client' && r.rpc_kind === 'response' && r.envelope.result?.protocolVersion === 1,
    )
    assert.ok(initializeResponse, 'initialize response journaled')

    const sessionNewRequest = rows.find((r) => r.method === 'session/new')
    assert.ok(sessionNewRequest, 'session/new request journaled')
    const sessionNewResponse = rows.find(
      (r) => r.direction === 'agent_to_client' && r.rpc_kind === 'response' && r.envelope.result?.sessionId === 'acp-golden',
    )
    assert.ok(sessionNewResponse, 'session/new response journaled')

    const promptRequest = rows.find((r) => r.method === 'session/prompt')
    assert.ok(promptRequest, 'session/prompt request journaled')
    // required: outbound prompt correlates to the durable PromptSession command.
    assert.ok(promptRequest.command_id, 'the outbound prompt carries its durable command id')

    const updates = rows.filter((r) => methodOf(r) === 'session/update')
    assert.equal(updates.length, 3)
    // required: correlate updates to one in-flight prompt command — every inbound update this
    // turn produced carries the SAME command id as the outbound session/prompt that triggered it.
    for (const update of updates) assert.equal(update.command_id, promptRequest.command_id)
    // required: multiple message/tool chunks preserve order and IDs.
    assert.ok(updates[0]!.workstream_seq < updates[1]!.workstream_seq)
    assert.ok(updates[1]!.workstream_seq < updates[2]!.workstream_seq)
    assert.ok(updates[0]!.session_seq < updates[1]!.session_seq)
    assert.equal(updates[0]!.envelope.params?.update?.messageId, 'message-1')
    assert.equal(updates[1]!.envelope.params?.update?.messageId, 'message-1')
    assert.equal(updates[2]!.envelope.params?.update?.sessionUpdate, 'tool_call')
    assert.equal(updates[2]!.envelope.params?.update?.toolCallId, 'tool-call-1')

    // required: unknown/vendor _meta survives database and readback, verbatim, on both the
    // inbound update and the outbound-triggering response.
    assert.equal(updates[0]!.envelope.params?.update?.content?._meta?.['vendor/content'], 'preserved')

    const promptResponseRow = rows.find(
      (r) => r.direction === 'agent_to_client' && r.rpc_kind === 'response' && r.envelope.result?.stopReason === 'end_turn',
    )
    assert.ok(promptResponseRow)
    assert.equal((promptResponseRow!.envelope.result as { _meta: Record<string, unknown> })._meta['vendor/response'], 'preserved')

    // response rows never carry a method (DB CHECK: rpc_kind='response' requires method IS NULL).
    for (const row of rows) {
      if (row.rpc_kind === 'response') assert.equal(row.method, null)
    }

    const { rows: sessionRows } = await pool.query('SELECT acp_session_id, phase FROM product.sessions WHERE id = $1', [sessionId])
    assert.equal(sessionRows[0].acp_session_id, 'acp-golden')
    assert.equal(sessionRows[0].phase, 'ready')

    agentConnection.close()
    bootstrap.connection.close()
  })
})
