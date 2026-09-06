import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type pg from 'pg'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import {
  CaptureKeyConflictError,
  checkCompatibility,
  findSaveByCaptureKey,
  getAnchor,
  invalidate,
  isExcluded,
  publishAnchor,
  readPayload,
  recordSave,
  writePayload,
  type CaptureKey,
  type SaveMetadata,
} from '../src/index.js'

const PRODUCT = 'agora_product'
const PAYLOAD = 'agora_custody_payload'
const META = 'agora_custody_meta'

async function seedWorkstreamAndSession(db: TestDatabase, client: pg.PoolClient): Promise<{ workstreamId: string; sessionId: string }> {
  const workstreamId = randomUUID()
  const sessionId = randomUUID()
  await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [
    workstreamId,
    'owner@example.com',
    'workstream',
    randomUUID(),
  ])
  await db.pool.query(
    `INSERT INTO sessions (id, workstream_id, ordinal, opened_at_seq, cutoff_h, pod_uid, provenance)
     VALUES ($1, $2, 1, 1, 0, 'pod-a', '{}'::jsonb)`,
    [sessionId, workstreamId],
  )
  void client
  return { workstreamId, sessionId }
}

function captureKey(overrides: Partial<CaptureKey> = {}): CaptureKey {
  return { podUid: 'pod-a', processGeneration: 0, contextId: 'ctx-1', frontierW: 7, driverRevision: 'driver-1', ...overrides }
}

function metadata(ids: { workstreamId: string; sessionId: string }, overrides: Partial<SaveMetadata> = {}): SaveMetadata {
  return {
    workstreamId: ids.workstreamId,
    sessionId: ids.sessionId,
    harnessId: 'claude-code',
    formatId: 'claude-code-transcript',
    formatVersion: 1,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    byteLength: 3,
    checksum: 'sha256:abc',
    seedPolicyRevision: 'handoff-seed-v1',
    nativeOrigin: { contextId: 'ctx-1' },
    workspaceDeps: {},
    ...overrides,
  }
}

test('a repeated capture discovers the same Save instead of writing a second one', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const ids = await seedWorkstreamAndSession(db, client)
      const first = await recordSave(client, captureKey(), metadata(ids))
      const second = await recordSave(client, captureKey(), metadata(ids))
      assert.equal(first.created, true)
      assert.equal(second.created, false)
      assert.equal(second.save.id, first.save.id)
      const count = await db.pool.query('SELECT count(*)::int AS n FROM saves')
      assert.equal(count.rows[0]['n'], 1)
    } finally {
      client.release()
    }
  })
})

test('the same capture key carrying a different payload is a conflict, never a silent overwrite', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const ids = await seedWorkstreamAndSession(db, client)
      await recordSave(client, captureKey(), metadata(ids))
      await assert.rejects(
        () => recordSave(client, captureKey(), metadata(ids, { checksum: 'sha256:different' })),
        CaptureKeyConflictError,
      )
      const count = await db.pool.query('SELECT count(*)::int AS n FROM saves')
      assert.equal(count.rows[0]['n'], 1, 'the conflicting capture wrote nothing')
    } finally {
      client.release()
    }
  })
})

test('CONT-009: the frontier is what the driver proved, not the journal head', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const ids = await seedWorkstreamAndSession(db, client)
      // The Workstream's head has moved well past what the context incorporated.
      await db.pool.query('UPDATE workstreams SET head_seq = 42 WHERE id = $1', [ids.workstreamId])
      const recorded = await recordSave(client, captureKey({ frontierW: 7 }), metadata(ids))
      assert.equal(recorded.save.frontierW, 7, 'the Save records the driver-proved frontier')

      const head = await db.pool.query('SELECT head_seq FROM workstreams WHERE id = $1', [ids.workstreamId])
      assert.equal(Number(head.rows[0]['head_seq']), 42)
      assert.notEqual(recorded.save.frontierW, Number(head.rows[0]['head_seq']), 'and never copies the head')

      // An Anchor may only be published on that proved frontier, so the queued-but-unincorporated
      // facts stay outside it: publication advances to 7, not to 42.
      const published = await publishAnchor(client, {
        workstreamId: ids.workstreamId,
        harnessId: 'claude-code',
        saveId: recorded.save.id,
        frontierW: recorded.save.frontierW,
        expectedPrevious: null,
      })
      assert.equal(published.kind, 'published')
      assert.equal((await getAnchor(db.pool, ids.workstreamId, 'claude-code'))?.frontierW, 7)
    } finally {
      client.release()
    }
  })
})

