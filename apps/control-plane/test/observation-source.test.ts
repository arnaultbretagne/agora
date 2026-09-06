import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import pg from 'pg'
import * as acp from '@agentclientprotocol/sdk'
import { toWireGrantSet, type Authorization } from '@agora/domain'
import { openSession, recordBridgeToken, bindAcpContext } from '@agora/journal'
import type { DuplexByteStream } from '@agora/acp'
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
      const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url, harnessCatalogue: [] })
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
      const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url, harnessCatalogue: [] })
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
    const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: 'http://127.0.0.1:65533', brokerBaseUrl: 'http://127.0.0.1:65533', harnessCatalogue: [] })
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
      const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url, harnessCatalogue: [{ imageDigest: 'sha256:abc' }] })
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
      const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url, harnessCatalogue: [] })
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

test('anchor stays unavailable — S9 scope, never invented', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: 'http://127.0.0.1:65533', brokerBaseUrl: 'http://127.0.0.1:65533', harnessCatalogue: [] })
    const reader = await source.reader(workstreamId)
    assert.deepEqual(reader.anchor(), { ok: false, reason: 'unavailable' })
  })
})

test('sync: no current Session at all reads unavailable, never a guessed range', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: 'http://127.0.0.1:65533', brokerBaseUrl: 'http://127.0.0.1:65533', harnessCatalogue: [] })
    const reader = await source.reader(workstreamId)
    assert.deepEqual(reader.sync(), { ok: false, reason: 'unavailable' })
  })
})

test('sync: a freshly opened Session reads the empty range as current (S8 scope — non-empty ranges are S9)', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await seedLiveSession(pool, workstreamId, 'ctx-1', 0)
    const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: 'http://127.0.0.1:65533', brokerBaseUrl: 'http://127.0.0.1:65533', harnessCatalogue: [] })
    const reader = await source.reader(workstreamId)
    assert.deepEqual(reader.sync(), { ok: true, value: 'current' })
  })
})

// observation.session/model/effort are real, S8 Step 2/3 wiring — see the dedicated tests below (not
// a placeholder like anchor above, even though "no Pod at all" also happens to read unavailable).
test('model/effort: no live Session yet reads unavailable, never a guessed default', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: 'http://127.0.0.1:65533', brokerBaseUrl: 'http://127.0.0.1:65533', harnessCatalogue: [] })
    const reader = await source.reader(workstreamId)
    assert.deepEqual(reader.model(), { ok: false, reason: 'unavailable' })
    assert.deepEqual(reader.effort(), { ok: false, reason: 'unavailable' })
  })
})
test('session: no Pod at all reads unavailable (inapplicable, never inferred)', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: 'http://127.0.0.1:65533', brokerBaseUrl: 'http://127.0.0.1:65533', harnessCatalogue: [] })
    const reader = await source.reader(workstreamId)
    assert.deepEqual(reader.session(), { ok: false, reason: 'unavailable' })
  })
})

test('session: a Running Pod with no bound context yet reads openable from Pod evidence alone', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await insertOwnerAttempt(pool, workstreamId, 'inc-1')
    const runtimeControl = await startJsonServer((path) =>
      path.startsWith('/v1/workstreams/') ? { pods: [{ uid: 'u1', name: 'pod-1', phase: 'Running', imageId: null, admittedDigest: null, incarnation: 'inc-1', forcedDeletion: false, podIP: '10.0.0.1' }], obligations: [], complete: true } : undefined,
    )
    const broker = await startJsonServer(() => undefined)
    try {
      const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url, harnessCatalogue: [] })
      const reader = await source.reader(workstreamId)
      assert.deepEqual(reader.session(), { ok: true, value: 'openable' })
    } finally {
      runtimeControl.server.close()
      broker.server.close()
    }
  })
})

interface RuntimeControlWithEvidence {
  readonly server: Server
  readonly url: string
}

/** Same shape as startJsonServer's stub, plus the per-Pod evidence endpoint session()'s freshness
 * check depends on (processGeneration) — kept separate since only the session tests below need it. */
function startRuntimeControlWithEvidence(pods: readonly unknown[], processGeneration: number): Promise<RuntimeControlWithEvidence> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? ''
      if (url.startsWith('/v1/workstreams/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ pods, obligations: [], complete: true }))
        return
      }
      if (url.endsWith('/evidence')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ processGeneration }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

/** A real ACP agent (the pinned SDK) over an in-process duplex — proves session-probe.ts's own
 * ACP-level logic for real, the same reasoning as verbs/start.test.ts's identical helper (ADR 0001
 * keeps this duplicated rather than shared with harnesses/claude-code's bridge-server tests). */
function fakeAcpAgent(configOptions: readonly { id: string; currentValue: string }[] = []): { readonly clientStream: DuplexByteStream; readonly close: () => void } {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()
  const clientStream: DuplexByteStream = { writable: aToB.writable, readable: bToA.readable }
  const agentStream: DuplexByteStream = { writable: bToA.writable, readable: aToB.readable }
  const agentApp = acp.agent({ name: 'test-fake-agent' })
  agentApp.onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }))
  agentApp.onRequest(acp.methods.agent.session.resume, () => ({ configOptions: configOptions.map((o) => ({ ...o, type: 'select', name: o.id, options: [] })) }))
  const agentConnection = agentApp.connect(acp.ndJsonStream(agentStream.writable, agentStream.readable))
  return { clientStream, close: () => agentConnection.close?.() }
}

