import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { appendFact, endAttribution, openSession } from '@agora/journal'
import { rebuild, runIncremental, sessionListProjector, stateHash } from '../src/index.js'
import { PRODUCT, PROJECTOR } from './support.js'

async function connect(db: TestDatabase): Promise<pg.PoolClient> {
  return db.pool.connect()
}

async function createWorkstream(db: TestDatabase, client: pg.PoolClient): Promise<string> {
  const id = crypto.randomUUID()
  await db.asRole(client, PRODUCT, () =>
    client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [
      id,
      'owner@example.com',
      'workstream',
      crypto.randomUUID(),
    ]),
  )
  return id
}

/** A randomized (constraint-respecting) fact sequence: sessions with random provenance updates. */
async function appendRandomizedHistory(db: TestDatabase, client: pg.PoolClient, workstreamId: string, sessionCount: number): Promise<void> {
  for (let index = 0; index < sessionCount; index += 1) {
    const podUid = `pod-${index}-${crypto.randomUUID().slice(0, 8)}`
    await db.asRole(client, PRODUCT, () => withTx(db, client, () => openSession(client, workstreamId, { podUid, provenance: { harness: 'claude-code' } }, { nowSql: db.nowSql })))
    const opened = await client.query('SELECT id FROM sessions WHERE workstream_id = $1 AND pod_uid = $2', [workstreamId, podUid])
    const sessionId: string = opened.rows[0]!['id']
    const provenanceUpdates = 1 + Math.floor(Math.random() * 3)
    for (let update = 0; update < provenanceUpdates; update += 1) {
      const withDigest = Math.random() < 0.5
      await db.asRole(client, PRODUCT, () =>
        withTx(db, client, () =>
          appendFact(
            client,
            workstreamId,
            {
              sessionId,
              kind: 'session.provenance',
              payload: withDigest ? { imageDigest: `sha256:${crypto.randomUUID().replaceAll('-', '')}`, runtimeIds: { update } } : { runtimeIds: { update } },
            },
            { nowSql: db.nowSql },
          ),
        ),
      )
    }
    await db.asRole(client, PRODUCT, () => endAttribution(client, workstreamId, sessionId, 'superseded', { nowSql: db.nowSql }))
  }
}

async function withTx<T>(db: TestDatabase, client: pg.PoolClient, body: () => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    const result = await body()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

test('incremental runs and a rebuild produce identical hashes on a randomized fact sequence', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(db, client)
      // Random chunking: facts arrive in bursts; incremental runs fold each burst separately.
      let incremental: Awaited<ReturnType<typeof runIncremental>> = { mode: 'incremental', applied: 0, throughSeq: 0 }
      for (let burst = 0; burst < 4; burst += 1) {
        await appendRandomizedHistory(db, client, id, 1 + Math.floor(Math.random() * 2))
        incremental = await db.asRole(client, PROJECTOR, () => runIncremental(client, id, sessionListProjector))
        assert.equal(incremental.mode, 'incremental')
      }
      const incrementalThroughSeq = incremental.throughSeq
      const incrementalHash = await db.asRole(client, PROJECTOR, () => stateHash(client, id, sessionListProjector))

      const rebuilt = await db.asRole(client, PROJECTOR, () => rebuild(client, id, sessionListProjector))
      assert.equal(rebuilt.mode, 'rebuilt')
      const rebuildHash = await db.asRole(client, PROJECTOR, () => stateHash(client, id, sessionListProjector))
      assert.equal(rebuildHash, incrementalHash)
      assert.equal(rebuilt.throughSeq, incrementalThroughSeq)
    } finally {
      client.release()
    }
  })
})

test('a projector version bump triggers a rebuild', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(db, client)
      await appendRandomizedHistory(db, client, id, 1)
      await db.asRole(client, PROJECTOR, () => runIncremental(client, id, sessionListProjector))

      const bumped = { ...sessionListProjector, version: `${sessionListProjector.version}-next` }
      const result = await db.asRole(client, PROJECTOR, () => runIncremental(client, id, bumped))
      assert.equal(result.mode, 'rebuilt', 'a version change forces the full replay')
      const checkpoint = await client.query('SELECT projector_version FROM projection_checkpoints WHERE projector = $1 AND workstream_id = $2', [
        sessionListProjector.name,
        id,
      ])
      assert.equal(checkpoint.rows[0]!['projector_version'], `${sessionListProjector.version}-next`)
    } finally {
      client.release()
    }
  })
})

test('projected rows carry first_seq/latest_seq source references and fold the registered kinds', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(db, client)
      const opened = await db.asRole(client, PRODUCT, () =>
        withTx(db, client, () => openSession(client, id, { podUid: 'pod-x', provenance: {} }, { nowSql: db.nowSql })),
      )
      await db.asRole(client, PRODUCT, () =>
        withTx(db, client, () =>
          appendFact(
            client,
            id,
            { sessionId: opened.sessionId, kind: 'session.provenance', payload: { imageDigest: 'sha256:abc', runtimeIds: {} } },
            { nowSql: db.nowSql },
          ),
        ),
      )
      await db.asRole(client, PRODUCT, () => endAttribution(client, id, opened.sessionId, 'superseded', { nowSql: db.nowSql }))
      await db.asRole(client, PROJECTOR, () => runIncremental(client, id, sessionListProjector))

      const row = (
        await client.query(
          `SELECT ordinal, pod_uid, cutoff_h, attribution_ended_at, image_digest, first_seq, latest_seq
           FROM projection_sessions WHERE workstream_id = $1 AND session_id = $2`,
          [id, opened.sessionId],
        )
      ).rows[0]!
      assert.equal(row['pod_uid'], 'pod-x')
      assert.equal(row['ordinal'], 1)
      assert.equal(row['cutoff_h'], opened.cutoffH)
      assert.ok(row['attribution_ended_at'] !== null)
      assert.equal(row['image_digest'], 'sha256:abc')
      assert.equal(row['first_seq'], opened.openedAtSeq)
      assert.equal(row['latest_seq'], opened.openedAtSeq + 2, 'the session.ended fact is the latest source')
    } finally {
      client.release()
    }
  })
})
