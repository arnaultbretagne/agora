import assert from 'node:assert/strict'
import { test } from 'node:test'
import { advanceClock, withTestDatabase } from '@agora/testkit'
import { claimDue, finalize, reEnqueueForDrift, release, renew, reschedule } from '../src/index.js'
import { author, createWorkstream, ENGINE, intentOf, PRODUCT, workRow } from './support.js'

test('claiming stamps a token and lease; an active lease blocks a second claim until it expires', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      const first = (await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql })))[0]!
      assert.ok(first, 'the due row must be claimable')
      assert.ok(first.claimToken)
      assert.ok(first.leaseUntil.getTime() > first.dueAt.getTime())
      const secondBatch = await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql }))
      assert.equal(secondBatch.length, 0)
      await db.advanceClock(61_000)
      const thirdBatch = await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql }))
      assert.equal(thirdBatch.length, 1)
      assert.notEqual(thirdBatch[0]!.claimToken, first!.claimToken)
    } finally {
      client.release()
    }
  })
})

test('renew, release and reschedule compare the exact claim token and generation', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      const claimed = (await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 5_000, nowSql: db.nowSql })))[0]!
      const ref = { workstreamId: claimed.workstreamId, claimToken: claimed.claimToken, workGeneration: claimed.workGeneration }
      assert.equal(await db.asRole(client, ENGINE, () => renew(db.pool, ref, 30_000, { nowSql: db.nowSql })), true)
      const forged = { ...ref, claimToken: '00000000-0000-4000-8000-000000000000' }
      assert.equal(await db.asRole(client, ENGINE, () => renew(db.pool, forged, 30_000, { nowSql: db.nowSql })), false)
      assert.equal(
        await db.asRole(client, ENGINE, () => reschedule(db.pool, forged, { delayMs: 1_000, attemptCount: 1, blockingCause: null, lastError: null, nowSql: db.nowSql })),
        false,
      )
      assert.equal(await db.asRole(client, ENGINE, () => release(db.pool, ref, { nowSql: db.nowSql })), true)
      const row = await workRow(client, id)
      assert.equal(row!['claim_token'], null)
      assert.equal(row!['lease_until'], null)
    } finally {
      client.release()
    }
  })
})

test('release with dueNow makes the row immediately due for the continuation tick', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      const claimed = (await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql })))[0]!
      await db.asRole(client, ENGINE, () => reschedule(db.pool, claimed, { delayMs: 500_000, attemptCount: 1, blockingCause: null, lastError: null, nowSql: db.nowSql }))
      const row = await workRow(client, id)
      assert.ok((row!['due_at'] as Date).getTime() > Date.now())
      await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql }))
      await db.advanceClock(501_000)
      const reclaimed = await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql }))
      assert.equal(reclaimed.length, 1)
      await db.asRole(client, ENGINE, () => release(db.pool, reclaimed[0]!, { dueNow: true, nowSql: db.nowSql }))
      const after = await client.query('SELECT due_at <= agora_test.now() AS due FROM workstream_reconciliation_work WHERE workstream_id = $1', [id])
      assert.equal(after.rows[0]!['due'], true)
    } finally {
      client.release()
    }
  })
})

test('ENGINE-003: an old pass cannot finalize after a newer Intent commits', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off'), 'k1'))
      const claimed = (await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql })))[0]!
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on'), 'k2'))
      const finalized = await db.asRole(client, ENGINE, () => finalize(db.pool, claimed))
      assert.equal(finalized, false)
      const row = await workRow(client, id)
      assert.ok(row, 'the newer obligation must survive')
      assert.equal(row!['intent_seq'], 2)
      assert.equal(row!['work_generation'], 2)
    } finally {
      client.release()
    }
  })
})

