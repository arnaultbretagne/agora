// No @agora/testkit here on purpose: testkit depends on this package (its fakes embed the real
// decideOwnerRequest/recordOwnerResponse), so importing testkit back from here is a package cycle
// — harmless until something actually forces both sides of it through the type checker at once,
// at which point tsc's own declaration output collides with itself (TS5055). A trimmed, local
// database bootstrap avoids the cycle entirely.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import pg from 'pg'
import { PgOwnerGate, payloadDigest, type OwnerRequest } from '../src/index.js'

const SCHEMA_PATH = fileURLToPath(new URL('../../../../contracts/db/schema.sql', import.meta.url))

function maintenanceUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL (or DATABASE_URL) is required: owner-requests tests run against real PostgreSQL')
  return url
}

async function withTestDatabase<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const database = `agora_test_${randomUUID().replaceAll('-', '')}`
  const maintenance = new pg.Pool({ connectionString: maintenanceUrl(), max: 2 })
  try {
    await maintenance.query(`CREATE DATABASE "${database}"`)
  } finally {
    await maintenance.end()
  }
  const testUrl = new URL(maintenanceUrl())
  testUrl.pathname = `/${database}`
  const pool = new pg.Pool({ connectionString: testUrl.toString() })
  try {
    await pool.query(readFileSync(SCHEMA_PATH, 'utf8'))
    return await run(pool)
  } finally {
    await pool.end()
    const cleanup = new pg.Pool({ connectionString: maintenanceUrl(), max: 2 })
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    } finally {
      await cleanup.end()
    }
  }
}

async function insertWorkstream(pool: pg.Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [id, 'p', 't', randomUUID()])
}

function request(overrides: Partial<OwnerRequest> = {}): OwnerRequest {
  const payload = overrides.payload ?? { harnessId: 'claude-code' }
  return {
    epoch: 1,
    workstreamId: '00000000-0000-4000-8000-000000000001',
    attemptKey: 'attempt-1',
    operation: 'create_pod',
    target: { kind: 'reserved', id: 'inc-1' },
    payload,
    payloadDigest: payloadDigest(payload),
    revisionSet: {},
    ...overrides,
  }
}

test('PgOwnerGate: a stale epoch is rejected before any downstream call', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await insertWorkstream(pool, workstreamId)
    const gate = new PgOwnerGate(pool, 'runtime-control')
    const req = request({ workstreamId, epoch: 5 })
    await gate.record(req, { kind: 'completed', result: {} })

    const older = await gate.decide(request({ workstreamId, epoch: 2, attemptKey: 'attempt-2' }))
    assert.deepEqual(older, { kind: 'respond', response: { kind: 'rejected_stale_epoch', recordedEpoch: 5 } })
  })
})

test('PgOwnerGate: a reused attempt key with the same payload replays the recorded response (idempotent retry)', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await insertWorkstream(pool, workstreamId)
    const gate = new PgOwnerGate(pool, 'runtime-control')
    const req = request({ workstreamId })
    await gate.record(req, { kind: 'completed', result: { podName: 'agora-x' } })

    const replay = await gate.decide(req)
    assert.deepEqual(replay, { kind: 'respond', response: { kind: 'completed', result: { podName: 'agora-x' } } })
  })
})

test('PgOwnerGate: a reused attempt key with a different payload is rejected_key_mismatch', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await insertWorkstream(pool, workstreamId)
    const gate = new PgOwnerGate(pool, 'runtime-control')
    const req = request({ workstreamId })
    await gate.record(req, { kind: 'completed', result: {} })

    const mismatched = request({ workstreamId, payload: { harnessId: 'other' } })
    const decision = await gate.decide({ ...mismatched, payloadDigest: payloadDigest(mismatched.payload) })
    assert.equal(decision.kind, 'respond')
    assert.equal(decision.kind === 'respond' && decision.response.kind, 'rejected_key_mismatch')
  })
})

test('PgOwnerGate: a retired target refuses a new positive operation but stays open to processing', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await insertWorkstream(pool, workstreamId)
    const gate = new PgOwnerGate(pool, 'runtime-control')
    await gate.retire(workstreamId, 'inc-1')

    const decision = await gate.decide(request({ workstreamId, target: { kind: 'concrete', id: 'inc-1' } }))
    assert.equal(decision.kind, 'respond')
    assert.equal(decision.kind === 'respond' && decision.response.kind, 'rejected_stale_epoch', 'retired concrete targets refuse positive operations forever')

    const cleanup = await gate.decide(request({ workstreamId, operation: 'cleanup_pod', target: { kind: 'concrete', id: 'inc-1' } }))
    assert.equal(cleanup.kind, 'process', 'cleanup on an already-retired concrete target stays authorized')
  })
})

test("two owners sharing the same tables never see each other's epoch, attempts or retired targets", async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await insertWorkstream(pool, workstreamId)
    const runtimeControl = new PgOwnerGate(pool, 'runtime-control')
    const broker = new PgOwnerGate(pool, 'broker')

    await runtimeControl.record(request({ workstreamId, epoch: 9 }), { kind: 'completed', result: {} })
    const brokerDecision = await broker.decide(request({ workstreamId, epoch: 1, attemptKey: 'attempt-2' }))
    assert.equal(brokerDecision.kind, 'process', "runtime-control's epoch 9 must not leak into broker's own record for the same Workstream")

    await runtimeControl.retire(workstreamId, 'shared-target-id')
    const brokerOnSameTarget = await broker.decide(request({ workstreamId, target: { kind: 'concrete', id: 'shared-target-id' }, attemptKey: 'attempt-3' }))
    assert.equal(brokerOnSameTarget.kind, 'process', 'runtime-control retiring a target id must not retire it for broker too')
  })
})
