import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { principalId, workstreamId } from '@agora/domain'
import { createOrReuseCommand } from '../src/commands.js'
import { appendEvent, type AppendEventInput } from '../src/journal.js'
import { computeProjectionHash, resetProjection } from '../src/projections.js'
import { projectWorkstream, readWorkstreamItem, readWorkstreamTurn } from '../src/projector.js'
import { createWorkstreamWithFirstSession } from '../src/workstreams.js'
import { randomId, withTestDatabase } from './support.js'

function launchEnvelope() {
  return {
    agentId: 'fake-agent',
    workspaceSpec: { root: '/work' },
    equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
    runtimeDefinitionVersion: 'v1',
  }
}

async function seedWorkstream(pool: pg.Pool) {
  const client = await pool.connect()
  try {
    const wsId = workstreamId(randomId())
    const sessionId = randomId()
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: new Date() },
      session: { id: sessionId as never, ordinal: 1, launchEnvelope: launchEnvelope() },
      runtimeDefinitionVersion: 'v1',
    })
    return { workstreamId: wsId as string, sessionId }
  } finally {
    client.release()
  }
}

async function openTurnCommand(pool: pg.Pool, wsId: string, sessionId: string, idempotencyKey: string) {
  const client = await pool.connect()
  try {
    const command = await createOrReuseCommand(client, {
      type: 'PromptSession',
      workstreamId: wsId as never,
      sessionId: sessionId as never,
      actor: { kind: 'human', id: 'alice' as never },
      idempotencyScope: 'prompt',
      idempotencyKey,
      purpose: 'user',
      acceptedAt: new Date(),
      request: { prompt: [] },
    })
    return command.id as string
  } finally {
    client.release()
  }
}

function envelope(body: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', ...body })
}

async function append(pool: pg.Pool, input: Omit<AppendEventInput, 'eventId' | 'observedAt'>) {
  const client = await pool.connect()
  try {
    return await appendEvent(client, { ...input, eventId: randomId(), observedAt: new Date() })
  } finally {
    client.release()
  }
}

async function runProjector(pool: pg.Pool, wsId: string) {
  const client = await pool.connect()
  try {
    return await projectWorkstream(client, wsId, new Date())
  } finally {
    client.release()
  }
}

test('required: chunk/upsert sequences produce deterministic UI items', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const turnId = await openTurnCommand(pool, wsId, sessionId, 'k1')

    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'client_to_agent',
      rpcKind: 'request',
      method: 'session/prompt',
      rpcId: 'req-1',
      envelope: envelope({ id: 'req-1', method: 'session/prompt', params: { sessionId: 'acp-1', prompt: [] } }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })
    for (const text of ['Hello', ', ', 'world']) {
      await append(pool, {
        workstreamId: wsId,
        sessionId,
        direction: 'agent_to_client',
        rpcKind: 'notification',
        method: 'session/update',
        envelope: envelope({
          method: 'session/update',
          params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
        }),
        commandId: turnId,
        purpose: 'user',
        ingestMode: 'live',
      })
    }
    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'response',
      rpcId: 'req-1',
      envelope: envelope({ id: 'req-1', result: { stopReason: 'end_turn' } }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })

    const result = await runProjector(pool, wsId)
    assert.equal(result.processed, 5)

    const client = await pool.connect()
    try {
      const { rows } = await client.query(
        `SELECT id FROM projection.workstream_items WHERE workstream_id = $1 AND item_kind = 'message'`,
        [wsId],
      )
      assert.equal(rows.length, 1, 'all three chunks with no messageId collapse into one synthetic-key item')
      const item = await readWorkstreamItem(client, rows[0].id)
      assert.equal(item?.value['chunkCount'], 3)
      assert.deepEqual(
        (item?.value['content'] as { text: string }[]).map((c) => c.text),
        ['Hello', ', ', 'world'],
      )
      assert.equal(item?.value['completed'], true, 'completes once its turn closes')

      // Rerunning the projector on the same data must not duplicate or change anything (idempotent by checkpoint).
      const second = await runProjector(pool, wsId)
      assert.equal(second.processed, 0)
      const stillOne = await client.query(`SELECT id FROM projection.workstream_items WHERE workstream_id = $1 AND item_kind = 'message'`, [wsId])
      assert.equal(stillOne.rows.length, 1)
    } finally {
      client.release()
    }
  })
})

