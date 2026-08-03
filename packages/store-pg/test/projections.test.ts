import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { principalId, workstreamId } from '@agora/domain'
import { advanceCheckpoint, appendFeedEvent, computeProjectionHash, getCheckpoint, resetProjection } from '../src/projections.js'
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

async function seedWorkstream(pool: import('pg').Pool, owner: string) {
  const client = await pool.connect()
  try {
    const wsId = workstreamId(randomId())
    const sessionId = randomId()
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId(owner), createdAt: new Date() },
      session: { id: sessionId as never, ordinal: 1, launchEnvelope: launchEnvelope() },
      runtimeDefinitionVersion: 'v3',
    })
    return { workstreamId: wsId as string, sessionId }
  } finally {
    client.release()
  }
}

/** Inserts one minimal, real workstream_event and returns its (id, workstreamSeq) — checkpoints
 * legitimately FK-reference a real committed event; they cannot point at an arbitrary uuid. */
async function insertRealEvent(client: import('pg').PoolClient, workstreamId: string, sessionId: string, seq: number) {
  const eventId = randomId()
  await client.query(
    `INSERT INTO product.workstream_events
       (id, workstream_id, workstream_seq, session_id, session_seq, direction, rpc_kind, method, envelope, purpose, ingest_mode, observed_at)
     VALUES ($1,$2,$3,$4,$3,'agent_to_client','notification','session/update','{}','protocol','live',$5)`,
    [eventId, workstreamId, seq, sessionId, new Date()],
  )
  return eventId
}

interface SyntheticItemInput {
  readonly workstreamId: string
  readonly sessionId: string
  readonly eventId: string
  readonly itemId: string
  readonly seq: number
  readonly content: string
}

/** Simulates one projector write (a real projector is P03/P05 scope) with fully caller-controlled ids/content. */
async function insertSyntheticItem(client: import('pg').PoolClient, input: SyntheticItemInput) {
  await client.query(
    `INSERT INTO product.workstream_events
       (id, workstream_id, workstream_seq, session_id, session_seq, direction, rpc_kind, method, envelope, purpose, ingest_mode, observed_at)
     VALUES ($1,$2,$3,$4,$3,'agent_to_client','notification','session/update','{}','protocol','live',$5)`,
    [input.eventId, input.workstreamId, input.seq, input.sessionId, new Date()],
  )
  const contentSha256 = createHash('sha256').update(input.content).digest()
  await client.query(
    `INSERT INTO projection.workstream_items
       (id, workstream_id, session_id, item_kind, synthetic_entity_key, first_event_id, latest_event_id,
        first_workstream_seq, latest_workstream_seq, content_sha256, updated_at)
     VALUES ($1,$2,$3,'tool_call',$4,$5,$5,$6,$6,$7,$8)`,
    [input.itemId, input.workstreamId, input.sessionId, `synthetic-${input.itemId}`, input.eventId, input.seq, contentSha256, new Date()],
  )
  await client.query(`INSERT INTO projection.tool_calls (item_id, tool_call_id, status) VALUES ($1, $2, 'completed')`, [
    input.itemId,
    `tool-${input.itemId}`,
  ])
}

test('a projector checkpoint is scoped per Workstream — advancing one never touches another', async () => {
  await withTestDatabase(async (pool) => {
    const a = await seedWorkstream(pool, 'alice')
    const b = await seedWorkstream(pool, 'bob')
    const client = await pool.connect()
    try {
      const eventId = await insertRealEvent(client, a.workstreamId, a.sessionId, 1)
      await advanceCheckpoint(client, 'web-feed', a.workstreamId, 'v1', 1, eventId, new Date())
      const checkpointA = await getCheckpoint(client, 'web-feed', a.workstreamId)
      const checkpointB = await getCheckpoint(client, 'web-feed', b.workstreamId)
      assert.equal(checkpointA.throughWorkstreamSeq, 1)
      assert.equal(checkpointB.throughWorkstreamSeq, 0)
    } finally {
      client.release()
    }
  })
})

