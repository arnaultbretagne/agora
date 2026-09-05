import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { appendFact, JournalError, registeredKinds, SecretPatternError } from '../src/index.js'
import { createWorkstream, openTestSession, PRODUCT } from './support.js'

async function connect(db: TestDatabase): Promise<pg.PoolClient> {
  return db.pool.connect()
}

test('50 concurrent appends yield exactly the sequences 1..51 under the shared Workstream lock', async () => {
  await withTestDatabase(async (db) => {
    const setup = await connect(db)
    const id = await createWorkstream(db, setup)
    const opened = await openTestSession(db, setup, id)
    setup.release()

    // 50 concurrent appends in two waves of 25 — the pool caps concurrent clients at 25
    // (findings §5: a test that acquires more clients than the pool holds before releasing any
    // deadlocks), but each wave is fully concurrent inside PostgreSQL.
    const appendOnce = async (client: pg.PoolClient): Promise<number> =>
      db.asRole(client, PRODUCT, async () => {
        await client.query('BEGIN')
        try {
          const appended = await appendFact(
            client,
            id,
            { sessionId: opened.sessionId, kind: 'session.provenance', payload: { runtimeIds: { worker: 'concurrent' } } },
            { nowSql: db.nowSql },
          )
          await client.query('COMMIT')
          return appended.seq
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw error
        }
      })

    const clients = await Promise.all(Array.from({ length: 25 }, () => connect(db)))
    try {
      const seqs = [
        ...(await Promise.all(clients.map(appendOnce))),
        ...(await Promise.all(clients.map(appendOnce))),
      ]
      assert.equal(seqs.length, 50)
      assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 50 }, (_, index) => index + 1 + opened.openedAtSeq))
    } finally {
      await Promise.all(clients.map((client) => client.release()))
    }
  })
})

test('unregistered kinds are refused; session-scoped kinds require a session', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(db, client)
      await assert.rejects(
        () => db.asRole(client, PRODUCT, () => appendFact(client, id, { kind: 'prompt.sent', payload: {} })),
        (error: unknown) => error instanceof JournalError && error.code === 'unregistered_kind',
      )
      await assert.rejects(
        () => db.asRole(client, PRODUCT, () => appendFact(client, id, { kind: 'session.ended', payload: { reason: 'x' } })),
        (error: unknown) => error instanceof JournalError && error.code === 'session_scoped_required',
      )
      assert.deepEqual(registeredKinds(), ['session.opened', 'session.ended', 'session.provenance'])
    } finally {
      client.release()
    }
  })
})

test('strings matching known token shapes are refused before persistence', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(db, client)
      const session = await openTestSession(db, client, id)
      await assert.rejects(
        () =>
          db.asRole(client, PRODUCT, () =>
            appendFact(client, id, { sessionId: session.sessionId, kind: 'session.provenance', payload: { runtimeIds: { token: 'sk-abcdef123456' } } }),
          ),
        (error: unknown) => error instanceof SecretPatternError,
      )
      const head = await client.query('SELECT count(*)::int AS n FROM workstream_facts WHERE workstream_id = $1', [id])
      assert.equal(head.rows[0]!['n'], 1, 'nothing beyond the birth fact was persisted')
    } finally {
      client.release()
    }
  })
})

test('appends for an unknown Workstream are rejected', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const session = await openTestSession(db, client, await createWorkstream(db, client))
      await assert.rejects(
        () =>
          db.asRole(client, PRODUCT, () =>
            appendFact(client, '00000000-0000-4000-8000-000000000000', {
              sessionId: session.sessionId,
              kind: 'session.provenance',
              payload: { runtimeIds: {} },
            }),
          ),
        (error: unknown) => error instanceof JournalError && error.code === 'unknown_workstream',
      )
    } finally {
      client.release()
    }
  })
})
