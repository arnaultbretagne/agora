import assert from 'node:assert/strict'
import { test } from 'node:test'
import { principalId, workstreamId } from '@agora/domain'
import { appendEvent } from '../src/journal.js'
import { createWorkstreamWithFirstSession } from '../src/workstreams.js'
import { randomId, withTestDatabase } from './support.js'

function launchEnvelope() {
  return {
    agentId: 'claude-code',
    workspaceSpec: { root: '/work' },
    equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
    runtimeDefinitionVersion: 'v3',
  }
}

async function seedWorkstream(pool: import('pg').Pool) {
  const client = await pool.connect()
  try {
    const wsId = workstreamId(randomId())
    const sessionId = randomId()
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: new Date() },
      session: { id: sessionId as never, ordinal: 1, launchEnvelope: launchEnvelope() },
      runtimeDefinitionVersion: 'v3',
    })
    return { workstreamId: wsId as string, sessionId }
  } finally {
    client.release()
  }
}

test('appendEvent allocates the dual sequence starting at 1', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      const result = await appendEvent(client, {
        eventId: randomId(),
        workstreamId: wsId,
        sessionId,
        direction: 'client_to_agent',
        rpcKind: 'request',
        method: 'session/prompt',
        rpcId: 'req-1',
        envelope: { jsonrpc: '2.0', id: 'req-1', method: 'session/prompt', params: {} },
        purpose: 'user',
        ingestMode: 'live',
        observedAt: new Date(),
      })
      assert.deepEqual(result, { workstreamSeq: 1, sessionSeq: 1 })
    } finally {
      client.release()
    }
  })
})

test('required: concurrent appends to the same Workstream/Session yield gap-free unique positions', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const CONCURRENCY = 12
    const clients = await Promise.all(Array.from({ length: CONCURRENCY }, () => pool.connect()))
    try {
      const results = await Promise.all(
        clients.map((client, i) =>
          appendEvent(client, {
            eventId: randomId(),
            workstreamId: wsId,
            sessionId,
            direction: 'client_to_agent',
            rpcKind: 'notification',
            method: 'session/cancel',
            envelope: { jsonrpc: '2.0', method: 'session/cancel', params: { n: i } },
            purpose: 'protocol',
            ingestMode: 'live',
            observedAt: new Date(),
          }),
        ),
      )
      const workstreamSeqs = results.map((r) => r.workstreamSeq).sort((a, b) => a - b)
      const sessionSeqs = results.map((r) => r.sessionSeq).sort((a, b) => a - b)
      const expected = Array.from({ length: CONCURRENCY }, (_, i) => i + 1)
      assert.deepEqual(workstreamSeqs, expected)
      assert.deepEqual(sessionSeqs, expected)
    } finally {
      for (const client of clients) client.release()
    }
  })
})

test('required: a rolled-back append leaves no event/journal-outbox split and does not advance last_event_seq', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      // rpc_kind 'response' requires method IS NULL — passing a method violates the CHECK constraint.
      await assert.rejects(() =>
        appendEvent(client, {
          eventId: randomId(),
          workstreamId: wsId,
          sessionId,
          direction: 'agent_to_client',
          rpcKind: 'response',
          method: 'session/prompt',
          envelope: { jsonrpc: '2.0', id: 'req-1', result: {} },
          purpose: 'protocol',
          ingestMode: 'live',
          observedAt: new Date(),
        }),
      )

      const { rows: wsRows } = await client.query('SELECT last_event_seq FROM product.workstreams WHERE id = $1', [wsId])
      assert.equal(wsRows[0].last_event_seq, 0)
      const { rows: eventRows } = await client.query('SELECT * FROM product.workstream_events WHERE workstream_id = $1', [wsId])
      assert.equal(eventRows.length, 0)
      const { rows: outboxRows } = await client.query('SELECT * FROM product.journal_outbox WHERE workstream_id = $1', [wsId])
      assert.equal(outboxRows.length, 0)
    } finally {
      client.release()
    }
  })
})