test('required: turn rows converge to the exact PromptResponse stop reason and final usage', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const turnId = await openTurnCommand(pool, wsId, sessionId, 'k1')

    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'client_to_agent',
      rpcKind: 'request',
      method: 'session/prompt',
      rpcId: 'req-1',
      envelope: envelope({ id: 'req-1', method: 'session/prompt', params: {} }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })
    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'response',
      rpcId: 'req-1',
      envelope: envelope({
        id: 'req-1',
        result: { stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
      }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })

    await runProjector(pool, wsId)
    const client = await pool.connect()
    try {
      const turn = await readWorkstreamTurn(client, turnId)
      assert.equal(turn?.status, 'completed')
      assert.equal(turn?.stopReason, 'max_tokens')
      assert.deepEqual(turn?.usage, {
        inputTokens: 10,
        outputTokens: 20,
        cachedReadTokens: null,
        cachedWriteTokens: null,
        thoughtTokens: null,
        totalTokens: 30,
      })
    } finally {
      client.release()
    }
  })
})

test('required: tool-call updates remain visible before/after cancel', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const turnId = await openTurnCommand(pool, wsId, sessionId, 'k1')

    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'client_to_agent',
      rpcKind: 'request',
      method: 'session/prompt',
      rpcId: 'req-1',
      envelope: envelope({ id: 'req-1', method: 'session/prompt', params: {} }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })
    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'notification',
      method: 'session/update',
      envelope: envelope({
        method: 'session/update',
        params: { sessionId: 'acp-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Reading file', status: 'pending', kind: 'read' } },
      }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })
    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'client_to_agent',
      rpcKind: 'notification',
      method: 'session/cancel',
      envelope: envelope({ method: 'session/cancel', params: { sessionId: 'acp-1' } }),
      purpose: 'protocol',
      ingestMode: 'live',
    })
    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'notification',
      method: 'session/update',
      envelope: envelope({
        method: 'session/update',
        params: { sessionId: 'acp-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'cancelled' } },
      }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })

    await runProjector(pool, wsId)
    const client = await pool.connect()
    try {
      const { rows } = await client.query(`SELECT id FROM projection.workstream_items WHERE workstream_id = $1 AND item_kind = 'tool_call'`, [wsId])
      assert.equal(rows.length, 1, 'tool_call_update merges into the SAME item, never a second one')
      const item = await readWorkstreamItem(client, rows[0].id)
      assert.equal(item?.value['title'], 'Reading file', 'fields not present in the update are preserved')
      assert.equal(item?.value['status'], 'cancelled', 'the update is applied and visible after cancel')
    } finally {
      client.release()
    }
  })
})

test('required: thoughts and permission decisions are inspectable', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const turnId = await openTurnCommand(pool, wsId, sessionId, 'k1')

    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'client_to_agent',
      rpcKind: 'request',
      method: 'session/prompt',
      rpcId: 'req-1',
      envelope: envelope({ id: 'req-1', method: 'session/prompt', params: {} }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })
    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'notification',
      method: 'session/update',
      envelope: envelope({
        method: 'session/update',
        params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } } },
      }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })
    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'request',
      method: 'session/request_permission',
      rpcId: 'perm-1',
      envelope: envelope({
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'acp-1',
          toolCall: { toolCallId: 'tc-1' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })
    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'client_to_agent',
      rpcKind: 'response',
      rpcId: 'perm-1',
      envelope: envelope({ id: 'perm-1', result: { outcome: { outcome: 'selected', optionId: 'allow' } } }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })

    await runProjector(pool, wsId)
    const client = await pool.connect()
    try {
      const { rows: thoughts } = await client.query(`SELECT id FROM projection.workstream_items WHERE workstream_id = $1 AND item_kind = 'thought'`, [wsId])
      assert.equal(thoughts.length, 1)
      const thought = await readWorkstreamItem(client, thoughts[0].id)
      assert.equal(thought?.value['role'], 'thought')
      assert.deepEqual((thought?.value['content'] as { text: string }[])[0], { type: 'text', text: 'thinking...' })

      const { rows: permissions } = await client.query(
        `SELECT id FROM projection.workstream_items WHERE workstream_id = $1 AND item_kind = 'permission'`,
        [wsId],
      )
      assert.equal(permissions.length, 1)
      const permission = await readWorkstreamItem(client, permissions[0].id)
      assert.equal(permission?.value['status'], 'answered')
      assert.equal(permission?.value['outcome'], 'selected')
      assert.equal(permission?.value['selectedOptionId'], 'allow')
    } finally {
      client.release()
    }
  })
})

