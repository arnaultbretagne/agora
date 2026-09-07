import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import type { DuplexByteStream } from '@agora/acp'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { openSession, recordBridgeToken, bindAcpContext } from '@agora/journal'
import { mintBridgeToken, reserveDispatch } from '@agora/acp'
import { AgentChannels } from '../src/agent-channel.js'
import { RealChannelConnector, NoBridgeAvailableError } from '../src/real-channel-connector.js'

interface RuntimeControlStub {
  readonly server: Server
  readonly url: string
}

function startRuntimeControl(pods: readonly unknown[], processGeneration: number, onRenewal?: () => void): Promise<RuntimeControlStub> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? ''
      if (url.endsWith('/bridge-token')) {
        onRenewal?.()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ bridgeToken: mintBridgeToken('inc-1', 'channel-test-secret') }))
        return
      }
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

function fakeAcpAgent(): { readonly clientStream: DuplexByteStream; readonly close: () => void; resumeCalls: { sessionId: string }[] } {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()
  const clientStream: DuplexByteStream = { writable: aToB.writable, readable: bToA.readable }
  const agentStream: DuplexByteStream = { writable: bToA.writable, readable: aToB.readable }
  const agentApp = acp.agent({ name: 'test-fake-agent' })
  const resumeCalls: { sessionId: string }[] = []
  agentApp.onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }))
  agentApp.onRequest(acp.methods.agent.session.resume, ({ params }) => {
    resumeCalls.push(params as { sessionId: string })
    return { configOptions: [] }
  })
  agentApp.onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const prompt = params as { sessionId: string }
    await client.notify(acp.methods.client.session.update, {
      sessionId: prompt.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from the real bridge' } },
    })
    return { stopReason: 'end_turn' }
  })
  const agentConnection = agentApp.connect(acp.ndJsonStream(agentStream.writable, agentStream.readable))
  return { clientStream, close: () => agentConnection.close?.(), resumeCalls }
}

async function seedLiveSession(db: TestDatabase, workstreamId: string, acpContextId: string, processGeneration: number, bridgeToken = mintBridgeToken('inc-1', 'channel-test-secret')): Promise<string> {
  await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    const opened = await openSession(client, workstreamId, { podUid: 'pod-a', provenance: {} })
    await client.query('COMMIT')
    await client.query('BEGIN')
    await recordBridgeToken(client, opened.sessionId, bridgeToken)
    await client.query('COMMIT')
    await client.query('BEGIN')
    await bindAcpContext(client, opened.sessionId, { contextId: acpContextId, processGeneration })
    await client.query('COMMIT')
    return opened.sessionId
  } finally {
    client.release()
  }
}

test('RealChannelConnector: resumes the already-bound context, never a fresh session/new', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    const sessionId = await seedLiveSession(db, workstreamId, 'ctx-1', 0)
    const runtimeControl = await startRuntimeControl([{ name: 'pod-1', forcedDeletion: false, podIP: '10.0.0.5', incarnation: 'inc-1' }], 0)
    try {
      const agent = fakeAcpAgent()
      const connector = new RealChannelConnector({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        connect: async () => ({ connectionId: 'c1', stream: agent.clientStream, close: async () => agent.close(), closed: Promise.resolve() }),
      })
      const channels = new AgentChannels({ pool: db.pool, connector })
      try {
        const channel = await channels.ensure(workstreamId, sessionId)
        assert.equal(channel.acpSessionId, 'ctx-1')
        assert.equal(agent.resumeCalls.length, 1)
        assert.equal(agent.resumeCalls[0]!.sessionId, 'ctx-1')
      } finally {
        await channels.closeAll()
      }
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('RealChannelConnector: a real prompt turn round-trips through the bridge and is captured', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    const sessionId = await seedLiveSession(db, workstreamId, 'ctx-1', 0)
    const runtimeControl = await startRuntimeControl([{ name: 'pod-1', forcedDeletion: false, podIP: '10.0.0.5', incarnation: 'inc-1' }], 0)
    try {
      const agent = fakeAcpAgent()
      const connector = new RealChannelConnector({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        connect: async () => ({ connectionId: 'c1', stream: agent.clientStream, close: async () => agent.close(), closed: Promise.resolve() }),
      })
      const channels = new AgentChannels({ pool: db.pool, connector })
      try {
        await channels.ensure(workstreamId, sessionId)
        const commandClient = await db.pool.connect()
        let commandId: string
        try {
          await commandClient.query('SET ROLE agora_product')
          await commandClient.query('BEGIN')
          const reserved = await reserveDispatch(commandClient, { workstreamId, sessionId, kind: 'prompt', request: { text: 'bonjour' }, requestKey: randomUUID() })
          await commandClient.query('COMMIT')
          commandId = reserved.id
        } finally {
          await commandClient.query('RESET ROLE').catch(() => {})
          commandClient.release()
        }
        await channels.prompt(workstreamId, commandId, 'bonjour')
        const dispatch = await db.pool.query('SELECT state FROM command_dispatches WHERE id = $1', [commandId])
        assert.equal(dispatch.rows[0]!['state'], 'responded')
      } finally {
        await channels.closeAll()
      }
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('RealChannelConnector: no bound context yet refuses with a typed error', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const connector = new RealChannelConnector({ productPool: db.pool, runtimeControlBaseUrl: 'http://127.0.0.1:1', bridgePort: 8765 })
    await assert.rejects(() => connector.connect(workstreamId), NoBridgeAvailableError)
  })
})

test('RealChannelConnector: a stale (older-generation) binding refuses rather than resuming a dead process', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await seedLiveSession(db, workstreamId, 'ctx-1', 0)
    const runtimeControl = await startRuntimeControl([{ name: 'pod-1', forcedDeletion: false, podIP: '10.0.0.5', incarnation: 'inc-1' }], 1)
    try {
      const connector = new RealChannelConnector({ productPool: db.pool, runtimeControlBaseUrl: runtimeControl.url, bridgePort: 8765 })
      await assert.rejects(() => connector.connect(workstreamId), NoBridgeAvailableError)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('a prompt arriving after the token expired renews it rather than failing: a converged Workstream never ticked', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    // Converged for two hours, then someone types. Nothing ran a tick in between, so the observation
    // never had a chance to renew — this path is the only thing standing between the person and a
    // `403 expired` from the Pod's bridge.
    const spent = mintBridgeToken('inc-1', 'channel-test-secret', 3600, Date.now() - 7200_000)
    const sessionId = await seedLiveSession(db, workstreamId, 'ctx-1', 0, spent)
    let renewals = 0
    const runtimeControl = await startRuntimeControl([{ name: 'pod-1', forcedDeletion: false, podIP: '10.0.0.5', incarnation: 'inc-1' }], 0, () => {
      renewals += 1
    })
    try {
      const agent = fakeAcpAgent()
      const used: string[] = []
      const connector = new RealChannelConnector({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        connect: async (options) => {
          used.push(options.token)
          return { connectionId: 'c1', stream: agent.clientStream, close: async () => agent.close(), closed: Promise.resolve() }
        },
      })
      const connection = await connector.connect(workstreamId)
      await connection.close()
      assert.equal(renewals, 1)
      assert.equal(used.length, 1)
      assert.notEqual(used[0], spent, 'the channel connected with the renewed token')
      const stored = (await db.pool.query('SELECT bridge_token FROM sessions WHERE id = $1', [sessionId])).rows[0] as { bridge_token: string }
      assert.equal(stored.bridge_token, used[0])
    } finally {
      runtimeControl.server.close()
    }
  })
})