async function seedLiveSession(pool: pg.Pool, workstreamId: string, acpContextId: string, processGeneration: number): Promise<void> {
  await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const opened = await openSession(client, workstreamId, { podUid: 'pod-a', provenance: {} })
    await client.query('COMMIT')
    await client.query('BEGIN')
    await recordBridgeToken(client, opened.sessionId, 'bridge-token-1')
    await client.query('COMMIT')
    await client.query('BEGIN')
    await bindAcpContext(client, opened.sessionId, { contextId: acpContextId, processGeneration })
    await client.query('COMMIT')
  } finally {
    client.release()
  }
}

test('session: a bound context at the current generation, verified by a fresh resume, reads live', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await seedLiveSession(pool, workstreamId, 'ctx-1', 0)
    const runtimeControl = await startRuntimeControlWithEvidence(
      [{ uid: 'u1', name: 'pod-1', phase: 'Running', imageId: null, admittedDigest: null, incarnation: null, forcedDeletion: false, podIP: '10.0.0.1' }],
      0,
    )
    const broker = await startJsonServer(() => undefined)
    const agent = fakeAcpAgent()
    try {
      const source = new HttpObservationSource({
        pool,
        productPool: pool,
        bridgePort: 8765,
        runtimeControlBaseUrl: runtimeControl.url,
        brokerBaseUrl: broker.url,
        harnessCatalogue: [],
        connect: async () => ({ connectionId: 'c1', stream: agent.clientStream, close: async () => agent.close(), closed: Promise.resolve() }),
      })
      const reader = await source.reader(workstreamId)
      assert.deepEqual(reader.session(), { ok: true, value: 'live' })
    } finally {
      runtimeControl.server.close()
      broker.server.close()
    }
  })
})

test('session: a context bound at an OLDER generation (the process restarted) reads unusable, without even attempting to resume it', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await seedLiveSession(pool, workstreamId, 'ctx-1', 0)
    // Evidence now reports generation 1 — a restart happened since ctx-1 was bound.
    const runtimeControl = await startRuntimeControlWithEvidence(
      [{ uid: 'u1', name: 'pod-1', phase: 'Running', imageId: null, admittedDigest: null, incarnation: null, forcedDeletion: false, podIP: '10.0.0.1' }],
      1,
    )
    const broker = await startJsonServer(() => undefined)
    let connectCalls = 0
    try {
      const source = new HttpObservationSource({
        pool,
        productPool: pool,
        bridgePort: 8765,
        runtimeControlBaseUrl: runtimeControl.url,
        brokerBaseUrl: broker.url,
        harnessCatalogue: [],
        connect: async () => {
          connectCalls += 1
          throw new Error('should never be called: the generation mismatch is already conclusive')
        },
      })
      const reader = await source.reader(workstreamId)
      assert.deepEqual(reader.session(), { ok: true, value: 'unusable' })
      assert.equal(connectCalls, 0)
    } finally {
      runtimeControl.server.close()
      broker.server.close()
    }
  })
})

test('model/effort: a live Session reads the fresh resume snapshot verbatim', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await seedLiveSession(pool, workstreamId, 'ctx-1', 0)
    const runtimeControl = await startRuntimeControlWithEvidence(
      [{ uid: 'u1', name: 'pod-1', phase: 'Running', imageId: null, admittedDigest: null, incarnation: null, forcedDeletion: false, podIP: '10.0.0.1' }],
      0,
    )
    const broker = await startJsonServer(() => undefined)
    const agent = fakeAcpAgent([
      { id: 'model', currentValue: 'sonnet' },
      { id: 'effort', currentValue: 'high' },
    ])
    try {
      const source = new HttpObservationSource({
        pool,
        productPool: pool,
        bridgePort: 8765,
        runtimeControlBaseUrl: runtimeControl.url,
        brokerBaseUrl: broker.url,
        harnessCatalogue: [],
        connect: async () => ({ connectionId: 'c1', stream: agent.clientStream, close: async () => agent.close(), closed: Promise.resolve() }),
      })
      const reader = await source.reader(workstreamId)
      assert.deepEqual(reader.model(), { ok: true, value: 'sonnet' })
      assert.deepEqual(reader.effort(), { ok: true, value: 'high' })
    } finally {
      runtimeControl.server.close()
      broker.server.close()
    }
  })
})

test('model/effort: a stale (older-generation) context reads unavailable — never a carried-over snapshot', async () => {
  await withTestDatabase(async (pool) => {
    const workstreamId = randomUUID()
    await seedLiveSession(pool, workstreamId, 'ctx-1', 0)
    const runtimeControl = await startRuntimeControlWithEvidence(
      [{ uid: 'u1', name: 'pod-1', phase: 'Running', imageId: null, admittedDigest: null, incarnation: null, forcedDeletion: false, podIP: '10.0.0.1' }],
      1,
    )
    const broker = await startJsonServer(() => undefined)
    try {
      const source = new HttpObservationSource({ pool, productPool: pool, bridgePort: 8765, runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url, harnessCatalogue: [] })
      const reader = await source.reader(workstreamId)
      assert.deepEqual(reader.model(), { ok: false, reason: 'unavailable' })
      assert.deepEqual(reader.effort(), { ok: false, reason: 'unavailable' })
    } finally {
      runtimeControl.server.close()
      broker.server.close()
    }
  })
})
