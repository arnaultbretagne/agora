import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { withTestDatabase, RuntimeControlFake, type TestDatabase } from '@agora/testkit'
import { OwnerClient } from '@agora/owner-requests'
import {
  dispatchAttempt,
  hasUnresolvedAttempts,
  issueEpoch,
  markAttemptDispatched,
  markAttemptUnknown,
  reserveAttempt,
  AttemptConflictError,
} from '../src/index.js'

async function connect(db: TestDatabase): Promise<pg.PoolClient> {
  return db.pool.connect()
}

const WORKSTREAM = '11111111-1111-4111-8111-111111111111'

async function setup(db: TestDatabase, client: pg.PoolClient): Promise<void> {
  await client.query("INSERT INTO workstreams (id, owner_principal, title, create_request_key, head_seq) VALUES ($1, 'o', 't', 'k', 0)", [WORKSTREAM])
}

test('a reservation commits before the owner call; no transaction spans the transport', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      await setup(db, client)
      const owner = new RuntimeControlFake()
      const events: string[] = []
      const reservation = await db.asRole(client, 'agora_engine', () =>
        (async () => {
          await client.query('BEGIN')
          const reserved = await reserveAttempt(client, {
            workstreamId: WORKSTREAM,
            epoch: 1,
            operation: 'create_pod',
            target: { kind: 'reserved', id: 'slot-1' },
            payload: { harness: 'claude-code' },
            revisionSet: { catalogue: 'stub-s2' },
            dispatchOwner: 'worker-a',
            positive: true,
          })
          await client.query('COMMIT')
          events.push('reservation-committed')
          return reserved
        })(),
      )
      assert.equal(reservation.state, 'reserved')

      const client2 = await connect(db)
      try {
        const { settled } = await dispatchAttempt(
          db.pool,
          reservation,
          { operation: reservation.operation, payload: { harness: 'claude-code' }, revisionSet: { catalogue: 'stub-s2' } },
          async (request) => {
            events.push('transport-called')
            return owner.handle(request)
          },
        )
        assert.equal(settled, true)
        events.push('settled')
      } finally {
        client2.release()
      }
      assert.deepEqual(events, ['reservation-committed', 'transport-called', 'settled'])
      const row = (await client.query('SELECT state FROM owner_attempts WHERE workstream_id = $1', [WORKSTREAM])).rows[0]!
      assert.equal(row['state'], 'settled')
    } finally {
      client.release()
    }
  })
})

test('ENGINE-008: a lost BUILD response leaves the reservation blocking a second create and off finalization', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      await setup(db, client)
      const owner = new RuntimeControlFake({ dropResponse: () => true })
      const reservation = await db.asRole(client, 'agora_engine', () =>
        (async () => {
          await client.query('BEGIN')
          const reserved = await reserveAttempt(client, {
            workstreamId: WORKSTREAM,
            epoch: 1,
            operation: 'create_pod',
            target: { kind: 'reserved', id: 'slot-1' },
            payload: { harness: 'claude-code' },
            revisionSet: { catalogue: 'stub-s2' },
            dispatchOwner: 'worker-a',
            positive: true,
          })
          await client.query('COMMIT')
          return reserved
        })(),
      )
      const submitted = await new OwnerClient(async (request) => owner.handle(request)).submit({
        epoch: reservation.epoch,
        workstreamId: reservation.workstreamId,
        attemptKey: reservation.attemptKey,
        operation: reservation.operation,
        target: reservation.target,
        payload: { harness: 'claude-code' },
        payloadDigest: reservation.payloadDigest,
        revisionSet: { catalogue: 'stub-s2' },
      })
      assert.equal(submitted.response.kind, 'unknown', 'the lost response resolves to unknown at the caller')
      await db.asRole(client, 'agora_engine', () => markAttemptUnknown(client, reservation.attemptKey))

      // The owner DID complete (possibly accepted); the engine's reservation blocks a second create…
      await assert.rejects(
        () =>
          db.asRole(client, 'agora_engine', () =>
            (async () => {
              await client.query('BEGIN')
              try {
                return await reserveAttempt(client, {
                  workstreamId: WORKSTREAM,
                  epoch: 1,
                  operation: 'create_pod',
                  target: { kind: 'reserved', id: 'slot-1' },
                  payload: { harness: 'claude-code' },
                  revisionSet: { catalogue: 'stub-s2' },
                  dispatchOwner: 'worker-b',
                  positive: true,
                })
              } finally {
                await client.query('ROLLBACK').catch(() => {})
              }
            })(),
          ),
        (error: unknown) => error instanceof AttemptConflictError,
      )
      // …and blocks off finalization until the attempt is resolved.
      assert.equal(await hasUnresolvedAttempts(db.pool, WORKSTREAM), true)
      // The owner's inventory is NOT empty (the Pod exists, possibly accepted).
      assert.equal(owner.targets().some((target) => target.present && target.kind === 'pod'), true)
    } finally {
      client.release()
    }
  })
})

