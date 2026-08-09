import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureSnapshot, invalidateSnapshot, restoreSnapshot } from '../src/payload.js'
import { getLatestSnapshotMetadata, listSnapshotMetadata } from '../src/metadata.js'
import { randomId, seedSession, withTestDatabase } from './support.js'

test('captureSnapshot is idempotent by (session, captureRequestId)', async () => {
  await withTestDatabase(async (pool) => {
    const sessionId = await seedSession(pool)
    const client = await pool.connect()
    try {
      const captureRequestId = randomId()
      const input = {
        snapshotId: randomId(),
        sessionId,
        generation: 1,
        captureRequestId,
        formatId: 'claude-code-fs',
        formatVersion: '1',
        adapterVersion: '2026.08.01',
        syncedThroughSeq: 5,
        payload: new TextEncoder().encode('harness state bytes'),
        createdAt: new Date(),
      }
      const first = await captureSnapshot(client, input)
      const retry = await captureSnapshot(client, { ...input, snapshotId: randomId() }) // different id, same captureRequestId
      assert.equal(first.snapshotId, retry.snapshotId)

      const { rows } = await client.query('SELECT count(*)::int AS n FROM custody.snapshots WHERE session_id = $1', [sessionId])
      assert.equal(rows[0].n, 1)
    } finally {
      client.release()
    }
  })
})

test('restoreSnapshot returns the exact payload and verifies its checksum', async () => {
  await withTestDatabase(async (pool) => {
    const sessionId = await seedSession(pool)
    const client = await pool.connect()
    try {
      const payload = new TextEncoder().encode('harness state bytes, round two')
      const { snapshotId } = await captureSnapshot(client, {
        snapshotId: randomId(),
        sessionId,
        generation: 1,
        captureRequestId: randomId(),
        formatId: 'claude-code-fs',
        formatVersion: '1',
        adapterVersion: '2026.08.01',
        syncedThroughSeq: 5,
        payload,
        createdAt: new Date(),
      })
      const restored = await restoreSnapshot(client, snapshotId)
      assert.deepEqual(Buffer.from(restored.payload), Buffer.from(payload))
    } finally {
      client.release()
    }
  })
})

test('restoreSnapshot detects a corrupted payload (checksum mismatch)', async () => {
  await withTestDatabase(async (pool) => {
    const sessionId = await seedSession(pool)
    const client = await pool.connect()
    try {
      const { snapshotId } = await captureSnapshot(client, {
        snapshotId: randomId(),
        sessionId,
        generation: 1,
        captureRequestId: randomId(),
        formatId: 'claude-code-fs',
        formatVersion: '1',
        adapterVersion: '2026.08.01',
        syncedThroughSeq: 5,
        payload: new TextEncoder().encode('original bytes'),
        createdAt: new Date(),
      })
      // Simulate bit-rot at rest — same length (so size_bytes still matches) but different bytes,
      // bypassing the repository (which never lets this happen via its own API).
      await client.query('UPDATE custody.snapshots SET payload = $2 WHERE id = $1', [snapshotId, Buffer.from('original-bytes')])
      await assert.rejects(() => restoreSnapshot(client, snapshotId), /checksum mismatch/)
    } finally {
      client.release()
    }
  })
})

test('metadata repository never carries the payload field, even in its type', async () => {
  await withTestDatabase(async (pool) => {
    const sessionId = await seedSession(pool)
    const client = await pool.connect()
    try {
      await captureSnapshot(client, {
        snapshotId: randomId(),
        sessionId,
        generation: 1,
        captureRequestId: randomId(),
        formatId: 'claude-code-fs',
        formatVersion: '1',
        adapterVersion: '2026.08.01',
        syncedThroughSeq: 5,
        payload: new TextEncoder().encode('bytes'),
        createdAt: new Date(),
      })
      const latest = await getLatestSnapshotMetadata(client, sessionId)
      assert.ok(latest)
      assert.equal('payload' in (latest as object), false)
      const all = await listSnapshotMetadata(client, sessionId)
      assert.equal(all.length, 1)
    } finally {
      client.release()
    }
  })
})

test('invalidateSnapshot excludes it from getLatestSnapshotMetadata', async () => {
  await withTestDatabase(async (pool) => {
    const sessionId = await seedSession(pool)
    const client = await pool.connect()
    try {
      const { snapshotId } = await captureSnapshot(client, {
        snapshotId: randomId(),
        sessionId,
        generation: 1,
        captureRequestId: randomId(),
        formatId: 'claude-code-fs',
        formatVersion: '1',
        adapterVersion: '2026.08.01',
        syncedThroughSeq: 5,
        payload: new TextEncoder().encode('bytes'),
        createdAt: new Date(),
      })
      await invalidateSnapshot(client, snapshotId, 'restore_collision', new Date())
      const latest = await getLatestSnapshotMetadata(client, sessionId)
      assert.equal(latest, undefined)
      const all = await listSnapshotMetadata(client, sessionId)
      assert.equal(all.length, 1)
      assert.equal(all[0]!.invalidationReason, 'restore_collision')
    } finally {
      client.release()
    }
  })
})
