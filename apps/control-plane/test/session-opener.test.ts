import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { withTestDatabase } from '@agora/testkit'
import { RecordingVerbExecutor, type VerbContext } from '@agora/engine'
import { createSessionOpeningExecutor } from '../src/session-opener.js'

function startRuntimeControl(pods: readonly unknown[]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/v1/workstreams/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ pods, obligations: [], complete: true }))
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

function context(overrides: Partial<VerbContext> = {}): VerbContext {
  return { workstreamId: randomUUID(), intentSeq: 1, workGeneration: 1, claimToken: 'claim-1', rule: 'CONSTRUCT-001', ...overrides }
}

test('BUILD, followed by an established Pod: opens a Session under agora_product', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const workstreamId = randomUUID()
      await db.asRole(client, 'agora_product', () =>
        client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()]),
      )
      const runtimeControl = await startRuntimeControl([{ uid: 'pod-a', forcedDeletion: false, incarnation: 'inc-1' }])
      try {
        const inner = new RecordingVerbExecutor()
        const executor = createSessionOpeningExecutor({ inner, productPool: db.pool, runtimeControlBaseUrl: runtimeControl.url })
        await executor.execute('BUILD', context({ workstreamId }))
        assert.equal(inner.calls.length, 1)
        const session = await client.query('SELECT pod_uid, provenance FROM sessions WHERE workstream_id = $1', [workstreamId])
        assert.equal(session.rowCount, 1)
        assert.equal(session.rows[0]['pod_uid'], 'pod-a')
        assert.deepEqual(session.rows[0]['provenance'], { incarnation: 'inc-1' })
      } finally {
        runtimeControl.server.close()
      }
    } finally {
      client.release()
    }
  })
})

test('BUILD, called twice for the same Pod: opens exactly one Session (openSession\'s own idempotency)', async () => {
  await withTestDatabase(async (db) => {
    const client = await db.pool.connect()
    try {
      const workstreamId = randomUUID()
      await db.asRole(client, 'agora_product', () =>
        client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()]),
      )
      const runtimeControl = await startRuntimeControl([{ uid: 'pod-a', forcedDeletion: false, incarnation: 'inc-1' }])
      try {
        const inner = new RecordingVerbExecutor()
        const executor = createSessionOpeningExecutor({ inner, productPool: db.pool, runtimeControlBaseUrl: runtimeControl.url })
        await executor.execute('BUILD', context({ workstreamId }))
        await executor.execute('BUILD', context({ workstreamId }))
        const session = await client.query('SELECT count(*)::int AS n FROM sessions WHERE workstream_id = $1', [workstreamId])
        assert.equal(session.rows[0]['n'], 1)
      } finally {
        runtimeControl.server.close()
      }
    } finally {
      client.release()
    }
  })
})

test('BUILD, no established Pod yet: opens nothing and does not throw', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    const client = await db.pool.connect()
    try {
      await db.asRole(client, 'agora_product', () =>
        client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()]),
      )
    } finally {
      client.release()
    }
    const runtimeControl = await startRuntimeControl([])
    try {
      const inner = new RecordingVerbExecutor()
      const executor = createSessionOpeningExecutor({ inner, productPool: db.pool, runtimeControlBaseUrl: runtimeControl.url })
      await executor.execute('BUILD', context({ workstreamId }))
      const session = await db.pool.query('SELECT count(*)::int AS n FROM sessions WHERE workstream_id = $1', [workstreamId])
      assert.equal(session.rows[0]['n'], 0)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('BUILD, runtime-control unreachable: swallows the error, logs it, never fails BUILD itself', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    const client = await db.pool.connect()
    try {
      await db.asRole(client, 'agora_product', () =>
        client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()]),
      )
    } finally {
      client.release()
    }
    const logs: string[] = []
    const inner = new RecordingVerbExecutor()
    const executor = createSessionOpeningExecutor({
      inner,
      productPool: db.pool,
      runtimeControlBaseUrl: 'http://127.0.0.1:65533',
      logger: (message) => logs.push(message),
    })
    await executor.execute('BUILD', context({ workstreamId }))
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, /session opening after BUILD failed/)
  })
})

test('a non-BUILD verb: never touches runtime-control or sessions', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    const inner = new RecordingVerbExecutor()
    // No runtime-control server started at all — a call here would throw ECONNREFUSED and fail the test.
    const executor = createSessionOpeningExecutor({ inner, productPool: db.pool, runtimeControlBaseUrl: 'http://127.0.0.1:1' })
    await executor.execute('TURN_OFF', context({ workstreamId }))
    assert.equal(inner.calls.length, 1)
  })
})