test('CONT-010: a stale capture at the same watermark is rejected and the newer Anchor is preserved', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const ids = await seedWorkstreamAndSession(db, client)
      const older = await recordSave(client, captureKey({ contextId: 'ctx-older', frontierW: 5 }), metadata(ids, { checksum: 'sha256:older' }))
      const newer = await recordSave(client, captureKey({ contextId: 'ctx-newer', frontierW: 9 }), metadata(ids, { checksum: 'sha256:newer' }))
      const stale = await recordSave(client, captureKey({ contextId: 'ctx-stale', frontierW: 9 }), metadata(ids, { checksum: 'sha256:stale' }))

      await publishAnchor(client, { workstreamId: ids.workstreamId, harnessId: 'claude-code', saveId: older.save.id, frontierW: 5, expectedPrevious: null })
      const advanced = await publishAnchor(client, {
        workstreamId: ids.workstreamId,
        harnessId: 'claude-code',
        saveId: newer.save.id,
        frontierW: 9,
        expectedPrevious: older.save.id,
      })
      assert.equal(advanced.kind, 'published')

      // The stale capture still believes the Anchor holds the OLD Save: rejected on that alone.
      const staleExpectation = await publishAnchor(client, {
        workstreamId: ids.workstreamId,
        harnessId: 'claude-code',
        saveId: stale.save.id,
        frontierW: 9,
        expectedPrevious: older.save.id,
      })
      assert.equal(staleExpectation.kind, 'rejected_stale_expectation')

      // Even with a correct expectation, an equal frontier proves no further incorporation.
      const equalFrontier = await publishAnchor(client, {
        workstreamId: ids.workstreamId,
        harnessId: 'claude-code',
        saveId: stale.save.id,
        frontierW: 9,
        expectedPrevious: newer.save.id,
      })
      assert.equal(equalFrontier.kind, 'rejected_frontier_not_ahead')

      const current = await getAnchor(db.pool, ids.workstreamId, 'claude-code')
      assert.equal(current?.saveId, newer.save.id, 'the newer Anchor survived both attempts')
      assert.equal(current?.frontierW, 9)
    } finally {
      client.release()
    }
  })
})

test('publishing against a believed-absent Anchor that now exists is rejected, not inserted over', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const ids = await seedWorkstreamAndSession(db, client)
      const first = await recordSave(client, captureKey({ contextId: 'ctx-1' }), metadata(ids, { checksum: 'sha256:one' }))
      const second = await recordSave(client, captureKey({ contextId: 'ctx-2', frontierW: 8 }), metadata(ids, { checksum: 'sha256:two' }))
      await publishAnchor(client, { workstreamId: ids.workstreamId, harnessId: 'claude-code', saveId: first.save.id, frontierW: 7, expectedPrevious: null })
      const outcome = await publishAnchor(client, {
        workstreamId: ids.workstreamId,
        harnessId: 'claude-code',
        saveId: second.save.id,
        frontierW: 8,
        expectedPrevious: null,
      })
      assert.equal(outcome.kind, 'rejected_stale_expectation')
      assert.equal((await getAnchor(db.pool, ids.workstreamId, 'claude-code'))?.saveId, first.save.id)
    } finally {
      client.release()
    }
  })
})

test('CONT-008: an invalidation excludes the exact Save/driver pair, and a different revision is unaffected', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const ids = await seedWorkstreamAndSession(db, client)
      const save = await recordSave(client, captureKey(), metadata(ids))
      assert.equal(await isExcluded(db.pool, save.save.id, 'driver-1'), false)

      await invalidate(client, {
        saveId: save.save.id,
        driverRevision: 'driver-1',
        cause: 'restore verified to produce a different transcript checksum',
        verifier: 'harnesses/claude-code driver',
        target: 'driver-1',
      })
      assert.equal(await isExcluded(db.pool, save.save.id, 'driver-1'), true)
      assert.equal(await isExcluded(db.pool, save.save.id, 'driver-2'), false, 'a fixed driver revision is not excluded by its predecessor\'s evidence')

      await invalidate(client, { saveId: save.save.id, cause: 'format retired', verifier: 'operator', target: 'all revisions' })
      assert.equal(await isExcluded(db.pool, save.save.id, 'driver-2'), true, 'an unscoped invalidation excludes every revision')
    } finally {
      client.release()
    }
  })
})

test('role boundary: the payload role reads and writes bytes but cannot see Save metadata or Anchors', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const ids = await seedWorkstreamAndSession(db, client)
      const save = await recordSave(client, captureKey(), metadata(ids))

      await db.asRole(client, PAYLOAD, async () => {
        await writePayload(client, save.save.id, new Uint8Array([1, 2, 3]))
        const bytes = await readPayload(client, save.save.id)
        assert.deepEqual([...(bytes ?? [])], [1, 2, 3], 'the transport can move the bytes it exists to move')
        await assert.rejects(() => client.query('SELECT * FROM saves'), /permission denied/, 'but never reads the metadata that decides which Save is current')
        await assert.rejects(() => client.query('SELECT * FROM anchors'), /permission denied/, 'and can never publish or even read an Anchor')
      })
    } finally {
      client.release()
    }
  })
})

