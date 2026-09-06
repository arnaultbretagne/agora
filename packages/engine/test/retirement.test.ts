import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { withTestDatabase, RuntimeControlFake, type TestDatabase } from '@agora/testkit'
import { OwnerClient } from '@agora/owner-requests'
import { dispatchAttempt, hasUnresolvedAttempts, issueEpoch, reserveAttempt, retireTarget } from '../src/index.js'

const WORKSTREAM = '11111111-1111-4111-8111-111111111111'

async function connect(db: TestDatabase): Promise<pg.PoolClient> {
  return db.pool.connect()
}

async function setup(db: TestDatabase, client: pg.PoolClient): Promise<void> {
  await client.query("INSERT INTO workstreams (id, owner_principal, title, create_request_key, head_seq) VALUES ($1, 'o', 't', 'k', 0)", [WORKSTREAM])
}

async function reserveAndDispatch(
  db: TestDatabase,
  client: pg.PoolClient,
  owner: RuntimeControlFake,
  operation: string,
  target: { kind: 'concrete' | 'reserved'; id: string },
  epoch = 1,
): Promise<{ attemptKey: string; responseKind: string }> {
  const reservation = await db.asRole(client, 'agora_engine', () =>
    (async () => {
      await client.query('BEGIN')
      const reserved = await reserveAttempt(client, {
        workstreamId: WORKSTREAM,
        epoch,
        operation,
        target,
        payload: {},
        revisionSet: { catalogue: 'stub-s2' },
        dispatchOwner: 'worker-a',
        positive: operation === 'create_pod' || operation === 'attach_grant',
      })
      await client.query('COMMIT')
      return reserved
    })(),
  )
  const client_transport = async (request: Parameters<OwnerClient['submit']>[0]): Promise<Awaited<ReturnType<OwnerClient['submit']>>['response']> => owner.handle(request)
  const submitted = await new OwnerClient(client_transport).submit({
    epoch,
    workstreamId: WORKSTREAM,
    attemptKey: reservation.attemptKey,
    operation: reservation.operation,
    target: reservation.target,
    payload: {},
    payloadDigest: reservation.payloadDigest,
    revisionSet: { catalogue: 'stub-s2' },
  })
  return { attemptKey: reservation.attemptKey, responseKind: submitted.response.kind }
}

test('ENGINE-007: a late creation after off is discoverable, cleaned and never activated; off stays blocked while unresolved', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      await setup(db, client)
      const owner = new RuntimeControlFake({ dropResponse: (request) => request.operation === 'create_pod' })
      // BUILD dispatched, response lost: possibly accepted, so the reservation gates everything.
      const build = await reserveAndDispatch(db, client, owner, 'create_pod', { kind: 'reserved', id: 'slot-1' })
      assert.equal(build.responseKind, 'unknown')
      assert.equal(await hasUnresolvedAttempts(db.pool, WORKSTREAM), true, 'off cannot finalize while the creation is unresolved')

      // Off wins: the target is retired, the unresolved attempt superseded, cleanup authorized.
      await db.asRole(client, 'agora_engine', () => retireTarget(client, WORKSTREAM, 'reserved', 'slot-1', 'extinguished'))
      assert.equal(await hasUnresolvedAttempts(db.pool, WORKSTREAM), false, 'retirement resolves the unresolved attempt by superseding it')

      // The late completion arrives AFTER retirement: the owner records it as the same completed
      // occurrence (idempotent discovery — no second Pod), and cleanup on the target stays allowed.
      const late = await owner.redeliver({
        epoch: 1,
        workstreamId: WORKSTREAM,
        attemptKey: build.attemptKey,
        operation: 'create_pod',
        target: { kind: 'reserved', id: 'slot-1' },
        payload: {},
        payloadDigest: 'x',
        revisionSet: {},
      })
      assert.equal(late?.kind, 'completed', 'the late effect is discoverable by its pre-recorded correlation')
      const cleanup = await reserveAndDispatch(db, client, owner, 'cleanup_pod', { kind: 'concrete', id: 'pod:slot-1' })
      assert.equal(cleanup.responseKind, 'completed', 'cleanup on the retired target stays authorized')
      assert.equal(owner.targets().some((target) => target.present), false, 'the late effect is cleaned, never activated')
    } finally {
      client.release()
    }
  })
})

test('ENGINE-009: an old cleanup returns after a replacement — the original target is cleaned, the successor untouched', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      await setup(db, client)
      const owner = new RuntimeControlFake()
      // The original incarnation pod:slot-1 was retired; a successor pod:slot-2 exists.
      await db.asRole(client, 'agora_engine', () => retireTarget(client, WORKSTREAM, 'concrete', 'pod:slot-1', 'replaced'))
      await owner.handle({
        epoch: 2,
        workstreamId: WORKSTREAM,
        attemptKey: 'successor/create/1',
        operation: 'create_pod',
        target: { kind: 'reserved', id: 'slot-2' },
        payload: {},
        payloadDigest: 'x',
        revisionSet: {},
      })

      // The old TURN_OFF cleanup for the ORIGINAL uid arrives late.
      const cleanup = await reserveAndDispatch(db, client, owner, 'cleanup_pod', { kind: 'concrete', id: 'pod:slot-1' }, 2)
      assert.equal(cleanup.responseKind, 'completed')
      assert.equal(owner.targets().some((target) => target.id === 'pod:slot-2' && target.present), true, 'the successor is untouched')
    } finally {
      client.release()
    }
  })
})

test('ENGINE-018: the database reservation commits but the owner activation fails — execution stays gated', async () => {
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
            operation: 'attach_grant',
            target: { kind: 'concrete', id: 'agent:1' },
            payload: {},
            revisionSet: {},
            dispatchOwner: 'worker-a',
            positive: true,
          })
          await client.query('COMMIT')
          return reserved
        })(),
      )
      const submitted = await new OwnerClient(async (request) => owner.handle(request)).submit({
        epoch: 1,
        workstreamId: WORKSTREAM,
        attemptKey: reservation.attemptKey,
        operation: reservation.operation,
        target: reservation.target,
        payload: {},
        payloadDigest: reservation.payloadDigest,
        revisionSet: {},
      })
      assert.equal(submitted.response.kind, 'unknown')
      const failClient = await connect(db)
      try {
        await db.asRole(failClient, 'agora_engine', () =>
          failClient.query("UPDATE owner_attempts SET state = 'unknown', settled_at = now() WHERE attempt_key = $1", [reservation.attemptKey]),
        )
      } finally {
        failClient.release()
      }
      assert.equal(await hasUnresolvedAttempts(db.pool, WORKSTREAM), true, 'database success is not delivery: the gate stays closed')

      // A takeover (recovery) resolves the limbo: the epoch is re-issued and the attempt tracked.
      const issued = await db.asRole(failClient, 'agora_engine', () => issueEpoch(failClient, WORKSTREAM, 'worker-b', db.nowSql))
      assert.equal(issued.takeoverCount, 1)
    } finally {
      client.release()
    }
  })
})
