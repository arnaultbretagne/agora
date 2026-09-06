import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import type { DuplexByteStream } from '@agora/acp'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { openSession, recordBridgeToken, currentSession } from '@agora/journal'
import { invalidationsFor, recordSave } from '@agora/custody'
import type { VerbContext } from '@agora/engine'
import { createRestoreExecutor, UnsupportedVerbError, type RestoreHarness } from '../../src/verbs/restore.js'

const HARNESS: RestoreHarness = {
  harnessId: 'claude-code',
  supportedFormats: [{ formatId: 'claude-code-transcript', formatVersion: 1 }],
  acceptedDriverRevisions: ['claude-code-transcript-1'],
  workspaceDeps: {},
}

function context(workstreamId: string): VerbContext {
  return { workstreamId, intentSeq: 1, workGeneration: 1, claimToken: 'claim-1', rule: 'SESSION-002' }
}

/** The pinned SDK over an in-process duplex — the same seam verbs/start.test.ts uses. */
function fakeAcpAgent(calls: { resumed: string[] }): { readonly clientStream: DuplexByteStream; readonly close: () => void } {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()
  const clientStream: DuplexByteStream = { writable: aToB.writable, readable: bToA.readable }
  const agentStream: DuplexByteStream = { writable: bToA.writable, readable: aToB.readable }
  const agentApp = acp.agent({ name: 'test-fake-agent' })
  agentApp.onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
  agentApp.onRequest(acp.methods.agent.session.resume, ({ params }) => {
    calls.resumed.push((params as { sessionId: string }).sessionId)
    return {}
  })
  agentApp.onRequest(acp.methods.agent.session.new, () => {
    throw new Error('RESTORE must never create a context: it resumes the Save\'s own')
  })
  const agentConnection = agentApp.connect(acp.ndJsonStream(agentStream.writable, agentStream.readable))
  return { clientStream, close: () => agentConnection.close?.() }
}

function fakeConnect(agent: ReturnType<typeof fakeAcpAgent>, calls: string[]): NonNullable<Parameters<typeof createRestoreExecutor>[0]['connect']> {
  return async (options) => {
    calls.push(options.url)
    return { connectionId: 'test-conn', stream: agent.clientStream, close: async () => agent.close(), closed: Promise.resolve() }
  }
}

interface RuntimeControlStub {
  readonly server: Server
  readonly url: string
  readonly staged: { saveId: string; checksum: string; byteLength: number }[]
}