test('role boundary: the product role owns Save metadata and Anchors but can never touch the bytes', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const ids = await seedWorkstreamAndSession(db, client)
      const save = await recordSave(client, captureKey(), metadata(ids))
      await db.asRole(client, PAYLOAD, () => writePayload(client, save.save.id, new Uint8Array([1, 2, 3])))

      await db.asRole(client, PRODUCT, async () => {
        const rows = await client.query('SELECT id FROM saves WHERE id = $1', [save.save.id])
        assert.equal(rows.rowCount, 1, 'metadata is the product side\'s to read')
        await assert.rejects(() => client.query('SELECT bytes FROM save_payloads'), /permission denied/, 'core never reads Save bytes (ADR 0008)')
      })
    } finally {
      client.release()
    }
  })
})

test('role boundary: a Save is immutable — even the product role cannot rewrite or delete one', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const ids = await seedWorkstreamAndSession(db, client)
      const save = await recordSave(client, captureKey(), metadata(ids))
      await db.asRole(client, PRODUCT, async () => {
        await assert.rejects(() => client.query('UPDATE saves SET checksum = $2 WHERE id = $1', [save.save.id, 'sha256:rewritten']), /permission denied/)
        await assert.rejects(() => client.query('DELETE FROM saves WHERE id = $1', [save.save.id]), /permission denied/)
      })
    } finally {
      client.release()
    }
  })
})

test('role boundary: the metadata reader sees Saves and Anchors but writes nothing', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const ids = await seedWorkstreamAndSession(db, client)
      const save = await recordSave(client, captureKey(), metadata(ids))
      await db.asRole(client, META, async () => {
        const rows = await client.query('SELECT id FROM saves WHERE id = $1', [save.save.id])
        assert.equal(rows.rowCount, 1)
        await assert.rejects(
          () => client.query('INSERT INTO anchors (workstream_id, harness_id, save_id, frontier_w) VALUES ($1,$2,$3,$4)', [ids.workstreamId, 'claude-code', save.save.id, 7]),
          /permission denied/,
        )
      })
    } finally {
      client.release()
    }
  })
})

test('a capture key is per-context: the same Pod and generation with a different context is a different Save', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const ids = await seedWorkstreamAndSession(db, client)
      const first = await recordSave(client, captureKey({ contextId: 'ctx-1' }), metadata(ids, { checksum: 'sha256:one' }))
      const second = await recordSave(client, captureKey({ contextId: 'ctx-2' }), metadata(ids, { checksum: 'sha256:two' }))
      assert.notEqual(second.save.id, first.save.id)
      assert.equal((await findSaveByCaptureKey(db.pool, captureKey({ contextId: 'ctx-2' })))?.id, second.save.id)
    } finally {
      client.release()
    }
  })
})

test('CONT-011: an unversioned or unavailable workspace dependency rejects the exact resume', () => {
  const harness = {
    harnessId: 'claude-code',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    driverRevision: 'driver-2',
    supportedFormats: [{ formatId: 'claude-code-transcript', formatVersion: 1 }],
    workspaceDeps: { repo: 'abc123' },
  }
  const base = { harnessId: 'claude-code', formatId: 'claude-code-transcript', formatVersion: 1, imageDigest: `sha256:${'a'.repeat(64)}` }

  assert.deepEqual(checkCompatibility({ ...base, workspaceDeps: { repo: 'abc123' } }, harness), { kind: 'compatible' })

  const unversioned = checkCompatibility({ ...base, workspaceDeps: { repo: '' } }, harness)
  assert.equal(unversioned.kind, 'incompatible')
  assert.match(unversioned.kind === 'incompatible' ? unversioned.reason : '', /unversioned/)

  const missing = checkCompatibility({ ...base, workspaceDeps: { other: 'v1' } }, harness)
  assert.equal(missing.kind, 'incompatible')
  assert.match(missing.kind === 'incompatible' ? missing.reason : '', /not available/)

  const drifted = checkCompatibility({ ...base, workspaceDeps: { repo: 'def456' } }, harness)
  assert.equal(drifted.kind, 'incompatible')

  const wrongFormat = checkCompatibility({ ...base, formatVersion: 2 }, harness)
  assert.equal(wrongFormat.kind, 'incompatible')
  assert.match(wrongFormat.kind === 'incompatible' ? wrongFormat.reason : '', /format/)
})

test('an image digest difference alone is compatible — an upgrade is normal, a format change is not', () => {
  const compatibility = checkCompatibility(
    { harnessId: 'claude-code', formatId: 'claude-code-transcript', formatVersion: 1, imageDigest: `sha256:${'a'.repeat(64)}` },
    {
      harnessId: 'claude-code',
      imageDigest: `sha256:${'c'.repeat(64)}`,
      driverRevision: 'driver-3',
      supportedFormats: [{ formatId: 'claude-code-transcript', formatVersion: 1 }],
    },
  )
  assert.deepEqual(compatibility, { kind: 'compatible' })
})
