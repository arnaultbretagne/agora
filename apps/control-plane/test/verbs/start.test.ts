import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import type { DuplexByteStream } from '@agora/acp'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { openSession, recordBridgeToken, bindAcpContext, currentSession } from '@agora/journal'
import type { VerbContext } from '@agora/engine'
import { createStartExecutor, UnsupportedVerbError, workspaceRoot } from '../../src/verbs/start.js'

function context(workstreamId: string): VerbContext {
  return { workstreamId, intentSeq: 1, workGeneration: 1, claimToken: 'claim-1', rule: 'SESSION-001' }
}

interface FakeAgentOptions {
  readonly sessionIdForNew?: string
  readonly existingSessions?: readonly { sessionId: string }[]
  readonly onSessionNew?: () => void
  readonly onSessionList?: () => void
}

/** A real ACP agent (the pinned SDK, same as packages/acp's dev-harness) wired to an in-process
 * duplex instead of a WebSocket — start.ts's own `connect` seam hands it exactly the same
 * DuplexByteStream shape connectBridge would, so the ACP-level logic under test (initialize,
 * discover-or-create) is exercised for real; the WebSocket/P4-auth/framing layer underneath is
 * proven separately, in harnesses/claude-code's own bridge-server tests (ADR 0001 — this deployable
 * cannot import that one). */
function fakeAcpAgent(options: FakeAgentOptions = {}): { readonly clientStream: DuplexByteStream; readonly close: () => void } {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()
  const clientStream: DuplexByteStream = { writable: aToB.writable, readable: bToA.readable }
  const agentStream: DuplexByteStream = { writable: bToA.writable, readable: aToB.readable }
  const agentApp = acp.agent({ name: 'test-fake-agent' })
  agentApp.onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }))
  agentApp.onRequest(acp.methods.agent.session.list, () => {
    options.onSessionList?.()
    return { sessions: (options.existingSessions ?? []).map((s) => ({ sessionId: s.sessionId, cwd: workspaceRoot() })) }
  })
  agentApp.onRequest(acp.methods.agent.session.new, () => {
    options.onSessionNew?.()
    return { sessionId: options.sessionIdForNew ?? 'fresh-session' }
  })
  const agentConnection = agentApp.connect(acp.ndJsonStream(agentStream.writable, agentStream.readable))
  return { clientStream, close: () => agentConnection.close?.() }
}

function fakeConnect(agent: ReturnType<typeof fakeAcpAgent>, calls: string[]): NonNullable<Parameters<typeof createStartExecutor>[0]['connect']> {
  return async (options) => {
    calls.push(options.url)
    return {
      connectionId: 'test-conn',
      stream: agent.clientStream,
      close: async () => agent.close(),
      closed: Promise.resolve(),
    }
  }
}

interface RuntimeControlStub {
  readonly server: Server
  readonly url: string
}

