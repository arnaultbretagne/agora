import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import type { DuplexByteStream } from '@agora/acp'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { openSession, recordBridgeToken, bindAcpContext } from '@agora/journal'
import type { VerbContext } from '@agora/engine'
import { createSetConfigExecutor, UnsupportedVerbError } from '../../src/verbs/set-config.js'

function context(workstreamId: string): VerbContext {
  return { workstreamId, intentSeq: 1, workGeneration: 1, claimToken: 'claim-1', rule: 'CONFIG-001' }
}

interface SetConfigCall {
  readonly sessionId: string
  readonly configId: string
  readonly value: string
}

function fakeAcpAgent(calls: SetConfigCall[]): { readonly clientStream: DuplexByteStream; readonly close: () => void } {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()
  const clientStream: DuplexByteStream = { writable: aToB.writable, readable: bToA.readable }
  const agentStream: DuplexByteStream = { writable: bToA.writable, readable: aToB.readable }
  const agentApp = acp.agent({ name: 'test-fake-agent' })
  agentApp.onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }))
  agentApp.onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    const p = params as SetConfigCall
    calls.push({ sessionId: p.sessionId, configId: p.configId, value: p.value })
    return { configOptions: [{ id: p.configId, name: p.configId, type: 'select', currentValue: p.value, options: [] }] }
  })
  const agentConnection = agentApp.connect(acp.ndJsonStream(agentStream.writable, agentStream.readable))
  return { clientStream, close: () => agentConnection.close?.() }
}

function fakeConnect(agent: ReturnType<typeof fakeAcpAgent>, calls: string[]): NonNullable<Parameters<typeof createSetConfigExecutor>[0]['connect']> {
  return async (options) => {
    calls.push(options.url)
    return { connectionId: 'test-conn', stream: agent.clientStream, close: async () => agent.close(), closed: Promise.resolve() }
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

async function seedIntent(db: TestDatabase, workstreamId: string, intent: Record<string, unknown>): Promise<void> {
  await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
  await db.pool.query(
    `INSERT INTO workstream_intent_events (workstream_id, intent_seq, intent, request_key, principal, revision_set)
     VALUES ($1, 1, $2::jsonb, $3, 'p', '{}'::jsonb)`,
    [workstreamId, JSON.stringify(intent), randomUUID()],
  )
}

async function seedSession(db: TestDatabase, workstreamId: string, acpContextId: string, processGeneration: number): Promise<void> {
  const client = await db.pool.connect()
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

test('SET_MODEL: sends the Intent\'s model to the live context, captures the exchange, leaves no DB bookkeeping', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await seedIntent(db, workstreamId, { model: 'sonnet', effort: 'high' })
    await seedSession(db, workstreamId, 'ctx-1', 0)
    const runtimeControl = await startRuntimeControl([{ name: 'pod-1', forcedDeletion: false, podIP: '10.0.0.5' }], 0)
    try {
      const calls: SetConfigCall[] = []
      const agent = fakeAcpAgent(calls)
      const connectCalls: string[] = []
      const executor = createSetConfigExecutor({ productPool: db.pool, enginePool: db.pool, runtimeControlBaseUrl: runtimeControl.url, bridgePort: 8765, connect: fakeConnect(agent, connectCalls) })
      await executor.execute('SET_MODEL', context(workstreamId))
      assert.deepEqual(connectCalls, ['ws://10.0.0.5:8765/'])
      assert.deepEqual(calls, [{ sessionId: 'ctx-1', configId: 'model', value: 'sonnet' }])
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('SET_EFFORT: sends the Intent\'s effort, not its model', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await seedIntent(db, workstreamId, { model: 'sonnet', effort: 'high' })
    await seedSession(db, workstreamId, 'ctx-1', 0)
    const runtimeControl = await startRuntimeControl([{ name: 'pod-1', forcedDeletion: false, podIP: '10.0.0.5' }], 0)
    try {
      const calls: SetConfigCall[] = []
      const agent = fakeAcpAgent(calls)
      const executor = createSetConfigExecutor({ productPool: db.pool, enginePool: db.pool, runtimeControlBaseUrl: runtimeControl.url, bridgePort: 8765, connect: fakeConnect(agent, []) })
      await executor.execute('SET_EFFORT', context(workstreamId))
      assert.deepEqual(calls, [{ sessionId: 'ctx-1', configId: 'effort', value: 'high' }])
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('SET_MODEL: no Session context bound yet (START has not caught up) — a no-op, never connects', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await seedIntent(db, workstreamId, { model: 'sonnet', effort: 'high' })
    // No seedSession call: BUILD/session-opener/START haven't caught up yet for this Workstream.
    const runtimeControl = await startRuntimeControl([{ name: 'pod-1', forcedDeletion: false, podIP: '10.0.0.5' }], 0)
    try {
      const calls: SetConfigCall[] = []
      const agent = fakeAcpAgent(calls)
      const connectCalls: string[] = []
      const executor = createSetConfigExecutor({ productPool: db.pool, enginePool: db.pool, runtimeControlBaseUrl: runtimeControl.url, bridgePort: 8765, connect: fakeConnect(agent, connectCalls) })
      await executor.execute('SET_MODEL', context(workstreamId))
      assert.deepEqual(connectCalls, [])
      assert.deepEqual(calls, [])
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('SET_MODEL: the bound context is at an OLDER generation — a no-op, never acts against a dead process', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await seedIntent(db, workstreamId, { model: 'sonnet', effort: 'high' })
    await seedSession(db, workstreamId, 'ctx-1', 0)
    // Evidence reports generation 1 — a restart happened since ctx-1 was bound.
    const runtimeControl = await startRuntimeControl([{ name: 'pod-1', forcedDeletion: false, podIP: '10.0.0.5' }], 1)
    try {
      const calls: SetConfigCall[] = []
      const agent = fakeAcpAgent(calls)
      const connectCalls: string[] = []
      const executor = createSetConfigExecutor({ productPool: db.pool, enginePool: db.pool, runtimeControlBaseUrl: runtimeControl.url, bridgePort: 8765, connect: fakeConnect(agent, connectCalls) })
      await executor.execute('SET_MODEL', context(workstreamId))
      assert.deepEqual(connectCalls, [])
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('a verb neither SET_MODEL nor SET_EFFORT throws UnsupportedVerbError', async () => {
  await withTestDatabase(async (db) => {
    const executor = createSetConfigExecutor({ productPool: db.pool, enginePool: db.pool, runtimeControlBaseUrl: 'http://127.0.0.1:1', bridgePort: 8765 })
    await assert.rejects(() => executor.execute('BUILD', context(randomUUID())), UnsupportedVerbError)
  })
})
