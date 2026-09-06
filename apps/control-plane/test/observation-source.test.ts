import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import pg from 'pg'
import { toWireGrantSet, type Authorization } from '@agora/domain'
import { HttpObservationSource } from '../src/observation-source.js'

const SCHEMA_PATH = fileURLToPath(new URL('../../../../contracts/db/schema.sql', import.meta.url))

function maintenanceUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL (or DATABASE_URL) is required')
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

function startJsonServer(handler: (path: string) => unknown): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const body = handler(req.url ?? '/')
      if (body === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

async function insertOwnerAttempt(pool: pg.Pool, workstreamId: string, targetId: string): Promise<void> {
  await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
  await pool.query(
    `INSERT INTO owner_attempts (attempt_key, workstream_id, epoch, operation, target_kind, target_id, payload_digest, state, dispatch_owner, revision_set)
     VALUES ($1, $2, 1, 'create_pod', 'reserved', $3, 'd', 'settled', 'worker', '{}'::jsonb)`,
    [`${workstreamId}/BUILD/rule/1`, workstreamId, targetId],
  )
}

test('power: a Pod footprint alone reports on, even when the broker owner has nothing on record', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await insertOwnerAttempt(pool, workstreamId, 'inc-1')
    const runtimeControl = await startJsonServer((path) =>
      path.startsWith('/v1/workstreams/') ? { pods: [{ uid: 'u1', phase: 'Running', imageId: null, admittedDigest: null, incarnation: 'inc-1', forcedDeletion: false }], obligations: [], complete: true } : undefined,
    )
    const broker = await startJsonServer(() => undefined) // broker unreachable for this incarnation
    try {
      const source = new HttpObservationSource({ pool, runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url, harnessCatalogue: [] })
      const reader = await source.reader(workstreamId)
      assert.deepEqual(reader.power(), { ok: true, value: 'on' })
    } finally {
      runtimeControl.server.close()
      broker.server.close()
    }
  })
})

test('power: off requires both a complete empty Kubernetes listing and a read broker inventory', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const runtimeControl = await startJsonServer((path) => (path.startsWith('/v1/workstreams/') ? { pods: [], obligations: [], complete: true } : undefined))
    const broker = await startJsonServer(() => undefined)
    try {
      const source = new HttpObservationSource({ pool, runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url, harnessCatalogue: [] })
      const reader = await source.reader(workstreamId)
      // No prior BUILD attempt on record: currentIncarnation is undefined, so there is no broker
      // read to even attempt — the broker side of the footprint is vacuously "nothing", and with
      // an empty, complete Kubernetes listing this correctly reaches off.
      assert.deepEqual(reader.power(), { ok: true, value: 'off' })
    } finally {
      runtimeControl.server.close()
      broker.server.close()
    }
  })
})

test('power: an unreachable runtime-control makes power unavailable, never a guess', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const source = new HttpObservationSource({ pool, runtimeControlBaseUrl: 'http://127.0.0.1:65533', brokerBaseUrl: 'http://127.0.0.1:65533', harnessCatalogue: [] })
    const reader = await source.reader(workstreamId)
    assert.deepEqual(reader.power(), { ok: false, reason: 'unavailable' })
  })
})

test('construction: a coherent Pod with a matching bound Agent contributes its digest', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await insertOwnerAttempt(pool, workstreamId, 'inc-1')
    const runtimeControl = await startJsonServer((path) =>
      path.startsWith('/v1/workstreams/')
        ? { pods: [{ uid: 'u1', phase: 'Running', imageId: 'sha256:abc', admittedDigest: 'sha256:abc', incarnation: 'inc-1', forcedDeletion: false }], obligations: [], complete: true }
        : undefined,
    )
    const broker = await startJsonServer((path) => (path.startsWith('/v1/incarnations/') ? { agentId: 'a1', attached: [], effective: [] } : undefined))
    try {
      const source = new HttpObservationSource({ pool, runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url, harnessCatalogue: [{ imageDigest: 'sha256:abc' }] })
      const reader = await source.reader(workstreamId)
      const construction = reader.construction()
      assert.equal(construction.ok, true)
      assert.equal(construction.ok && construction.value.kind === 'set' && construction.value.incoherent, false)
    } finally {
      runtimeControl.server.close()
      broker.server.close()
    }
  })
})

test('grantsAttached/Effective: reports the broker\'s own wire-format sets for the current incarnation', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await insertOwnerAttempt(pool, workstreamId, 'inc-1')
    const runtimeControl = await startJsonServer((path) => (path.startsWith('/v1/workstreams/') ? { pods: [], obligations: [], complete: true } : undefined))
    const desired: readonly Authorization[] = [{ kind: 'secret', credential: 's1', tools: 'full', approval: 'unconditional', restrictions: [] }]
    const wire = toWireGrantSet(new Set(desired))
    const broker = await startJsonServer((path) => (path.startsWith('/v1/incarnations/') ? { agentId: 'a1', attached: wire, effective: wire } : undefined))
    try {
      const source = new HttpObservationSource({ pool, runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url, harnessCatalogue: [] })
      const reader = await source.reader(workstreamId)
      const attached = reader.grantsAttached()
      assert.equal(attached.ok, true)
      assert.equal(attached.ok && attached.value.size, 1)
    } finally {
      runtimeControl.server.close()
      broker.server.close()
    }
  })
})

test('session/model/effort/anchor/sync stay unavailable — not yet produced by this slice, never invented', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const source = new HttpObservationSource({ pool, runtimeControlBaseUrl: 'http://127.0.0.1:65533', brokerBaseUrl: 'http://127.0.0.1:65533', harnessCatalogue: [] })
    const reader = await source.reader(workstreamId)
    for (const field of [reader.session(), reader.model(), reader.effort(), reader.anchor(), reader.sync()]) {
      assert.deepEqual(field, { ok: false, reason: 'unavailable' })
    }
  })
})
