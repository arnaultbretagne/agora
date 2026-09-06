import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { openSession, recordRestoreOrigin } from '@agora/journal'
import { recordSave } from '@agora/custody'
import { deleteWorkstream, readRetentionSettings, sweepSavesWithoutPayloads, sweepUnreferencedSaves, MissingRetentionSettingError, type SweepResult } from '../src/retention.js'

const settings = readRetentionSettings(
  JSON.parse(readFileSync(new URL('../../../../contracts/catalogue/retention-settings.json', import.meta.url).pathname, 'utf8')) as Record<string, unknown>,
)

interface Fixture {
  readonly workstreamId: string
  readonly sessionId: string
}

async function fixture(db: TestDatabase): Promise<Fixture> {
  const workstreamId = randomUUID()
  const client = await db.pool.connect()
  try {
    await client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1,$2,$3,$4)', [workstreamId, 'p', 't', randomUUID()])
    await client.query('BEGIN')
    const opened = await openSession(client, workstreamId, { podUid: `pod-${randomUUID()}`, provenance: {} })
    await client.query('COMMIT')
    return { workstreamId, sessionId: opened.sessionId }
  } finally {
    client.release()
  }
}

/** A Save `ageDays` old, optionally with its payload committed and optionally anchored. */
async function save(
  db: TestDatabase,
  f: Fixture,
  options: { ageDays?: number; withPayload?: boolean; anchored?: boolean; contextId?: string } = {},
): Promise<string> {
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    const recorded = await recordSave(
      client,
      { podUid: `pod-${randomUUID()}`, processGeneration: 0, contextId: options.contextId ?? randomUUID(), frontierW: 0, driverRevision: 'claude-code-transcript-1' },
      {
        workstreamId: f.workstreamId,
        sessionId: f.sessionId,
        harnessId: 'claude-code',
        formatId: 'claude-code-transcript',
        formatVersion: 1,
        imageDigest: `sha256:${'a'.repeat(64)}`,
        byteLength: 4,
        checksum: `sha256:${'b'.repeat(64)}`,
        seedPolicyRevision: 'handoff-seed-v1',
        nativeOrigin: {},
        workspaceDeps: {},
      },
    )
    if (options.withPayload !== false) {
      await client.query('INSERT INTO save_payloads (save_id, bytes) VALUES ($1, $2)', [recorded.save.id, Buffer.from('data')])
    }
    if (options.anchored === true) {
      await client.query('INSERT INTO anchors (workstream_id, harness_id, save_id, frontier_w) VALUES ($1,$2,$3,0)', [f.workstreamId, 'claude-code', recorded.save.id])
    }
    if (options.ageDays !== undefined) {
      await client.query('UPDATE saves SET created_at = now() - make_interval(days => $2) WHERE id = $1', [recorded.save.id, options.ageDays])
    }
    await client.query('COMMIT')
    return recorded.save.id
  } finally {
    client.release()
  }
}

async function sweep(db: TestDatabase): Promise<SweepResult> {
  const client = await db.pool.connect()
  try {
    return await sweepUnreferencedSaves(client, settings)
  } finally {
    client.release()
  }
}

async function ids(db: TestDatabase): Promise<readonly string[]> {
  const rows = await db.pool.query('SELECT id FROM saves ORDER BY created_at')
  return rows.rows.map((row) => (row as { id: string }).id)
}

test('the pinned retention values load, and a missing one fails naming itself', () => {
  assert.ok(settings.unreferencedSaveGraceDays > 0)
  assert.throws(() => readRetentionSettings({}), (error: unknown) => {
    assert.ok(error instanceof MissingRetentionSettingError)
    assert.equal(error.field, 'unreferencedSaveGraceDays')
    return true
  })
})

test('an anchored Save is never deleted, however old it is', async () => {
  await withTestDatabase(async (db) => {
    const f = await fixture(db)
    const anchored = await save(db, f, { ageDays: 400, anchored: true })

    const result = await sweep(db)

    assert.equal(result.deletedSaves, 0)
    assert.deepEqual(await ids(db), [anchored], 'it IS the recovery point')
  })
})

test('a Save a Session restored from is never deleted while that Session exists', async () => {
  await withTestDatabase(async (db) => {
    const f = await fixture(db)
    const restoredFrom = await save(db, f, { ageDays: 400 })
    const client = await db.pool.connect()
    try {
      await client.query('BEGIN')
      await recordRestoreOrigin(client, f.sessionId, { originW: 0, saveId: restoredFrom })
      await client.query('COMMIT')
    } finally {
      client.release()
    }

    assert.equal((await sweep(db)).deletedSaves, 0)
    assert.deepEqual(await ids(db), [restoredFrom])
  })
})