test('ENGINE-004: a drift wake during finalization survives the old finalize', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      const claimed = (await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql })))[0]!
      await db.asRole(client, ENGINE, () => reEnqueueForDrift(db.pool, id, { nowSql: db.nowSql }))
      const finalized = await db.asRole(client, ENGINE, () => finalize(db.pool, claimed))
      assert.equal(finalized, false)
      const row = await workRow(client, id)
      assert.ok(row)
      assert.equal(row!['intent_seq'], claimed.intentSeq)
      assert.ok(Number(row!['work_generation']) > claimed.workGeneration)
      assert.equal(row!['claim_token'], null)
    } finally {
      client.release()
    }
  })
})

test('ENGINE-005: a deleted and recreated work row rejects the old generation and token (ABA)', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off'), 'k1'))
      const first = (await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql })))[0]!
      await client.query('DELETE FROM workstream_reconciliation_work WHERE workstream_id = $1', [id])
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on'), 'k2'))
      const recreated = await workRow(client, id)
      assert.ok(Number(recreated!['work_generation']) > first.workGeneration)
      assert.equal(await db.asRole(client, ENGINE, () => finalize(db.pool, first)), false)
      assert.equal(await db.asRole(client, ENGINE, () => renew(db.pool, first, 30_000, { nowSql: db.nowSql })), false)
      const row = await workRow(client, id)
      assert.equal(row!['intent_seq'], 2)
    } finally {
      client.release()
    }
  })
})

test('ENGINE-006: an expired claim transfers; the old owner cannot renew or finalize', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      const first = (await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 1_000, nowSql: db.nowSql })))[0]!
      await db.advanceClock(2_000)
      const secondBatch = await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql }))
      assert.equal(secondBatch.length, 1)
      const second = secondBatch[0]!
      assert.notEqual(second.claimToken, first.claimToken)
      assert.equal(await db.asRole(client, ENGINE, () => renew(db.pool, first, 30_000, { nowSql: db.nowSql })), false)
      assert.equal(await db.asRole(client, ENGINE, () => finalize(db.pool, first)), false)
      assert.equal(await db.asRole(client, ENGINE, () => renew(db.pool, second, 30_000, { nowSql: db.nowSql })), true)
      assert.equal(await db.asRole(client, ENGINE, () => finalize(db.pool, second)), true)
      const row = await workRow(client, id)
      assert.equal(row, null)
    } finally {
      client.release()
    }
  })
})

test('finalization by the engine removes the row for the exact generation only', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      const claimed = (await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql })))[0]!
      assert.equal(await db.asRole(client, ENGINE, () => finalize(db.pool, claimed)), true)
      const row = await workRow(client, id)
      assert.equal(row, null)
    } finally {
      client.release()
    }
  })
})

test('a drift wake for a Workstream absent from the workset re-enqueues its latest Intent', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      await client.query('DELETE FROM workstream_reconciliation_work WHERE workstream_id = $1', [id])
      const outcome = await db.asRole(client, ENGINE, () => reEnqueueForDrift(db.pool, id, { nowSql: db.nowSql }))
      assert.equal(outcome, 'enqueued')
      const row = await workRow(client, id)
      assert.equal(row!['intent_seq'], 1)
      assert.equal(await db.asRole(client, ENGINE, () => reEnqueueForDrift(db.pool, id, { nowSql: db.nowSql })), 'woke')
      assert.equal(await db.asRole(client, ENGINE, () => reEnqueueForDrift(db.pool, crypto.randomUUID(), { nowSql: db.nowSql })), 'unknown_workstream')
    } finally {
      client.release()
    }
  })
})

test('notifications do not make backed-off work eligible before its due time', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      const claimed = (await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql })))[0]!
      await db.asRole(client, ENGINE, () =>
        reschedule(db.pool, claimed, { delayMs: 60_000, attemptCount: 1, blockingCause: null, lastError: null, nowSql: db.nowSql }),
      )
      await db.pool.query('NOTIFY workstream_reconciliation')
      const batch = await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql }))
      assert.equal(batch.length, 0)
      await advanceClock(db.pool, 60_000)
      const afterDue = await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 60_000, nowSql: db.nowSql }))
      assert.equal(afterDue.length, 1)
    } finally {
      client.release()
    }
  })
})
