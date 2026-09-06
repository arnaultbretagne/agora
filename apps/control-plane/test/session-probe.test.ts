import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import type { DuplexByteStream } from '@agora/acp'
import { withTestDatabase } from '@agora/testkit'
import { openSession } from '@agora/journal'
import { probeSession } from '../src/session-probe.js'

interface FakeAgent {
  readonly clientStream: DuplexByteStream
  readonly close: () => void
  /** Live counters — read these after the call, never destructured up front (they mutate in place). */
  readonly counts: { initializeCalls: number; resumeCalls: number }
}

function fakeAcpAgent(configOptions: readonly { id: string; currentValue: string }[] = []): FakeAgent {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()
  const clientStream: DuplexByteStream = { writable: aToB.writable, readable: bToA.readable }
  const agentStream: DuplexByteStream = { writable: bToA.writable, readable: aToB.readable }
  const agentApp = acp.agent({ name: 'test-fake-agent' })
  const counts = { initializeCalls: 0, resumeCalls: 0 }
  agentApp.onRequest(acp.methods.agent.initialize, () => {
    counts.initializeCalls += 1
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }
  })
  agentApp.onRequest(acp.methods.agent.session.resume, () => {
    counts.resumeCalls += 1
    return { configOptions: configOptions.map((o) => ({ ...o, type: 'select', name: o.id, options: [] })) }
  })
  const agentConnection = agentApp.connect(acp.ndJsonStream(agentStream.writable, agentStream.readable))
  return { clientStream, close: () => agentConnection.close?.(), counts }
}

async function seedSession(pool: import('pg').Pool, workstreamId: string): Promise<string> {
  await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const opened = await openSession(client, workstreamId, { podUid: 'pod-a', provenance: {} })
    await client.query('COMMIT')
    return opened.sessionId
  } finally {
    client.release()
  }
}

test('probeSession: no podIP at all never even attempts to connect', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    const sessionId = await seedSession(db.pool, workstreamId)
    let connectCalls = 0
    const result = await probeSession(
      { workstreamId, sessionId, podIP: null, bridgeToken: 'token', contextId: 'ctx-1' },
      { productPool: db.pool, bridgePort: 8765, connect: async () => { connectCalls += 1; throw new Error('unreachable') } },
    )
    assert.deepEqual(result, { connected: false, configOptions: new Map() })
    assert.equal(connectCalls, 0)
  })
})

test('probeSession: a connection failure reports disconnected, logged, never thrown', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    const sessionId = await seedSession(db.pool, workstreamId)
    const logs: string[] = []
    const result = await probeSession(
      { workstreamId, sessionId, podIP: '10.0.0.1', bridgeToken: 'token', contextId: 'ctx-1' },
      { productPool: db.pool, bridgePort: 8765, logger: (m) => logs.push(m), connect: async () => { throw new Error('connection refused') } },
    )
    assert.deepEqual(result, { connected: false, configOptions: new Map() })
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, /session probe.*failed/)
  })
})

test('probeSession: a successful resume reports connected and the parsed configOptions, capturing every frame', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    const sessionId = await seedSession(db.pool, workstreamId)
    const agent = fakeAcpAgent([
      { id: 'model', currentValue: 'sonnet' },
      { id: 'effort', currentValue: 'high' },
    ])
    const result = await probeSession(
      { workstreamId, sessionId, podIP: '10.0.0.1', bridgeToken: 'token', contextId: 'ctx-1' },
      { productPool: db.pool, bridgePort: 8765, connect: async () => ({ connectionId: 'c1', stream: agent.clientStream, close: async () => agent.close(), closed: Promise.resolve() }) },
    )
    assert.equal(result.connected, true)
    assert.deepEqual([...result.configOptions], [['model', 'sonnet'], ['effort', 'high']])
    assert.equal(agent.counts.initializeCalls, 0, 'the process-level handshake is the bridge\'s, done once at launch — codex refuses a second one')
    assert.equal(agent.counts.resumeCalls, 1)

    const facts = await db.pool.query('SELECT count(*)::int AS n FROM workstream_facts WHERE workstream_id = $1', [workstreamId])
    assert.ok(facts.rows[0]['n'] > 0, 'the probe\'s own ACP frames are captured like any other traffic (execution.md)')
  })
})
