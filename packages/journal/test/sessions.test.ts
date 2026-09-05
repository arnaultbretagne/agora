import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { appendFact, endAttribution, factsBySession, factsFrom, openSession } from '../src/index.js'
import { createWorkstream, openTestSession, PRODUCT, withTx } from './support.js'

async function connect(db: TestDatabase): Promise<pg.PoolClient> {
  return db.pool.connect()
}

test('CONT-002: a fresh Workstream pins the cutoff H = 0', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(db, client)
      const opened = await openTestSession(db, client, id)
      assert.equal(opened.cutoffH, 0)
      assert.equal(opened.ordinal, 1)
      assert.equal(opened.openedAtSeq, 1, 'the opened fact is the first fact of the Workstream')
      const facts = await factsBySession(db.pool, id, opened.sessionId)
      assert.equal(facts.length, 1)
      assert.equal(facts[0]!.kind, 'session.opened')
      assert.ok(facts[0]!.seq > opened.cutoffH)
    } finally {
      client.release()
    }
  })
})

test('CONT-001: the opening range (W, H] contains none of the Session bootstrap facts', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(db, client)
      const first = await openTestSession(db, client, id, 'pod-1')
      await db.asRole(client, PRODUCT, () =>
        withTx(db, client, () =>
          appendFact(client, id, { sessionId: first.sessionId, kind: 'session.provenance', payload: { runtimeIds: { gen: 1 } } }, { nowSql: db.nowSql }),
        ),
      )
      await db.asRole(client, PRODUCT, () => endAttribution(client, id, first.sessionId, 'superseded', { nowSql: db.nowSql }))

      const second = await openTestSession(db, client, id, 'pod-2')
      const secondFacts = await factsBySession(db.pool, id, second.sessionId)
      assert.ok(secondFacts.length >= 1)
      for (const fact of secondFacts) {
        assert.ok(fact.seq > second.cutoffH, `fact ${fact.seq} must be beyond H ${second.cutoffH}`)
      }
      const allFacts = await factsFrom(db.pool, id, 0)
      const before = allFacts.filter((fact) => fact.seq <= second.cutoffH)
      assert.ok(before.length > 0, 'the opening range is non-empty for this scenario')
      assert.ok(before.every((fact) => fact.sessionId !== second.sessionId), 'no fact of the new Session precedes H')
    } finally {
      client.release()
    }
  })
})

test('repeated birth with the same Pod UID under concurrency creates exactly one Session and one cutoff', async () => {
  await withTestDatabase(async (db) => {
    const setup = await connect(db)
    const id = await createWorkstream(db, setup)
    setup.release()

    const clientA = await connect(db)
    const clientB = await connect(db)
    try {
      const [a, b] = await Promise.all([
        db.asRole(clientA, PRODUCT, () =>
          clientA.query('BEGIN').then(() =>
            openSession(clientA, id, { podUid: 'pod-race', provenance: {} }, { nowSql: db.nowSql }).then(async (opened) => {
              await clientA.query('COMMIT')
              return opened
            }),
          ),
        ),
        db.asRole(clientB, PRODUCT, () =>
          clientB.query('BEGIN').then(() =>
            openSession(clientB, id, { podUid: 'pod-race', provenance: {} }, { nowSql: db.nowSql }).then(async (opened) => {
              await clientB.query('COMMIT')
              return opened
            }),
          ),
        ),
      ])
      assert.equal(a.sessionId, b.sessionId, 'birth is idempotent by Pod UID')
      assert.equal(a.cutoffH, b.cutoffH)
      const rows = await db.pool.query('SELECT count(*)::int AS n FROM sessions WHERE workstream_id = $1', [id])
      assert.equal(rows.rows[0]!['n'], 1)
      const openedFacts = await db.pool.query("SELECT count(*)::int AS n FROM workstream_facts WHERE workstream_id = $1 AND kind = 'session.opened'", [id])
      assert.equal(openedFacts.rows[0]!['n'], 1)
    } finally {
      clientA.release()
      clientB.release()
    }
  })
})

test('a second current Session is impossible while attribution has not ended', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(db, client)
      await openTestSession(db, client, id, 'pod-1')
      await assert.rejects(
        () =>
          db.asRole(client, PRODUCT, () =>
            withTx(db, client, () => openSession(client, id, { podUid: 'pod-2', provenance: {} }, { nowSql: db.nowSql })),
          ),
        /sessions_one_current_per_workstream/,
      )
    } finally {
      client.release()
    }
  })
})

test('ending attribution makes room for a successor; ending twice changes nothing', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(db, client)
      const first = await openTestSession(db, client, id, 'pod-1')
      const ended = await db.asRole(client, PRODUCT, () => endAttribution(client, id, first.sessionId, 'superseded', { nowSql: db.nowSql }))
      assert.equal(ended.ended, true)
      const again = await db.asRole(client, PRODUCT, () => endAttribution(client, id, first.sessionId, 'superseded', { nowSql: db.nowSql }))
      assert.equal(again.ended, false, 'the second end is a no-op')
      const endedFacts = await db.pool.query("SELECT count(*)::int AS n FROM workstream_facts WHERE workstream_id = $1 AND kind = 'session.ended'", [id])
      assert.equal(endedFacts.rows[0]!['n'], 1)

      const second = await openTestSession(db, client, id, 'pod-2')
      assert.equal(second.ordinal, 2)
      assert.ok(second.cutoffH > first.cutoffH)
    } finally {
      client.release()
    }
  })
})
