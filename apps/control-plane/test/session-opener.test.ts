import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { withTestDatabase } from '@agora/testkit'
import { RecordingVerbExecutor, type VerbContext } from '@agora/engine'
import type { OwnerRequest } from '@agora/owner-requests'
import { createSessionOpeningExecutor } from '../src/session-opener.js'

interface RuntimeControlStub {
  readonly server: Server
  readonly url: string
  readonly ownerRequests: OwnerRequest[]
}

/** `gateReleaseResult` mimics owner-api.ts's gateRelease(): `'completed'` (with a token), an owner
 * `unknown`, or omitted entirely to exercise "runtime-control doesn't even know this operation". */
function startRuntimeControl(pods: readonly unknown[], gateReleaseResult: 'completed' | 'unknown' | 'none' = 'completed'): Promise<RuntimeControlStub> {
  const ownerRequests: OwnerRequest[] = []
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/v1/workstreams/') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ pods, obligations: [], complete: true }))
        return
      }
      if (req.url === '/v1/owner-requests' && req.method === 'POST') {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as OwnerRequest
          ownerRequests.push(request)
          if (gateReleaseResult === 'none') {
            res.writeHead(404)
            res.end()
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify(
              gateReleaseResult === 'completed' ? { kind: 'completed', result: { released: true, bridgeToken: 'token-for-' + request.attemptKey } } : { kind: 'unknown', detail: 'seam not established' },
            ),
          )
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}`, ownerRequests })
    })
  })
}

function context(overrides: Partial<VerbContext> = {}): VerbContext {
  return { workstreamId: randomUUID(), intentSeq: 1, workGeneration: 1, claimToken: 'claim-1', rule: 'CONSTRUCT-001', ...overrides }
}

test('BUILD, followed by an established Pod: opens a Session and releases the launch seam, recording the bridge token', async () => {
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
        const executor = createSessionOpeningExecutor({ inner, productPool: db.pool, enginePool: db.pool, runtimeControlBaseUrl: runtimeControl.url })
        await executor.execute('BUILD', context({ workstreamId }))
        assert.equal(inner.calls.length, 1)
        const session = await client.query('SELECT id, pod_uid, provenance, bridge_token FROM sessions WHERE workstream_id = $1', [workstreamId])
        assert.equal(session.rowCount, 1)
        const row = session.rows[0]
        assert.equal(row['pod_uid'], 'pod-a')
        assert.deepEqual(row['provenance'], { incarnation: 'inc-1' })
        assert.equal(row['bridge_token'], `token-for-gate_release:${row['id']}`)
        assert.equal(runtimeControl.ownerRequests.length, 1)
        assert.equal(runtimeControl.ownerRequests[0]!.operation, 'gate_release')
        assert.equal(runtimeControl.ownerRequests[0]!.target.id, 'inc-1')
        assert.equal(runtimeControl.ownerRequests[0]!.payload['sessionId'], row['id'])
      } finally {
        runtimeControl.server.close()
      }
    } finally {
      client.release()
    }
  })
})

test('BUILD, called twice for the same Pod: opens exactly one Session and releases the gate exactly once', async () => {
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
        const executor = createSessionOpeningExecutor({ inner, productPool: db.pool, enginePool: db.pool, runtimeControlBaseUrl: runtimeControl.url })
        await executor.execute('BUILD', context({ workstreamId }))
        await executor.execute('BUILD', context({ workstreamId }))
        const session = await client.query('SELECT count(*)::int AS n FROM sessions WHERE workstream_id = $1', [workstreamId])
        assert.equal(session.rows[0]['n'], 1)
        // A token already recorded from the first BUILD means the second never re-dispatches gate_release.
        assert.equal(runtimeControl.ownerRequests.length, 1)
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
      const executor = createSessionOpeningExecutor({ inner, productPool: db.pool, enginePool: db.pool, runtimeControlBaseUrl: runtimeControl.url })
      await executor.execute('BUILD', context({ workstreamId }))
      const session = await db.pool.query('SELECT count(*)::int AS n FROM sessions WHERE workstream_id = $1', [workstreamId])
      assert.equal(session.rows[0]['n'], 0)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('BUILD, gate_release refused (unknown): the Session opens but no bridge token is recorded, retried on a later BUILD', async () => {
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
    const runtimeControl = await startRuntimeControl([{ uid: 'pod-a', forcedDeletion: false, incarnation: 'inc-1' }], 'unknown')
    try {
      const logs: string[] = []
      const inner = new RecordingVerbExecutor()
      const executor = createSessionOpeningExecutor({ inner, productPool: db.pool, enginePool: db.pool, runtimeControlBaseUrl: runtimeControl.url, logger: (message) => logs.push(message) })
      await executor.execute('BUILD', context({ workstreamId }))
      const session = await db.pool.query('SELECT bridge_token FROM sessions WHERE workstream_id = $1', [workstreamId])
      assert.equal(session.rowCount, 1)
      assert.equal(session.rows[0]['bridge_token'], null)
      assert.equal(runtimeControl.ownerRequests.length, 1)
      assert.match(logs.join('\n'), /gate_release.*unknown/)

      // A later BUILD retries gate_release (nothing was recorded, so it is not yet skipped).
      await executor.execute('BUILD', context({ workstreamId }))
      assert.equal(runtimeControl.ownerRequests.length, 2)
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
      enginePool: db.pool,
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
    const executor = createSessionOpeningExecutor({ inner, productPool: db.pool, enginePool: db.pool, runtimeControlBaseUrl: 'http://127.0.0.1:1' })
    await executor.execute('TURN_OFF', context({ workstreamId }))
    assert.equal(inner.calls.length, 1)
  })
})
