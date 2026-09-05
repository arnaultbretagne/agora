import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateIntentShape, type CatalogueView } from '@agora/domain'
import { withTestDatabase } from '@agora/testkit'
import { authorIntent, loadLatestIntentEvent } from '../src/index.js'
import { author, createWorkstream, intentOf, PRODUCT, workRow } from './support.js'

test('authoring appends immutable increasing Intents and coalesces the work row', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      const first = await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on'), 'request-1'))
      const second = await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off'), 'request-2'))
      assert.deepEqual(first, { kind: 'created', intentSeq: 1 })
      assert.deepEqual(second, { kind: 'created', intentSeq: 2 })
      const events = await client.query('SELECT intent_seq, intent FROM workstream_intent_events WHERE workstream_id = $1 ORDER BY intent_seq', [id])
      assert.equal(events.rowCount, 2)
      assert.equal(events.rows[0]!['intent']['power'], 'on')
      assert.equal(events.rows[1]!['intent']['power'], 'off')
      const row = await workRow(client, id)
      assert.equal(row!['intent_seq'], 2)
      assert.equal(row!['attempt_count'], 0)
      assert.equal(row!['claim_token'], null)
    } finally {
      client.release()
    }
  })
})

test('ENGINE-001: two racing authorings get distinct increasing sequences, both events kept, work on the latest', async () => {
  await withTestDatabase(async (db) => {
    const setup = await db.pool.connect()
    const id = await createWorkstream(setup)
    setup.release()
    const clientA = await db.pool.connect()
    const clientB = await db.pool.connect()
    try {
      const [a, b] = await Promise.all([
        db.asRole(clientA, PRODUCT, () => author(db, clientA, id, intentOf('on'), 'key-a')),
        db.asRole(clientB, PRODUCT, () => author(db, clientB, id, intentOf('off'), 'key-b')),
      ])
      const seqs = [a, b].map((outcome) => (outcome.kind === 'created' ? outcome.intentSeq : Number.NaN))
      assert.deepEqual([...seqs].sort((x, y) => x - y), [1, 2])
      const events = await clientA.query('SELECT count(*)::int AS n FROM workstream_intent_events WHERE workstream_id = $1', [id])
      assert.equal(events.rows[0]!['n'], 2)
      const row = await workRow(clientA, id)
      assert.equal(row!['intent_seq'], 2)
    } finally {
      clientA.release()
      clientB.release()
    }
  })
})

test('ENGINE-002: a reused request key with another payload conflicts and writes nothing', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      const first = await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off'), 'same-key'))
      assert.equal(first.kind, 'created')
      const before = await workRow(client, id)
      const conflict = await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on'), 'same-key'))
      assert.equal(conflict.kind, 'conflict')
      const events = await client.query('SELECT count(*)::int AS n FROM workstream_intent_events WHERE workstream_id = $1', [id])
      assert.equal(events.rows[0]!['n'], 1)
      const after = await workRow(client, id)
      assert.equal(after!['intent_seq'], before!['intent_seq'])
      assert.equal(after!['work_generation'], before!['work_generation'])
      assert.equal((after!['updated_at'] as Date).getTime(), (before!['updated_at'] as Date).getTime())
    } finally {
      client.release()
    }
  })
})

test('an identical request-key replay returns the original event and appends nothing', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      const first = await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off'), 'retry-key'))
      assert.equal(first.kind, 'created')
      const replay = await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off'), 'retry-key'))
      assert.equal(replay.kind, 'replayed')
      if (replay.kind === 'replayed') {
        assert.equal(replay.intentSeq, 1)
        const event = await client.query('SELECT created_at FROM workstream_intent_events WHERE workstream_id = $1', [id])
        assert.equal(event.rows[0]!['created_at'].getTime(), replay.createdAt.getTime())
      }
      const events = await client.query('SELECT count(*)::int AS n FROM workstream_intent_events WHERE workstream_id = $1', [id])
      assert.equal(events.rows[0]!['n'], 1)
      const row = await workRow(client, id)
      assert.equal(row!['work_generation'], (await workRow(client, id))!['work_generation'])
    } finally {
      client.release()
    }
  })
})

test('authoring for an unknown Workstream is rejected without writing', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const outcome = await db.asRole(client, PRODUCT, () => author(db, client, randomUUID(), intentOf('off')))
      assert.equal(outcome.kind, 'unknown_workstream')
    } finally {
      client.release()
    }
  })
})

test('the authoring transaction emits the empty NOTIFY tick on commit', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    const listener = await db.pool.connect()
    await listener.query('LISTEN workstream_reconciliation')
    const notified = new Promise<string>((resolve, reject) => {
      listener.on('notification', (message: { channel: string }) => resolve(message.channel))
      setTimeout(() => reject(new Error('no notification was emitted')), 5_000).unref?.()
    })
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      assert.equal(await notified, 'workstream_reconciliation')
    } finally {
      listener.release()
      client.release()
    }
  })
})

test('ENGINE-017 (authoring): an off Intent is accepted with retained selections the retired catalogue rejects', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const id = await createWorkstream(client)
      const retired: CatalogueView = {
        harnesses: new Set(),
        capabilities: new Set(),
        models: () => [],
        efforts: () => [],
      }
      const offShape = validateIntentShape(
        { power: 'off', harness: 'claude-code', capabilities: ['provider.invoke'], model: 'model-a', effort: 'default', persona: 'default' },
        retired,
      )
      assert.equal(offShape.valid, true)
      if (offShape.valid) {
        const outcome = await db.asRole(client, PRODUCT, () =>
          authorIntent(
            client,
            { workstreamId: id, principal: 'owner@example.com', requestKey: 'off-while-retired', intent: offShape.intent, revisionSet: { catalogue: 'stub-s2' } },
            { nowSql: db.nowSql },
          ),
        )
        assert.equal(outcome.kind, 'created')
      }
      const onShape = validateIntentShape(
        { power: 'on', harness: 'claude-code', capabilities: ['provider.invoke'], model: 'model-a', effort: 'default', persona: 'default' },
        retired,
      )
      assert.equal(onShape.valid, false)
    } finally {
      client.release()
    }
  })
})