function startRuntimeControl(pods: readonly unknown[], processGeneration: number): Promise<RuntimeControlStub> {
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

async function seedSession(
  db: TestDatabase,
  workstreamId: string,
  options: { readonly bridgeToken?: string | null; readonly acpContextId?: string; readonly processGeneration?: number } = {},
): Promise<string> {
  const client = await db.pool.connect()
  try {
    return await db.asRole(client, 'agora_product', async () => {
      await client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
      await client.query('BEGIN')
      const opened = await openSession(client, workstreamId, { podUid: 'pod-a', provenance: {} })
      await client.query('COMMIT')
      if (options.bridgeToken !== null) {
        await client.query('BEGIN')
        await recordBridgeToken(client, opened.sessionId, options.bridgeToken ?? 'bridge-token-1')
        await client.query('COMMIT')
      }
      if (options.acpContextId !== undefined) {
        await client.query('BEGIN')
        await bindAcpContext(client, opened.sessionId, { contextId: options.acpContextId, processGeneration: options.processGeneration ?? 0 })
        await client.query('COMMIT')
      }
      return opened.sessionId
    })
  } finally {
    client.release()
  }
}

test('START, a fresh Session with no prior context: initializes and creates a new one (no existing sessions to discover)', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await seedSession(db, workstreamId)
    const runtimeControl = await startRuntimeControl([{ name: 'pod-name-1', forcedDeletion: false, incarnation: 'inc-1', podIP: '10.0.0.5' }], 0)
    try {
      const agent = fakeAcpAgent({ sessionIdForNew: 'created-session-1' })
      const connectCalls: string[] = []
      const executor = createStartExecutor({ productPool: db.pool, runtimeControlBaseUrl: runtimeControl.url, bridgePort: 8765, connect: fakeConnect(agent, connectCalls) })
      await executor.execute('START', context(workstreamId))
      assert.deepEqual(connectCalls, ['ws://10.0.0.5:8765/'])
      const session = await currentSession(db.pool, workstreamId)
      assert.equal(session?.acpContextId, 'created-session-1')
      assert.equal(session?.processGeneration, 0)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('START, a lost session/new response (no local record, but the adapter already has one): discovers, never calls session/new again', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await seedSession(db, workstreamId)
    const runtimeControl = await startRuntimeControl([{ name: 'pod-name-1', forcedDeletion: false, incarnation: 'inc-1', podIP: '10.0.0.5' }], 0)
    try {
      let sessionNewCalls = 0
      const agent = fakeAcpAgent({ existingSessions: [{ sessionId: 'discovered-session' }], onSessionNew: () => (sessionNewCalls += 1) })
      const executor = createStartExecutor({ productPool: db.pool, runtimeControlBaseUrl: runtimeControl.url, bridgePort: 8765, connect: fakeConnect(agent, []) })
      await executor.execute('START', context(workstreamId))
      assert.equal(sessionNewCalls, 0, 'never a blind session/new once a lost response is possible')
      const session = await currentSession(db.pool, workstreamId)
      assert.equal(session?.acpContextId, 'discovered-session')
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('START, already bound at the current process generation: a no-op, never even connects', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await seedSession(db, workstreamId, { acpContextId: 'already-live', processGeneration: 3 })
    const runtimeControl = await startRuntimeControl([{ name: 'pod-name-1', forcedDeletion: false, incarnation: 'inc-1', podIP: '10.0.0.5' }], 3)
    try {
      const agent = fakeAcpAgent()
      const connectCalls: string[] = []
      const executor = createStartExecutor({ productPool: db.pool, runtimeControlBaseUrl: runtimeControl.url, bridgePort: 8765, connect: fakeConnect(agent, connectCalls) })
      await executor.execute('START', context(workstreamId))
      assert.deepEqual(connectCalls, [])
      const session = await currentSession(db.pool, workstreamId)
      assert.equal(session?.acpContextId, 'already-live')
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('START, a context bound at an OLDER generation (the process restarted): creates fresh, never discovers a dead process\'s stale list', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await seedSession(db, workstreamId, { acpContextId: 'stale-context', processGeneration: 0 })
    // The new process's evidence reports generation 1 — a restart happened.
    const runtimeControl = await startRuntimeControl([{ name: 'pod-name-1', forcedDeletion: false, incarnation: 'inc-1', podIP: '10.0.0.5' }], 1)
    try {
      let sessionNewCalls = 0
      let sessionListCalls = 0
      const agent = fakeAcpAgent({
        sessionIdForNew: 'rebound-session',
        existingSessions: [{ sessionId: 'irrelevant-old-entry' }],
        onSessionNew: () => (sessionNewCalls += 1),
        onSessionList: () => (sessionListCalls += 1),
      })
      const executor = createStartExecutor({ productPool: db.pool, runtimeControlBaseUrl: runtimeControl.url, bridgePort: 8765, connect: fakeConnect(agent, []) })
      await executor.execute('START', context(workstreamId))
      assert.equal(sessionListCalls, 0, 'a fresh process never gets discovery — there is nothing valid left to discover')
      assert.equal(sessionNewCalls, 1)
      const session = await currentSession(db.pool, workstreamId)
      assert.equal(session?.acpContextId, 'rebound-session')
      assert.equal(session?.processGeneration, 1)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('START, no bridge token yet (gate not released): a no-op, retried on a later tick', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await seedSession(db, workstreamId, { bridgeToken: null })
    const runtimeControl = await startRuntimeControl([{ name: 'pod-name-1', forcedDeletion: false, incarnation: 'inc-1', podIP: '10.0.0.5' }], 0)
    try {
      const agent = fakeAcpAgent()
      const connectCalls: string[] = []
      const executor = createStartExecutor({ productPool: db.pool, runtimeControlBaseUrl: runtimeControl.url, bridgePort: 8765, connect: fakeConnect(agent, connectCalls) })
      await executor.execute('START', context(workstreamId))
      assert.deepEqual(connectCalls, [])
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('START, no established Pod yet: a no-op', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await seedSession(db, workstreamId)
    const runtimeControl = await startRuntimeControl([], 0)
    try {
      const agent = fakeAcpAgent()
      const connectCalls: string[] = []
      const executor = createStartExecutor({ productPool: db.pool, runtimeControlBaseUrl: runtimeControl.url, bridgePort: 8765, connect: fakeConnect(agent, connectCalls) })
      await executor.execute('START', context(workstreamId))
      assert.deepEqual(connectCalls, [])
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('a non-START verb throws UnsupportedVerbError — the router\'s own mistake, never silently ignored', async () => {
  await withTestDatabase(async (db) => {
    const executor = createStartExecutor({ productPool: db.pool, runtimeControlBaseUrl: 'http://127.0.0.1:1', bridgePort: 8765 })
    await assert.rejects(() => executor.execute('BUILD', context(randomUUID())), UnsupportedVerbError)
  })
})