/** Mimics runtime-control's custody endpoints, including the placement it will not confirm. */
function startRuntimeControl(options: { placementStatus: 'placed' | 'rejected' | 'staged'; processGeneration?: number }): Promise<RuntimeControlStub> {
  const staged: { saveId: string; checksum: string; byteLength: number }[] = []
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? ''
      if (url.startsWith('/v1/workstreams/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ pods: [{ name: 'pod-name-1', forcedDeletion: false, incarnation: 'inc-1', podIP: '10.0.0.5' }], obligations: [], complete: true }))
      }
      if (url.endsWith('/evidence')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ processGeneration: options.processGeneration ?? 0 }))
      }
      if (url.endsWith('/custody/stage')) {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        return void req.on('end', () => {
          staged.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { saveId: string; checksum: string; byteLength: number })
          res.writeHead(202, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ staged: true }))
        })
      }
      if (url.endsWith('/custody/placement-status')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ status: options.placementStatus }))
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}`, staged })
    })
  })
}

async function seed(
  db: TestDatabase,
  overrides: { formatVersion?: number; driverRevision?: string } = {},
): Promise<{ workstreamId: string; sessionId: string; saveId: string; contextId: string }> {
  const workstreamId = randomUUID()
  const contextId = randomUUID()
  const client = await db.pool.connect()
  try {
    return await db.asRole(client, 'agora_product', async () => {
      await client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
      await client.query('BEGIN')
      // The Session that produced the Save, and then the NEW Session a restore always belongs to
      // (CONT-003) — a different Pod, a different attribution, the same native context id.
      const producing = await openSession(client, workstreamId, { podUid: 'pod-old', provenance: {} })
      await client.query('UPDATE sessions SET attribution_ended_at = now() WHERE id = $1', [producing.sessionId])
      const save = await recordSave(
        client,
        { podUid: 'pod-old', processGeneration: 0, contextId, frontierW: 4, driverRevision: overrides.driverRevision ?? 'claude-code-transcript-1' },
        {
          workstreamId,
          sessionId: producing.sessionId,
          harnessId: 'claude-code',
          formatId: 'claude-code-transcript',
          formatVersion: overrides.formatVersion ?? 1,
          imageDigest: `sha256:${'a'.repeat(64)}`,
          byteLength: 13063,
          checksum: `sha256:${'b'.repeat(64)}`,
          seedPolicyRevision: 'handoff-seed-v1',
          nativeOrigin: {},
          workspaceDeps: {},
        },
      )
      await client.query('INSERT INTO anchors (workstream_id, harness_id, save_id, frontier_w) VALUES ($1, $2, $3, $4)', [workstreamId, 'claude-code', save.save.id, 4])
      const fresh = await openSession(client, workstreamId, { podUid: 'pod-new', provenance: {} })
      await recordBridgeToken(client, fresh.sessionId, 'bridge-token-1')
      await client.query('COMMIT')
      return { workstreamId, sessionId: fresh.sessionId, saveId: save.save.id, contextId }
    })
  } finally {
    client.release()
  }
}

test('CONT-003: the Save is placed, its native context resumed, and bound to the NEW Session', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, sessionId, saveId, contextId } = await seed(db)
    const runtimeControl = await startRuntimeControl({ placementStatus: 'placed', processGeneration: 2 })
    const calls = { resumed: [] as string[] }
    const agent = fakeAcpAgent(calls)
    const connects: string[] = []
    try {
      const executor = createRestoreExecutor({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        harness: HARNESS,
        connect: fakeConnect(agent, connects),
      })

      await executor.execute('RESTORE', context(workstreamId))

      assert.deepEqual(runtimeControl.staged, [{ saveId, checksum: `sha256:${'b'.repeat(64)}`, byteLength: 13063 }])
      assert.deepEqual(calls.resumed, [contextId], 'the Save\'s own context is resumed, never a new one')
      const bound = await currentSession(db.pool, workstreamId)
      assert.equal(bound?.sessionId, sessionId)
      assert.equal(bound?.acpContextId, contextId, 'a reused ACP id across Sessions is fine — it is the harness\'s, not an Agora identity')
      assert.equal(bound?.processGeneration, 2)
      assert.deepEqual(connects, ['ws://10.0.0.5:8765/'])
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('an unverified placement is never resumed, and nothing is invalidated by it', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, saveId } = await seed(db)
    const runtimeControl = await startRuntimeControl({ placementStatus: 'rejected' })
    const calls = { resumed: [] as string[] }
    try {
      const executor = createRestoreExecutor({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        harness: HARNESS,
        placementTimeoutMs: 100,
        connect: fakeConnect(fakeAcpAgent(calls), []),
      })

      await executor.execute('RESTORE', context(workstreamId))

      assert.deepEqual(calls.resumed, [], 'resuming an unverified transcript would prove nothing')
      assert.equal((await currentSession(db.pool, workstreamId))?.acpContextId, null)
      // A bad placement is not a bad Save: some other attempt may place it correctly (CONT-008).
      assert.deepEqual(await invalidationsFor(db.pool, saveId), [])
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('CONT-008: a verified incompatibility invalidates the exact Save/driver pair, and only that pair', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, saveId } = await seed(db, { formatVersion: 7 })
    const runtimeControl = await startRuntimeControl({ placementStatus: 'placed' })
    const calls = { resumed: [] as string[] }
    try {
      const executor = createRestoreExecutor({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        harness: HARNESS,
        connect: fakeConnect(fakeAcpAgent(calls), []),
      })

      await executor.execute('RESTORE', context(workstreamId))

      const invalidations = await invalidationsFor(db.pool, saveId)
      assert.equal(invalidations.length, 1)
      assert.equal(invalidations[0]!.driverRevision, 'claude-code-transcript-1', 'scoped to the driver: a corrected one can still read these bytes')
      assert.match(invalidations[0]!.cause, /cannot read format/)
      assert.equal(invalidations[0]!.verifier, 'control-plane/restore')
      assert.deepEqual(runtimeControl.staged, [], 'nothing was even placed for a Save this harness cannot read')

      // And it does not loop on the known-bad Save: a second tick records no second invalidation.
      await executor.execute('RESTORE', context(workstreamId))
      assert.equal((await invalidationsFor(db.pool, saveId)).length, 1)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('a Session that already holds a context is left alone', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, contextId } = await seed(db)
    const client = await db.pool.connect()
    try {
      await db.asRole(client, 'agora_product', async () => {
        await client.query('UPDATE sessions SET acp_context_id = $1 WHERE workstream_id = $2 AND attribution_ended_at IS NULL', [contextId, workstreamId])
      })
    } finally {
      client.release()
    }
    const runtimeControl = await startRuntimeControl({ placementStatus: 'placed' })
    try {
      const executor = createRestoreExecutor({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        harness: HARNESS,
        connect: fakeConnect(fakeAcpAgent({ resumed: [] }), []),
      })

      await executor.execute('RESTORE', context(workstreamId))

      assert.deepEqual(runtimeControl.staged, [], 'RESTORE is already done for this Session')
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('RESTORE refuses any other verb rather than quietly doing nothing', async () => {
  await withTestDatabase(async (db) => {
    const executor = createRestoreExecutor({ productPool: db.pool, runtimeControlBaseUrl: 'http://127.0.0.1:65533', bridgePort: 8765, harness: HARNESS })
    await assert.rejects(executor.execute('START', context(randomUUID())), UnsupportedVerbError)
  })
})
