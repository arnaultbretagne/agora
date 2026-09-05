import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withTestDatabase } from '@agora/testkit'
import { claimDue, reEnqueueForDrift } from '../src/index.js'
import { author, createWorkstream, ENGINE, intentOf, PRODUCT, workRow } from './support.js'

test('agora_product cannot rewrite immutable Intent history', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      const outcome = await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      assert.equal(outcome.kind, 'created')
      await assert.rejects(
        () =>
          db.asRole(client, PRODUCT, () =>
            client.query("UPDATE workstream_intent_events SET intent = '{\"power\": \"on\"}'::jsonb WHERE workstream_id = $1", [id]),
          ),
        /permission denied/,
      )
      await assert.rejects(
        () => db.asRole(client, PRODUCT, () => client.query('DELETE FROM workstream_intent_events WHERE workstream_id = $1', [id])),
        /permission denied/,
      )
    } finally {
      client.release()
    }
  })
})

test('agora_product cannot finalize: deleting the work row is the engine boundary', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      await assert.rejects(
        () => db.asRole(client, PRODUCT, () => client.query('DELETE FROM workstream_reconciliation_work WHERE workstream_id = $1', [id])),
        /permission denied/,
      )
      await assert.rejects(
        () =>
          db.asRole(client, PRODUCT, () =>
            client.query('UPDATE workstreams SET owner_principal = $2 WHERE id = $1', [id, 'other@example.com']),
          ),
        /permission denied/,
      )
    } finally {
      client.release()
    }
  })
})

test('agora_engine manages the workset but never writes desired state', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      await assert.rejects(
        () =>
          db.asRole(client, ENGINE, () =>
            client.query(
              "INSERT INTO workstream_intent_events (workstream_id, intent_seq, intent, request_key, principal, revision_set) VALUES ($1, 99, '{}'::jsonb, 'k', 'p', '{}'::jsonb)",
              [id],
            ),
          ),
        /permission denied/,
      )
      await assert.rejects(
        () => db.asRole(client, ENGINE, () => client.query("UPDATE workstreams SET title = 'x' WHERE id = $1", [id])),
        /permission denied/,
      )
      await assert.rejects(
        () =>
          db.asRole(client, ENGINE, () =>
            client.query("INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES (gen_random_uuid(), 'a', 'b', 'c')"),
          ),
        /permission denied/,
      )
      const claimed = await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 5, leaseMs: 1_000, nowSql: db.nowSql }))
      assert.equal(claimed.length, 1)
    } finally {
      client.release()
    }
  })
})

test('the work row trigger forbids intent_seq regression on update', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on')))
      await assert.rejects(
        () =>
          db.asRole(client, ENGINE, () =>
            client.query('UPDATE workstream_reconciliation_work SET intent_seq = 1 WHERE workstream_id = $1', [id]),
          ),
        /intent_seq cannot decrease/,
      )
    } finally {
      client.release()
    }
  })
})

test('drift wake keeps the latest intent_seq, allocates a fresh generation and emits the tick', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    const listener = await db.pool.connect()
    await listener.query('LISTEN workstream_reconciliation')
    const notified = new Promise<string>((resolve) => {
      listener.on('notification', (message: { channel: string }) => resolve(message.channel))
    })
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      const before = await workRow(client, id)
      const outcome = await db.asRole(listener, ENGINE, () => reEnqueueForDrift(db.pool, id, { nowSql: db.nowSql }))
      assert.equal(outcome, 'woke')
      const after = await workRow(client, id)
      assert.equal(after!['intent_seq'], before!['intent_seq'])
      assert.ok(Number(after!['work_generation']) > Number(before!['work_generation']))
      assert.equal(await notified, 'workstream_reconciliation')
    } finally {
      listener.release()
      client.release()
    }
  })
})
