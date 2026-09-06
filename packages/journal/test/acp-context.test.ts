import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { bindAcpContext, currentSession, recordBridgeToken } from '../src/index.js'
import { createWorkstream, openTestSession, PRODUCT, withTx } from './support.js'

async function connect(db: TestDatabase): Promise<pg.PoolClient> {
  return db.pool.connect()
}

test('bindAcpContext: records the context id and process generation under the real agora_product role', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await createWorkstream(db, client)
      const opened = await openTestSession(db, client, workstreamId)
      await db.asRole(client, PRODUCT, () => withTx(db, client, () => bindAcpContext(client, opened.sessionId, { contextId: 'ctx-1', processGeneration: 0 })))
      const session = await currentSession(db.pool, workstreamId)
      assert.deepEqual(session, { sessionId: opened.sessionId, podUid: 'pod-a', acpContextId: 'ctx-1', processGeneration: 0, bridgeToken: null })
    } finally {
      client.release()
    }
  })
})

test('bindAcpContext: a later restart rebinds a higher process generation on the same Session (SESSION-A06)', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await createWorkstream(db, client)
      const opened = await openTestSession(db, client, workstreamId)
      await db.asRole(client, PRODUCT, () => withTx(db, client, () => bindAcpContext(client, opened.sessionId, { contextId: 'ctx-1', processGeneration: 0 })))
      await db.asRole(client, PRODUCT, () => withTx(db, client, () => bindAcpContext(client, opened.sessionId, { contextId: 'ctx-2', processGeneration: 1 })))
      const session = await currentSession(db.pool, workstreamId)
      assert.equal(session?.acpContextId, 'ctx-2')
      assert.equal(session?.processGeneration, 1)
    } finally {
      client.release()
    }
  })
})

test('recordBridgeToken: persists the P4 bridge token, never returned alongside anything else it could leak into', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await createWorkstream(db, client)
      const opened = await openTestSession(db, client, workstreamId)
      await db.asRole(client, PRODUCT, () => withTx(db, client, () => recordBridgeToken(client, opened.sessionId, 'token-abc')))
      const session = await currentSession(db.pool, workstreamId)
      assert.equal(session?.bridgeToken, 'token-abc')
    } finally {
      client.release()
    }
  })
})

test('currentSession: null when every Session\'s attribution has ended', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await createWorkstream(db, client)
      await createWorkstream(db, client) // unrelated Workstream, never touched
      const session = await currentSession(db.pool, workstreamId)
      assert.equal(session, null)
    } finally {
      client.release()
    }
  })
})
