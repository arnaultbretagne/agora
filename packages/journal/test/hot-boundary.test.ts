import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type pg from 'pg'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { commitHotBoundary, currentSession, factsBySession, JournalError } from '../src/index.js'
import { createWorkstream, openTestSession, PRODUCT, withTx } from './support.js'

async function connect(db: TestDatabase): Promise<pg.PoolClient> {
  return db.pool.connect()
}

test('SESSION-boundary: ends the old Session, opens a successor on the SAME Pod, recorded as its predecessor', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await createWorkstream(db, client)
      const opened = await openTestSession(db, client, workstreamId, 'pod-retained')
      const result = await db.asRole(client, PRODUCT, () =>
        withTx(db, client, () =>
          commitHotBoundary(client, workstreamId, { endingSessionId: opened.sessionId, podUid: 'pod-retained', reason: 'capability meaning changed' }, { nowSql: db.nowSql }),
        ),
      )
      assert.equal(result.endedSessionId, opened.sessionId)
      assert.notEqual(result.newSessionId, opened.sessionId)
      assert.equal(result.newSessionOrdinal, 2, 'the second Session on this Workstream')

      const current = await currentSession(db.pool, workstreamId)
      assert.equal(current?.sessionId, result.newSessionId, 'the successor is now current')
      assert.equal(current?.podUid, 'pod-retained', 'the same Pod, never a fresh BUILD')

      const endedFacts = await factsBySession(db.pool, workstreamId, opened.sessionId)
      assert.ok(endedFacts.some((f) => f.kind === 'session.ended'))
      const newFacts = await factsBySession(db.pool, workstreamId, result.newSessionId)
      assert.ok(newFacts.some((f) => f.kind === 'session.opened'))
    } finally {
      client.release()
    }
  })
})

test('SESSION-boundary: repeated completion opens no duplicate Session (idempotent per ending Session)', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await createWorkstream(db, client)
      const opened = await openTestSession(db, client, workstreamId, 'pod-retained')
      const first = await db.asRole(client, PRODUCT, () =>
        withTx(db, client, () => commitHotBoundary(client, workstreamId, { endingSessionId: opened.sessionId, podUid: 'pod-retained', reason: 'r' }, { nowSql: db.nowSql })),
      )
      const second = await db.asRole(client, PRODUCT, () =>
        withTx(db, client, () => commitHotBoundary(client, workstreamId, { endingSessionId: opened.sessionId, podUid: 'pod-retained', reason: 'r' }, { nowSql: db.nowSql })),
      )
      assert.deepEqual(second, first)
      const count = await db.pool.query('SELECT count(*)::int AS n FROM sessions WHERE workstream_id = $1', [workstreamId])
      assert.equal(count.rows[0]['n'], 2, 'exactly the original plus one successor, never a second successor')
    } finally {
      client.release()
    }
  })
})

test('SESSION-boundary: a Session already ended by something else still gets its successor (idempotent even mid-way)', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await createWorkstream(db, client)
      const opened = await openTestSession(db, client, workstreamId, 'pod-retained')
      const { endAttribution } = await import('../src/index.js')
      await db.asRole(client, PRODUCT, () => withTx(db, client, () => endAttribution(client, workstreamId, opened.sessionId, 'already ended')))

      const result = await db.asRole(client, PRODUCT, () =>
        withTx(db, client, () => commitHotBoundary(client, workstreamId, { endingSessionId: opened.sessionId, podUid: 'pod-retained', reason: 'r' }, { nowSql: db.nowSql })),
      )
      assert.notEqual(result.newSessionId, opened.sessionId)
      const current = await currentSession(db.pool, workstreamId)
      assert.equal(current?.sessionId, result.newSessionId)
    } finally {
      client.release()
    }
  })
})

test('SESSION-boundary: an unknown ending Session is refused, not silently opened as a fresh one', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await createWorkstream(db, client)
      await assert.rejects(
        () => db.asRole(client, PRODUCT, () => withTx(db, client, () => commitHotBoundary(client, workstreamId, { endingSessionId: randomUUID(), podUid: 'pod-1', reason: 'r' }))),
        JournalError,
      )
    } finally {
      client.release()
    }
  })
})

test('SESSION-boundary: an unknown Workstream is refused', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      await assert.rejects(
        () => db.asRole(client, PRODUCT, () => withTx(db, client, () => commitHotBoundary(client, randomUUID(), { endingSessionId: randomUUID(), podUid: 'pod-1', reason: 'r' }))),
        JournalError,
      )
    } finally {
      client.release()
    }
  })
})