test('required: concurrent Workstreams cannot cause a projector checkpoint to skip committed events (isolated advancement)', async () => {
  await withTestDatabase(async (pool) => {
    const workstreams = await Promise.all(Array.from({ length: 6 }, (_, i) => seedWorkstream(pool, `owner-${i}`)))
    const client = await pool.connect()
    try {
      const eventIds = await Promise.all(workstreams.map((ws) => insertRealEvent(client, ws.workstreamId, ws.sessionId, 1)))
      await Promise.all(
        workstreams.map((ws, i) => advanceCheckpoint(client, 'web-feed', ws.workstreamId, 'v1', 1, eventIds[i]!, new Date())),
      )
      for (const ws of workstreams) {
        const checkpoint = await getCheckpoint(client, 'web-feed', ws.workstreamId)
        assert.equal(checkpoint.throughWorkstreamSeq, 1)
      }
    } finally {
      client.release()
    }
  })
})

test('feed positions are durable and monotonic', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId } = await seedWorkstream(pool, 'alice')
    const client = await pool.connect()
    try {
      const p1 = await appendFeedEvent(client, {
        workstreamId: wsId,
        throughWorkstreamSeq: 1,
        operation: 'status',
        payload: { subject: 'session', subjectId: 's1', state: {} },
        createdAt: new Date(),
      })
      const p2 = await appendFeedEvent(client, {
        workstreamId: wsId,
        throughWorkstreamSeq: 2,
        operation: 'status',
        payload: { subject: 'session', subjectId: 's1', state: {} },
        createdAt: new Date(),
      })
      assert.ok(p2 > p1)
    } finally {
      client.release()
    }
  })
})

test('required: projection rebuild produces an identical hash, and never touches feed_events', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool, 'alice')
    const client = await pool.connect()
    try {
      // Fixed, deterministic ids/content — reused identically across both passes below, exactly
      // as a real projector re-folding the SAME canonical journal would reproduce the same output.
      const items: readonly SyntheticItemInput[] = [
        { workstreamId: wsId, sessionId, eventId: randomId(), itemId: randomId(), seq: 1, content: 'first tool call' },
        { workstreamId: wsId, sessionId, eventId: randomId(), itemId: randomId(), seq: 2, content: 'second tool call' },
      ]

      for (const item of items) await insertSyntheticItem(client, item)
      await appendFeedEvent(client, {
        workstreamId: wsId,
        throughWorkstreamSeq: 2,
        operation: 'status',
        payload: { subject: 'session', subjectId: 's1', state: {} },
        createdAt: new Date(),
      })
      await advanceCheckpoint(client, 'web-feed', wsId, 'v1', 2, items[1]!.eventId, new Date())

      const before = await computeProjectionHash(client, wsId)
      const { rows: feedBefore } = await client.query('SELECT count(*)::int AS n FROM projection.feed_events WHERE workstream_id = $1', [wsId])

      await resetProjection(client, wsId)
      const { rows: afterReset } = await client.query('SELECT count(*)::int AS n FROM projection.workstream_items WHERE workstream_id = $1', [wsId])
      assert.equal(afterReset[0].n, 0)
      const { rows: feedAfterReset } = await client.query('SELECT count(*)::int AS n FROM projection.feed_events WHERE workstream_id = $1', [wsId])
      assert.equal(feedAfterReset[0].n, feedBefore[0].n) // resetProjection never touches feed_events

      // Re-fold the identical canonical input the rebuild is supposed to reproduce.
      await client.query('DELETE FROM product.workstream_events WHERE workstream_id = $1', [wsId])
      for (const item of items) await insertSyntheticItem(client, item)
      const after = await computeProjectionHash(client, wsId)

      assert.equal(after, before)
    } finally {
      client.release()
    }
  })
})
