import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { principalId, workstreamId } from '@agora/domain'
import { buildHandoffContent, HandoffNotReadyError, HANDOFF_SEED_POLICY_VERSION } from '../src/handoff-builder.js'
import { createOrReuseCommand } from '../src/commands.js'
import { appendEvent, type AppendEventInput } from '../src/journal.js'
import { projectWorkstream } from '../src/projector.js'
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

async function openTurn(pool: pg.Pool, wsId: string, sessionId: string, idempotencyKey: string) {
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

/** Turn: user message -> agent message -> agent thought -> tool call. Returns the final seq. */
async function seedTurn(pool: pg.Pool, wsId: string, sessionId: string, key: string, options: { thoughtText?: string } = {}) {
  const turnId = await openTurn(pool, wsId, sessionId, key)
  await append(pool, {
    workstreamId: wsId,
    sessionId,
    direction: 'client_to_agent',
    rpcKind: 'request',
    method: 'session/prompt',
    rpcId: `req-${key}`,
    envelope: envelope({ id: `req-${key}`, method: 'session/prompt', params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'hi' }] } }),
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
      params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `reply-${key}` } } },
    }),
    commandId: turnId,
    purpose: 'user',
    ingestMode: 'live',
  })
  if (options.thoughtText) {
    await append(pool, {
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'notification',
      method: 'session/update',
      envelope: envelope({
        method: 'session/update',
        params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: options.thoughtText } } },
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
    rpcKind: 'notification',
    method: 'session/update',
    envelope: envelope({
      method: 'session/update',
      params: {
        sessionId: 'acp-1',
        update: { sessionUpdate: 'tool_call', toolCallId: `tool-${key}`, title: `Tool ${key}`, status: 'completed', content: [{ type: 'text', text: `output-${key}` }] },
      },
    }),
    commandId: turnId,
    purpose: 'user',
    ingestMode: 'live',
  })
  const last = await append(pool, {
    workstreamId: wsId,
    sessionId,
    direction: 'agent_to_client',
    rpcKind: 'response',
    rpcId: `req-${key}`,
    envelope: envelope({ id: `req-${key}`, result: { stopReason: 'end_turn' } }),
    purpose: 'user',
    ingestMode: 'live',
  })
  return last.workstreamSeq
}

async function project(pool: pg.Pool, wsId: string) {
  const client = await pool.connect()
  try {
    await projectWorkstream(client, wsId, new Date())
  } finally {
    client.release()
  }
}

test('required: builds deterministic content for an exact source range, including messages/thoughts/tool calls', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    await seedTurn(pool, wsId, sessionId, 'k1', { thoughtText: 'thinking about k1' })
    const throughSeq = await seedTurn(pool, wsId, sessionId, 'k2', { thoughtText: 'thinking about k2' })
    await project(pool, wsId)

    const client = await pool.connect()
    try {
      const built = await buildHandoffContent(client, { workstreamId: wsId, commandId: randomId(), sourceFromSeq: 0, sourceThroughSeq: throughSeq })
      assert.equal(built.fidelity, 'complete')
      assert.ok(built.text.includes('reply-k1'))
      assert.ok(built.text.includes('reply-k2'))
      assert.ok(built.text.includes('thinking about k1'))
      assert.ok(built.text.includes('Tool k1'))
      assert.ok(built.text.includes(`# Source range: (0, ${throughSeq}]`))
      assert.equal(built.sizeBytes, Buffer.byteLength(built.text, 'utf8'))
    } finally {
      client.release()
    }
  })
})

test('required: repeating the same range regenerates byte-identical content and digest', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const throughSeq = await seedTurn(pool, wsId, sessionId, 'k1', { thoughtText: 'stable thought' })
    await project(pool, wsId)

    const client = await pool.connect()
    try {
      const first = await buildHandoffContent(client, { workstreamId: wsId, commandId: 'cmd-fixed', sourceFromSeq: 0, sourceThroughSeq: throughSeq })
      const second = await buildHandoffContent(client, { workstreamId: wsId, commandId: 'cmd-fixed', sourceFromSeq: 0, sourceThroughSeq: throughSeq })
      assert.equal(first.text, second.text)
      assert.deepEqual(Buffer.from(first.sha256), Buffer.from(second.sha256))
    } finally {
      client.release()
    }
  })
})

test('required: an item outside the source range is excluded — exact (from, through] semantics', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const boundary = await seedTurn(pool, wsId, sessionId, 'before')
    const throughSeq = await seedTurn(pool, wsId, sessionId, 'inside')
    await seedTurn(pool, wsId, sessionId, 'after')
    await project(pool, wsId)

    const client = await pool.connect()
    try {
      const built = await buildHandoffContent(client, { workstreamId: wsId, commandId: randomId(), sourceFromSeq: boundary, sourceThroughSeq: throughSeq })
      assert.equal(built.text.includes('reply-before'), false, 'items at/before the exclusive lower bound must be excluded')
      assert.ok(built.text.includes('reply-inside'))
      assert.equal(built.text.includes('reply-after'), false, 'items after the inclusive upper bound must be excluded')
    } finally {
      client.release()
    }
  })
})

test('required: an oversized thought is truncated on a Unicode boundary with a recorded marker', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    // Individual thought cap is 8 KiB — force well past it, including a multi-byte character near the cut.
    const longThought = `${'x'.repeat(8 * 1024)}é${'y'.repeat(1024)}`
    const throughSeq = await seedTurn(pool, wsId, sessionId, 'k1', { thoughtText: longThought })
    await project(pool, wsId)

    const client = await pool.connect()
    try {
      const built = await buildHandoffContent(client, { workstreamId: wsId, commandId: randomId(), sourceFromSeq: 0, sourceThroughSeq: throughSeq })
      assert.ok(built.text.includes('[truncated by handoff-v1'))
      assert.equal(built.text.includes('y'.repeat(1024)), false, 'content past the 8 KiB cap must not appear')
      // The rendered text must itself be valid UTF-8 (Buffer round-trip) — proves the cut landed on a character boundary.
      assert.equal(Buffer.from(built.text, 'utf8').toString('utf8'), built.text)
    } finally {
      client.release()
    }
  })
})

test('required: throws HandoffNotReadyError when the projector has not caught up to the source range', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const throughSeq = await seedTurn(pool, wsId, sessionId, 'k1')
    // Deliberately NOT projecting — the checkpoint stays at 0.

    const client = await pool.connect()
    try {
      await assert.rejects(
        () => buildHandoffContent(client, { workstreamId: wsId, commandId: randomId(), sourceFromSeq: 0, sourceThroughSeq: throughSeq }),
        (error: unknown) => error instanceof HandoffNotReadyError,
      )
    } finally {
      client.release()
    }
  })
})

test(`policy version is the stable constant ${HANDOFF_SEED_POLICY_VERSION}`, () => {
  assert.equal(HANDOFF_SEED_POLICY_VERSION, 'handoff-v1')
})