test('ENGINE-006: claim transfer issues an epoch, tracks the old owner dispatched attempts and the owner rejects the old epoch', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      await setup(db, client)
      const owner = new RuntimeControlFake()
      const reserved = await db.asRole(client, 'agora_engine', () =>
        (async () => {
          await client.query('BEGIN')
          const attempt = await reserveAttempt(client, {
            workstreamId: WORKSTREAM,
            epoch: 0,
            operation: 'create_pod',
            target: { kind: 'reserved', id: 'slot-1' },
            payload: {},
            revisionSet: { catalogue: 'stub-s2' },
            dispatchOwner: 'worker-a',
            positive: true,
          })
          await client.query('COMMIT')
          return attempt
        })(),
      )
      // Worker A dispatched it and is now paused in the network call.
      await db.asRole(client, 'agora_engine', () => markAttemptDispatched(client, reserved.attemptKey, null))
      // The lease is transferred to worker B.
      const issued = await db.asRole(client, 'agora_engine', () => issueEpoch(client, WORKSTREAM, 'worker-b', db.nowSql))
      assert.equal(issued.epoch, 1)
      assert.equal(issued.takeoverCount, 1)
      const attempt = (await client.query('SELECT recovery_owner FROM owner_attempts WHERE workstream_id = $1', [WORKSTREAM])).rows[0]!
      assert.equal(attempt['recovery_owner'], 'worker-b')

      // The old owner rejects anything carrying the pre-takeover epoch once it has seen the new one.
      owner.takeover(issued.epoch)
      const stale = await new OwnerClient(async (request) => owner.handle(request)).submit({
        epoch: 0,
        workstreamId: WORKSTREAM,
        attemptKey: 'old-worker/retry/1',
        operation: 'create_pod',
        target: { kind: 'reserved', id: 'slot-2' },
        payload: {},
        payloadDigest: 'x',
        revisionSet: {},
      })
      assert.equal(stale.response.kind, 'rejected_stale_epoch')
    } finally {
      client.release()
    }
  })
})

test('ENGINE-014: a request resolved under an old revision set is superseded at dispatch', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      await setup(db, client)
      const reservation = await db.asRole(client, 'agora_engine', () =>
        (async () => {
          await client.query('BEGIN')
          const reserved = await reserveAttempt(client, {
            workstreamId: WORKSTREAM,
            epoch: 1,
            operation: 'attach_grant',
            target: { kind: 'concrete', id: 'agent:1' },
            payload: {},
            revisionSet: { catalogue: 'rev-1' },
            dispatchOwner: 'worker-a',
          })
          await client.query('COMMIT')
          return reserved
        })(),
      )
      // The selected revision changed during the tick: dispatch under the new revision is fenced.
      const dispatched = await db.asRole(client, 'agora_engine', () =>
        markAttemptDispatched(client, reservation.attemptKey, { catalogue: 'rev-2' }),
      )
      assert.equal(dispatched, false)
      const row = (await client.query('SELECT state FROM owner_attempts WHERE attempt_key = $1', [reservation.attemptKey])).rows[0]!
      assert.equal(row['state'], 'superseded')
      const sameRevision = await db.asRole(client, 'agora_engine', () =>
        markAttemptDispatched(client, reservation.attemptKey, { catalogue: 'rev-1' }).catch(() => false),
      )
      assert.equal(sameRevision, false, 'a superseded attempt cannot be revived')
    } finally {
      client.release()
    }
  })
})
