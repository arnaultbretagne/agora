import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import {
  advancePublication,
  enqueueTargets,
  enumerateTargets,
  isRevisionCurrent,
  publishRevision,
  selectedRevision,
  unfinishedPublications,
} from '../src/publication.js'

async function workstreams(db: TestDatabase, count: number): Promise<readonly string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const id = randomUUID()
    await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1,$2,$3,$4)', [id, 'p', `w${String(i)}`, randomUUID()])
    ids.push(id)
  }
  return ids
}

async function publish(db: TestDatabase, revisionId: string): Promise<string> {
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    const publication = await publishRevision(client, { revisionId, revisionSet: { catalogue: revisionId } })
    await client.query('COMMIT')
    return publication.id
  } finally {
    client.release()
  }
}

test('publishing records the selection and the publication in one commit', async () => {
  await withTestDatabase(async (db) => {
    await workstreams(db, 3)
    const publicationId = await publish(db, 'rev-1')

    const selected = await selectedRevision(db.pool)
    assert.equal(selected?.revisionId, 'rev-1')
    assert.deepEqual(selected?.revisionSet, { catalogue: 'rev-1' })
    assert.equal((await unfinishedPublications(db.pool))[0]?.id, publicationId)
  })
})

test('publishing the same revision twice discovers the same publication, never a second enumeration', async () => {
  await withTestDatabase(async (db) => {
    await workstreams(db, 2)
    const first = await publish(db, 'rev-1')
    const second = await publish(db, 'rev-1')
    assert.equal(first, second)
    assert.equal((await unfinishedPublications(db.pool)).length, 1)
  })
})

test('enumeration reaches every Workstream, including ones with no work row at all', async () => {
  await withTestDatabase(async (db) => {
    const ids = await workstreams(db, 7)
    // One busy Workstream, six idle. A workset-only enumeration would find exactly one.
    await db.pool.query(
      `INSERT INTO workstream_reconciliation_work (workstream_id, intent_seq, work_generation) VALUES ($1, 1, nextval('work_generation_seq'))`,
      [ids[0]],
    )
    const publicationId = await publish(db, 'rev-1')

    const advanced = await advancePublication(db.pool, publicationId, { batchSize: 2 })

    assert.equal(advanced.state, 'complete')
    const targets = await db.pool.query('SELECT workstream_id, state FROM publication_targets WHERE publication_id = $1', [publicationId])
    assert.equal(targets.rowCount, 7, 'every Workstream is recorded as owed a wake')
    assert.ok(targets.rows.every((row) => (row as { state: string }).state === 'enqueued'))
    const work = await db.pool.query('SELECT workstream_id FROM workstream_reconciliation_work')
    assert.equal(work.rowCount, 7, 'and the idle ones now have work rows of their own')
  })
})

test('every woken Workstream gets a fresh generation, so an in-flight claim cannot finalize over it', async () => {
  await withTestDatabase(async (db) => {
    const ids = await workstreams(db, 1)
    await db.pool.query(
      `INSERT INTO workstream_reconciliation_work (workstream_id, intent_seq, work_generation, claim_token, lease_until)
       VALUES ($1, 1, nextval('work_generation_seq'), $2, now() + interval '5 minutes')`,
      [ids[0], randomUUID()],
    )
    const before = await db.pool.query('SELECT work_generation, claim_token FROM workstream_reconciliation_work WHERE workstream_id = $1', [ids[0]])

    await advancePublication(db.pool, await publish(db, 'rev-1'))

    const after = await db.pool.query('SELECT work_generation, claim_token, due_at FROM workstream_reconciliation_work WHERE workstream_id = $1', [ids[0]])
    assert.ok(Number(after.rows[0]!['work_generation']) > Number(before.rows[0]!['work_generation']))
    assert.equal(after.rows[0]!['claim_token'], null, 'the claim the old generation held is invalidated')
  })
})

test('a crash mid-enumeration resumes at the durable cursor: no page skipped, none re-enumerated from the start', async () => {
  await withTestDatabase(async (db) => {
    const ids = await workstreams(db, 5)
    const publicationId = await publish(db, 'rev-1')

    // One enumeration pass, then "crash": nothing else runs until a later pass picks it up.
    const client = await db.pool.connect()
    try {
      await client.query('BEGIN')
      const first = await enumerateTargets(client, publicationId, 2)
      await client.query('COMMIT')
      assert.deepEqual(first, { recorded: 2, done: false })
    } finally {
      client.release()
    }
    const cursor = (await db.pool.query('SELECT cursor_workstream_id FROM revision_publications WHERE id = $1', [publicationId])).rows[0]!['cursor_workstream_id']
    assert.equal(cursor, [...ids].sort()[1], 'the cursor names the last Workstream actually written')

    const advanced = await advancePublication(db.pool, publicationId, { batchSize: 2 })

    assert.equal(advanced.state, 'complete')
    const targets = await db.pool.query('SELECT workstream_id FROM publication_targets WHERE publication_id = $1', [publicationId])
    assert.equal(targets.rowCount, 5, 'the remaining three were recorded exactly once each')
  })
})

test('enqueue only starts once enumeration is finished — a half-enumerated publication cannot claim to know its targets', async () => {
  await withTestDatabase(async (db) => {
    await workstreams(db, 4)
    const publicationId = await publish(db, 'rev-1')
    const client = await db.pool.connect()
    try {
      await client.query('BEGIN')
      await enumerateTargets(client, publicationId, 2)
      const enqueued = await enqueueTargets(client, publicationId, 10)
      await client.query('COMMIT')
      assert.deepEqual(enqueued, { enqueued: 0, done: false })
    } finally {
      client.release()
    }
    const work = await db.pool.query('SELECT workstream_id FROM workstream_reconciliation_work')
    assert.equal(work.rowCount, 0)
  })
})

test('SESSION-A11/ENGINE-014: a resolution under a superseded revision is obsolete the moment the new one commits', async () => {
  await withTestDatabase(async (db) => {
    await workstreams(db, 1)
    // Before any publication there is nothing to be stale against: a first boot is not fenced.
    assert.equal(await isRevisionCurrent(db.pool, 'rev-0'), true)
    assert.equal(await isRevisionCurrent(db.pool, null), true)

    await publish(db, 'rev-1')
    assert.equal(await isRevisionCurrent(db.pool, 'rev-1'), true)
    assert.equal(await isRevisionCurrent(db.pool, 'rev-0'), false, 'a worker on the old catalogue refuses rather than acting')
    assert.equal(await isRevisionCurrent(db.pool, null), false)

    // And it flips immediately on publication — before the sweep has enqueued anything.
    await publish(db, 'rev-2')
    assert.equal(await isRevisionCurrent(db.pool, 'rev-1'), false)
    assert.equal(await isRevisionCurrent(db.pool, 'rev-2'), true)
  })
})

test('a second publication supersedes the selection while the first one still owes wakes', async () => {
  await withTestDatabase(async (db) => {
    await workstreams(db, 3)
    const first = await publish(db, 'rev-1')
    const second = await publish(db, 'rev-2')

    // Both are still owed: the newer selection does not silently discharge the older publication's
    // targets, because those Workstreams still have to be told SOMETHING changed.
    const unfinished = await unfinishedPublications(db.pool)
    assert.deepEqual(unfinished.map((p) => p.id).sort(), [first, second].sort())

    await advancePublication(db.pool, first)
    await advancePublication(db.pool, second)
    assert.deepEqual(await unfinishedPublications(db.pool), [])
    assert.equal((await selectedRevision(db.pool))?.revisionId, 'rev-2')
  })
})
