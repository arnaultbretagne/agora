import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import type { AddressInfo } from 'node:net'
import type { DuplexByteStream } from '@agora/acp'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { openSession } from '@agora/journal'
import { createControlPlaneServer } from '../src/http.js'
import { AgentChannels, type ChannelConnector } from '../src/agent-channel.js'

const OWNER = { 'x-forwarded-email': 'owner@example.com' }

function request(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** A fake agent that registers session/cancel (dev-harness.ts's own fake agent does not) so these
 * tests can observe whether AgentChannels actually sent one. */
function fakeAcpAgentWithCancel(): { readonly connector: ChannelConnector; cancelCalls: number; readonly close: () => void } {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()
  const clientStream: DuplexByteStream = { writable: aToB.writable, readable: bToA.readable }
  const agentStream: DuplexByteStream = { writable: bToA.writable, readable: aToB.readable }
  const agentApp = acp.agent({ name: 'test-fake-agent' })
  let cancelCalls = 0
  agentApp.onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }))
  agentApp.onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'ctx-fake' }))
  agentApp.onRequest(acp.methods.agent.session.prompt, async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    return { stopReason: 'end_turn' }
  })
  agentApp.onNotification(acp.methods.agent.session.cancel, () => {
    cancelCalls += 1
  })
  const agentConnection = agentApp.connect(acp.ndJsonStream(agentStream.writable, agentStream.readable))
  const connector: ChannelConnector = { connect: async () => ({ stream: clientStream, close: () => agentConnection.close?.() }) }
  return {
    connector,
    get cancelCalls() {
      return cancelCalls
    },
    close: () => agentConnection.close?.(),
  }
}

async function startApiWithConnector(db: TestDatabase, connector: ChannelConnector): Promise<{ port: number; channels: AgentChannels; close: () => Promise<void> }> {
  const channels = new AgentChannels({ pool: db.pool, nowSql: db.nowSql, connector, logger: (m) => console.error(`[channel] ${m}`) })
  const server = createControlPlaneServer({ productPool: db.pool, enginePool: db.pool, channels, nowSql: db.nowSql })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    channels,
    close: async () => {
      await channels.closeAll()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function createWorkstreamWithSession(db: TestDatabase, port: number): Promise<string> {
  const created = await request(port, '/v1/workstreams', { ...OWNER, 'idempotency-key': randomUUID() }, 'POST', { title: 'w' })
  const workstream = (await created.json()) as { id: string }
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    await openSession(client, workstream.id, { podUid: 'pod-1', provenance: {} }, { nowSql: db.nowSql })
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  return workstream.id
}

test('cancel: naming the currently active turn actually sends session/cancel', async () => {
  await withTestDatabase(async (db) => {
    const agent = fakeAcpAgentWithCancel()
    const api = await startApiWithConnector(db, agent.connector)
    try {
      const workstreamId = await createWorkstreamWithSession(db, api.port)
      const prompted = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'p1' }, 'POST', { text: 'x' })
      assert.equal(prompted.status, 202)
      const { commandId } = (await prompted.json()) as { commandId: string }

      const cancelled = await request(api.port, `/v1/workstreams/${workstreamId}/cancel`, { ...OWNER }, 'POST', { commandId })
      assert.equal(cancelled.status, 202)
      const body = (await cancelled.json()) as { cancelled: boolean }
      assert.equal(body.cancelled, true)
      assert.equal(agent.cancelCalls, 1)
    } finally {
      await api.close()
    }
  })
})

test('cancel: a stale commandId (the turn already finished) is a safe no-op, never sent', async () => {
  await withTestDatabase(async (db) => {
    const agent = fakeAcpAgentWithCancel()
    const api = await startApiWithConnector(db, agent.connector)
    try {
      const workstreamId = await createWorkstreamWithSession(db, api.port)
      const prompted = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'p1' }, 'POST', { text: 'x' })
      const { commandId } = (await prompted.json()) as { commandId: string }
      // The fake agent's own prompt handler waits ~200ms before responding — long enough for the
      // turn to have genuinely settled (channel.currentCommandId back to null) by the time this
      // cancel names it.
      await new Promise((resolve) => setTimeout(resolve, 400))

      const cancelled = await request(api.port, `/v1/workstreams/${workstreamId}/cancel`, { ...OWNER }, 'POST', { commandId })
      assert.equal(cancelled.status, 202)
      const body = (await cancelled.json()) as { cancelled: boolean }
      assert.equal(body.cancelled, false)
      assert.equal(agent.cancelCalls, 0)
    } finally {
      await api.close()
    }
  })
})

test('cancel: missing commandId is a visible 422, never "cancel whatever is active"', async () => {
  await withTestDatabase(async (db) => {
    const agent = fakeAcpAgentWithCancel()
    const api = await startApiWithConnector(db, agent.connector)
    try {
      const workstreamId = await createWorkstreamWithSession(db, api.port)
      const response = await request(api.port, `/v1/workstreams/${workstreamId}/cancel`, { ...OWNER }, 'POST', {})
      assert.equal(response.status, 422)
    } finally {
      await api.close()
    }
  })
})

test('cancel: no channel ever opened for this Workstream is a 409, not a crash', async () => {
  await withTestDatabase(async (db) => {
    const agent = fakeAcpAgentWithCancel()
    const api = await startApiWithConnector(db, agent.connector)
    try {
      const created = await request(api.port, '/v1/workstreams', { ...OWNER, 'idempotency-key': randomUUID() }, 'POST', { title: 'no session' })
      const { id } = (await created.json()) as { id: string }
      const response = await request(api.port, `/v1/workstreams/${id}/cancel`, { ...OWNER }, 'POST', { commandId: 'x' })
      assert.equal(response.status, 409)
    } finally {
      await api.close()
    }
  })
})
