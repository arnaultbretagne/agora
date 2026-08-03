import assert from 'node:assert/strict'
import { test } from 'node:test'
import { principalId, workstreamId } from '@agora/domain'
import { getAnchor, listRetentionCandidates, upsertAnchor } from '../src/anchors.js'
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

async function seedAnchorable(pool: import('pg').Pool) {
  const client = await pool.connect()
  try {
    const wsId = workstreamId(randomId())
    const sessionId = randomId()
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: new Date() },
      session: { id: sessionId as never, ordinal: 1, launchEnvelope: launchEnvelope() },
      runtimeDefinitionVersion: 'v3',
    })
    // Advance the Workstream head to 3 so a watermark of up to 3 is legal.
    for (let i = 0; i < 3; i += 1) {
      await appendEvent(client, {
        eventId: randomId(),
        workstreamId: wsId,
        sessionId,
        direction: 'agent_to_client',
        rpcKind: 'notification',
        method: 'session/update',
        envelope: JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }),
        purpose: 'protocol',
        ingestMode: 'live',
        observedAt: new Date(),
      })
    }
    const snapshotId = randomId()
    await client.query(
      `INSERT INTO custody.snapshots
         (id, session_id, generation, capture_request_id, format_id, format_version, adapter_version,
          synced_through_seq, payload, payload_sha256, size_bytes, created_at)
       VALUES ($1,$2,1,$3,'claude-code-fs','1','1',3,$4,$5,$6,$7)`,
      [snapshotId, sessionId, randomId(), Buffer.from('hi'), Buffer.alloc(32, 1), 2, new Date()],
    )
    return { workstreamId: wsId as string, sessionId, snapshotId }
  } finally {
    client.release()
  }
}

test('anchor upsert succeeds at a watermark within the Workstream head', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId, snapshotId } = await seedAnchorable(pool)
    const client = await pool.connect()
    try {
      await upsertAnchor(client, {
        workstreamId: wsId,
        agentId: 'claude-code',
        sessionId,
        custodySnapshotId: snapshotId,
        syncedThroughSeq: 3,
        updatedAt: new Date(),
      })
      const anchor = await getAnchor(client, wsId, 'claude-code')
      assert.equal(anchor?.syncedThroughSeq, 3)
    } finally {
      client.release()
    }
  })
})

test('required: an anchor watermark cannot decrease', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId, snapshotId } = await seedAnchorable(pool)
    const client = await pool.connect()
    try {
      await upsertAnchor(client, {
        workstreamId: wsId,
        agentId: 'claude-code',
        sessionId,
        custodySnapshotId: snapshotId,
        syncedThroughSeq: 3,
        updatedAt: new Date(),
      })
      await assert.rejects(
        () =>
          upsertAnchor(client, {
            workstreamId: wsId,
            agentId: 'claude-code',
            sessionId,
            custodySnapshotId: snapshotId,
            syncedThroughSeq: 1,
            updatedAt: new Date(),
          }),
        /anchor watermark cannot decrease/,
      )
    } finally {
      client.release()
    }
  })
})

test('required: an anchor watermark cannot exceed the Workstream head (mismatched snapshot watermark)', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId, snapshotId } = await seedAnchorable(pool)
    const client = await pool.connect()
    try {
      await assert.rejects(
        () =>
          upsertAnchor(client, {
            workstreamId: wsId,
            agentId: 'claude-code',
            sessionId,
            custodySnapshotId: snapshotId,
            syncedThroughSeq: 999,
            updatedAt: new Date(),
          }),
        /anchor watermark exceeds Workstream head/,
      )
    } finally {
      client.release()
    }
  })
})

test('required: an anchor watermark that does not match the referenced snapshot is rejected (distinct from exceeding the Workstream head)', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId, snapshotId } = await seedAnchorable(pool)
    const client = await pool.connect()
    try {
      // The seeded snapshot's own synced_through_seq is 3; seq 2 is within the Workstream head
      // (3) but does not match the snapshot's own watermark — the composite FK must reject it.
      await assert.rejects(() =>
        upsertAnchor(client, {
          workstreamId: wsId,
          agentId: 'claude-code',
          sessionId,
          custodySnapshotId: snapshotId,
          syncedThroughSeq: 2,
          updatedAt: new Date(),
        }),
      )
    } finally {
      client.release()
    }
  })
})

test('listRetentionCandidates finds an older, un-anchored snapshot but not the anchored/newest one', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedAnchorable(pool)
    const client = await pool.connect()
    try {
      const old = new Date('2020-01-01T00:00:00Z')
      const oldSnapshotId = randomId()
      await client.query(
        `INSERT INTO custody.snapshots
           (id, session_id, generation, capture_request_id, format_id, format_version, adapter_version,
            synced_through_seq, payload, payload_sha256, size_bytes, created_at)
         VALUES ($1,$2,2,$3,'claude-code-fs','1','1',1,$4,$5,3,$6)`,
        [oldSnapshotId, sessionId, randomId(), Buffer.from('abc'), Buffer.alloc(32, 4), old],
      )
      const newestSnapshotId = randomId()
      await client.query(
        `INSERT INTO custody.snapshots
           (id, session_id, generation, capture_request_id, format_id, format_version, adapter_version,
            synced_through_seq, payload, payload_sha256, size_bytes, created_at)
         VALUES ($1,$2,3,$3,'claude-code-fs','1','1',3,$4,$5,3,$6)`,
        [newestSnapshotId, sessionId, randomId(), Buffer.from('xyz'), Buffer.alloc(32, 5), old],
      )

      const candidates = await listRetentionCandidates(client, new Date('2026-01-01T00:00:00Z'))
      const candidateIds = candidates.map((c) => c.snapshotId)
      assert.ok(candidateIds.includes(oldSnapshotId))
      assert.equal(candidateIds.includes(newestSnapshotId), false) // newest generation is retained

      await upsertAnchor(client, {
        workstreamId: wsId,
        agentId: 'claude-code',
        sessionId,
        custodySnapshotId: oldSnapshotId,
        syncedThroughSeq: 1,
        updatedAt: new Date(),
      })
      const afterAnchoring = await listRetentionCandidates(client, new Date('2026-01-01T00:00:00Z'))
      assert.equal(afterAnchoring.map((c) => c.snapshotId).includes(oldSnapshotId), false) // now anchored, retained
    } finally {
      client.release()
    }
  })
})