test('required: an unknown ACP update gets a generic inspectable card', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)

    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'notification',
      method: 'session/update',
      envelope: envelope({
        method: 'session/update',
        params: { sessionId: 'acp-1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } },
      }),
      purpose: 'protocol',
      ingestMode: 'live',
    })

    await runProjector(pool, wsId)
    const client = await pool.connect()
    try {
      const { rows } = await client.query(`SELECT id FROM projection.workstream_items WHERE workstream_id = $1 AND item_kind = 'unknown'`, [wsId])
      assert.equal(rows.length, 1)
      const item = await readWorkstreamItem(client, rows[0].id)
      assert.equal(item?.value['method'], 'session/update')
      assert.ok(item?.value['envelope'], 'the complete envelope stays inspectable, nothing inferred')
    } finally {
      client.release()
    }
  })
})

test('required: projection truncate/rebuild yields identical item hashes', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const turnId = await openTurnCommand(pool, wsId, sessionId, 'k1')

    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'client_to_agent',
      rpcKind: 'request',
      method: 'session/prompt',
      rpcId: 'req-1',
      envelope: envelope({ id: 'req-1', method: 'session/prompt', params: {} }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })
    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'notification',
      method: 'session/update',
      envelope: envelope({
        method: 'session/update',
        params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
      }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })
    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'response',
      rpcId: 'req-1',
      envelope: envelope({ id: 'req-1', result: { stopReason: 'end_turn' } }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })

    await runProjector(pool, wsId)
    const client = await pool.connect()
    let beforeHash: string
    try {
      beforeHash = await computeProjectionHash(client, wsId)
    } finally {
      client.release()
    }

    const resetClient = await pool.connect()
    try {
      await resetProjection(resetClient, wsId)
    } finally {
      resetClient.release()
    }

    await runProjector(pool, wsId)
    const afterClient = await pool.connect()
    try {
      const afterHash = await computeProjectionHash(afterClient, wsId)
      assert.equal(afterHash, beforeHash)
    } finally {
      afterClient.release()
    }
  })
})


/**
 * Found live 2026-08-07: the read model held only the Agent's half of the conversation. Replies
 * rendered with nothing between them, and the only thing a client could do about it was paint local
 * echoes that vanish on refetch — "les bulles s'empilent en bas, sa réponse continue dans un bloc
 * unique". `session/prompt` opened a Turn and dropped its content on the floor.
 */
test('required: a user prompt is projected as a message — a transcript that omits the questions is not a transcript', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const turnId = await openTurnCommand(pool, wsId, sessionId, 'prompt-projection')

    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'client_to_agent',
      rpcKind: 'request',
      method: 'session/prompt',
      rpcId: 'req-1',
      envelope: envelope({
        id: 'req-1',
        method: 'session/prompt',
        params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'ma question' }] },
      }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
    })
    await runProjector(pool, wsId)

    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ role: string; content: { text?: string }[]; turn_id: string | null }>(
        `SELECT m.role, m.content, i.turn_id FROM projection.messages m
           JOIN projection.workstream_items i ON i.id = m.item_id
          WHERE i.workstream_id = $1 AND m.role = 'user'`,
        [wsId],
      )
      assert.equal(rows.length, 1, 'the prompt the user actually sent must be in the read model')
      assert.equal(rows[0]?.content?.[0]?.text, 'ma question')
      assert.equal(rows[0]?.turn_id, turnId, 'and it belongs to the turn it opened, so it orders before the reply')
    } finally {
      client.release()
    }
  })
})

test('a handoff prompt is NOT rendered as something the user typed', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const turnId = await openTurnCommand(pool, wsId, sessionId, 'handoff-projection')

    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'client_to_agent',
      rpcKind: 'request',
      method: 'session/prompt',
      rpcId: 'req-1',
      envelope: envelope({
        id: 'req-1',
        method: 'session/prompt',
        params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'machine-built seed content' }] },
      }),
      commandId: turnId,
      purpose: 'handoff',
      ingestMode: 'live',
    })
    await runProjector(pool, wsId)

    const client = await pool.connect()
    try {
      const { rows } = await client.query(
        `SELECT 1 FROM projection.messages m JOIN projection.workstream_items i ON i.id = m.item_id
          WHERE i.workstream_id = $1 AND m.role = 'user'`,
        [wsId],
      )
      assert.equal(rows.length, 0, 'a handoff carries seed content and has its own item — attributing it to the user would misreport who said it')
    } finally {
      client.release()
    }
  })
})
