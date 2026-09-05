import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { appendFact, factsBetween, factsBySession, factsFrom } from '../src/index.js'
import { createWorkstream, openTestSession, PRODUCT, withTx } from './support.js'

async function connect(db: TestDatabase): Promise<pg.PoolClient> {
  return db.pool.connect()
}

test('Session reads are a filtered view of the Workstream stream; range reads paginate by seq', async () => {
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
      const all = await factsFrom(db.pool, id, 0)
      assert.deepEqual(all.map((fact) => fact.seq), [1, 2])

      const page = await factsBetween(db.pool, id, 2, 2)
      assert.deepEqual(page.map((fact) => fact.seq), [2])
      assert.equal(page[0]!.kind, 'session.provenance')

      const empty = await factsBetween(db.pool, id, 5, 9)
      assert.equal(empty.length, 0)
    } finally {
      client.release()
    }
  })
})