test('an unreferenced Save past its grace goes, with its payload — and one inside it stays', async () => {
  await withTestDatabase(async (db) => {
    const f = await fixture(db)
    // The Session's own latest Save is protected while the Session is retained, so give it two
    // older ones to sweep and end the Session's attribution long ago.
    await db.pool.query('UPDATE sessions SET attribution_ended_at = now() - make_interval(days => $1) WHERE id = $2', [settings.latestSavePerSessionGraceDays + 10, f.sessionId])
    const old = await save(db, f, { ageDays: settings.unreferencedSaveGraceDays + 1 })
    const recent = await save(db, f, { ageDays: 1 })

    const result = await sweep(db)

    assert.equal(result.deletedSaves, 1)
    assert.equal(result.deletedPayloads, 1, 'the bytes go with the metadata that identifies them')
    assert.deepEqual(await ids(db), [recent])
    assert.ok(old.length > 0)
    assert.equal((await db.pool.query('SELECT save_id FROM save_payloads')).rowCount, 1)
  })
})

test('the latest Save of a retained Session survives even past the grace period', async () => {
  await withTestDatabase(async (db) => {
    const f = await fixture(db)
    // The Session still holds attribution: "what did it end with" must stay answerable.
    const older = await save(db, f, { ageDays: settings.unreferencedSaveGraceDays + 30 })
    const latest = await save(db, f, { ageDays: settings.unreferencedSaveGraceDays + 1 })

    const result = await sweep(db)

    assert.equal(result.deletedSaves, 1)
    assert.deepEqual(await ids(db), [latest])
    assert.ok(older.length > 0)
  })
})

test('a Save whose bytes were never committed goes on its own, much shorter grace', async () => {
  await withTestDatabase(async (db) => {
    const f = await fixture(db)
    await db.pool.query('UPDATE sessions SET attribution_ended_at = now() - make_interval(days => 100) WHERE id = $1', [f.sessionId])
    const orphan = await save(db, f, { withPayload: false, ageDays: 1 })
    const healthy = await save(db, f, { ageDays: 1 })

    const client = await db.pool.connect()
    let result
    try {
      result = await sweepSavesWithoutPayloads(client, settings)
    } finally {
      client.release()
    }

    assert.equal(result.deletedSaves, 1, 'a Save with no payload is a promise that cannot be kept')
    assert.deepEqual(await ids(db), [healthy])
    assert.ok(orphan.length > 0)
  })
})

test('an invalidation never shortens retention: an invalidated Save is swept on its own schedule', async () => {
  await withTestDatabase(async (db) => {
    const f = await fixture(db)
    const invalidated = await save(db, f, { ageDays: 1, anchored: true })
    await db.pool.query('INSERT INTO save_invalidations (id, save_id, cause, verifier, target) VALUES ($1,$2,$3,$4,$5)', [
      randomUUID(),
      invalidated,
      'format not readable by the deployed harness',
      'control-plane/restore',
      'claude-code-transcript-2',
    ])

    assert.equal((await sweep(db)).deletedSaves, 0, 'evidence that a Save is unusable is not permission to delete it (CONT-008)')
    assert.deepEqual(await ids(db), [invalidated])
  })
})

test('deleting a Workstream is refused while anything of its execution still exists', async () => {
  await withTestDatabase(async (db) => {
    const f = await fixture(db)
    const client = await db.pool.connect()
    try {
      const withPod = await deleteWorkstream(client, f.workstreamId, { livePods: 1, unresolvedObligations: 0 })
      assert.equal(withPod.kind, 'refused')
      assert.match(withPod.kind === 'refused' ? withPod.reason : '', /Pod\(s\) still exist/)

      const withObligation = await deleteWorkstream(client, f.workstreamId, { livePods: 0, unresolvedObligations: 1 })
      assert.match(withObligation.kind === 'refused' ? withObligation.reason : '', /not extinct \(OFF-005\)/)

      // No Pod, no obligation — but a Session still holds attribution.
      const withSession = await deleteWorkstream(client, f.workstreamId, { livePods: 0, unresolvedObligations: 0 })
      assert.match(withSession.kind === 'refused' ? withSession.reason : '', /still holds attribution/)
    } finally {
      client.release()
    }
    assert.equal((await db.pool.query('SELECT id FROM workstreams WHERE id = $1', [f.workstreamId])).rowCount, 1, 'and nothing was removed by any refusal')
  })
})

test('once execution is extinct, deletion removes the recovery material and the Workstream', async () => {
  await withTestDatabase(async (db) => {
    const f = await fixture(db)
    await save(db, f, { anchored: true })
    await db.pool.query('UPDATE sessions SET attribution_ended_at = now() WHERE workstream_id = $1', [f.workstreamId])

    const client = await db.pool.connect()
    try {
      await client.query('BEGIN')
      const outcome = await deleteWorkstream(client, f.workstreamId, { livePods: 0, unresolvedObligations: 0 })
      await client.query('COMMIT')
      assert.equal(outcome.kind, 'deleted')
    } finally {
      client.release()
    }

    for (const table of ['workstreams', 'sessions', 'saves', 'save_payloads', 'anchors', 'workstream_facts']) {
      const query = table === 'save_payloads' ? 'SELECT save_id FROM save_payloads' : `SELECT * FROM ${table}`
      assert.equal((await db.pool.query(query)).rowCount, 0, `${table} still has rows`)
    }
  })
})
