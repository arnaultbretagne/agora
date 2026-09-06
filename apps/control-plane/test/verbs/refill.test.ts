import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import type { DuplexByteStream } from '@agora/acp'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { appendFact, bindAcpContext, openSession, recordBridgeToken, recordRestoreOrigin } from '@agora/journal'
import { markUnknown, replayDispatch } from '@agora/acp'
import type { VerbContext } from '@agora/engine'
import { createRefillExecutor, UnsupportedVerbError } from '../../src/verbs/refill.js'
import { completeOpeningDescriptor, openingCommandId, openingRequestKey } from '../../src/descriptor.js'

function context(workstreamId: string): VerbContext {
  return { workstreamId, intentSeq: 1, workGeneration: 1, claimToken: 'claim-1', rule: 'SYNC-001' }
}

interface Prompted {
  readonly sessionId: string
  readonly prompts: { sessionId: string; blocks: readonly { type?: string; resource?: { uri?: string; text?: string } }[] }[]
}

function fakeAcpAgent(seen: Prompted['prompts'], options: { failPrompt?: boolean } = {}): { readonly clientStream: DuplexByteStream; readonly close: () => void } {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()
  const clientStream: DuplexByteStream = { writable: aToB.writable, readable: bToA.readable }
  const agentStream: DuplexByteStream = { writable: bToA.writable, readable: aToB.readable }
  const agentApp = acp.agent({ name: 'test-fake-agent' })
  agentApp.onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
  agentApp.onRequest(acp.methods.agent.session.prompt, ({ params }) => {
    const request = params as { sessionId: string; prompt: readonly { type?: string; resource?: { uri?: string; text?: string } }[] }
    seen.push({ sessionId: request.sessionId, blocks: request.prompt })
    if (options.failPrompt === true) throw new Error('the response never came back')
    return { stopReason: 'end_turn' }
  })
  const agentConnection = agentApp.connect(acp.ndJsonStream(agentStream.writable, agentStream.readable))
  return { clientStream, close: () => agentConnection.close?.() }
}

function fakeConnect(agent: ReturnType<typeof fakeAcpAgent>): NonNullable<Parameters<typeof createRefillExecutor>[0]['connect']> {
  return async () => ({ connectionId: 'test-conn', stream: agent.clientStream, close: async () => agent.close(), closed: Promise.resolve() })
}

function startRuntimeControl(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/v1/workstreams/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ pods: [{ name: 'pod-name-1', forcedDeletion: false, incarnation: 'inc-1', podIP: '10.0.0.5' }], obligations: [], complete: true }))
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

/** A Workstream with `factCount` facts, then a Session born after them: W = 0, H = the head. */
async function seed(db: TestDatabase, factCount: number, options: { originW?: number } = {}): Promise<{ workstreamId: string; sessionId: string }> {
  const workstreamId = randomUUID()
  const client = await db.pool.connect()
  try {
    return await db.asRole(client, 'agora_product', async () => {
      await client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
      await client.query('BEGIN')
      // A Workstream with NO earlier Session at all is the only way to get a truly empty range:
      // opening one appends session.opened, which is itself a fact H would then sit above.
      const earlier = factCount === 0 ? null : await openSession(client, workstreamId, { podUid: 'pod-old', provenance: {} })
      for (let i = 0; i < factCount; i += 1) {
        await appendFact(client, workstreamId, {
          sessionId: earlier!.sessionId,
          kind: 'acp.envelope',
          payloadRawText: JSON.stringify({ method: 'session/prompt', params: { sessionId: 'ctx-old', prompt: [{ type: 'text', text: `message ${String(i)}` }] } }),
          acp: {
            direction: 'client_to_agent',
            rpcKind: 'request',
            method: 'session/prompt',
            correlatedMethod: null,
            rpcId: i,
            commandId: null,
            connectionId: 'conn-1',
            observationId: randomUUID(),
            frameSize: 100,
          },
        })
      }
      if (earlier !== null) await client.query('UPDATE sessions SET attribution_ended_at = now() WHERE id = $1', [earlier.sessionId])
      const fresh = await openSession(client, workstreamId, { podUid: 'pod-new', provenance: {} })
      await recordBridgeToken(client, fresh.sessionId, 'bridge-token-1')
      await bindAcpContext(client, fresh.sessionId, { contextId: 'ctx-1', processGeneration: 0 })
      if (options.originW !== undefined) await recordRestoreOrigin(client, fresh.sessionId, { originW: options.originW, saveId: randomUUID() })
      await client.query('COMMIT')
      return { workstreamId, sessionId: fresh.sessionId }
    })
  } finally {
    client.release()
  }
}

test('REFILL delivers the range as an embedded resource, once, and records the response', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, sessionId } = await seed(db, 3)
    const runtimeControl = await startRuntimeControl()
    const prompts: Prompted['prompts'] = []
    try {
      const executor = createRefillExecutor({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        connect: fakeConnect(fakeAcpAgent(prompts)),
      })

      await executor.execute('REFILL', context(workstreamId))

      assert.equal(prompts.length, 1)
      assert.equal(prompts[0]!.sessionId, 'ctx-1')
      const block = prompts[0]!.blocks[0]!
      assert.equal(block.type, 'resource', 'an embedded resource — a link would not deliver bytes')
      assert.match(String(block.resource?.uri), /^agora:\/\/workstreams\/.+\/handoffs\/.+$/)
      assert.match(String(block.resource?.text), /user: message 0/)

      const dispatch = await replayDispatch(db.pool, workstreamId, openingRequestKey(sessionId, { w: 0, h: 4, saveId: null }))
      assert.equal(dispatch?.state, 'responded')
      assert.equal(dispatch?.kind, 'handoff')

      // A second REFILL finds the answered command and sends nothing again.
      await executor.execute('REFILL', context(workstreamId))
      assert.equal(prompts.length, 1)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('CONT-002: an empty range dispatches nothing at all', async () => {
  await withTestDatabase(async (db) => {
    // A Session born on a Workstream with no facts before it: W = H = 0.
    const { workstreamId, sessionId } = await seed(db, 0)
    const runtimeControl = await startRuntimeControl()
    const prompts: Prompted['prompts'] = []
    try {
      const executor = createRefillExecutor({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        connect: fakeConnect(fakeAcpAgent(prompts)),
      })

      await executor.execute('REFILL', context(workstreamId))

      assert.equal(prompts.length, 0, 'an empty prompt would still be a turn to admit, dispatch and prove')
      const client = await db.pool.connect()
      try {
        const rows = await client.query('SELECT * FROM command_dispatches WHERE workstream_id = $1', [workstreamId])
        assert.equal(rows.rowCount, 0)
      } finally {
        client.release()
      }
      assert.ok(sessionId)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('a restored Session refills only the tail its Save could not prove', async () => {
  await withTestDatabase(async (db) => {
    // Four facts before birth, a Save that proved the first two: the range is (2, 4].
    const { workstreamId } = await seed(db, 4, { originW: 2 })
    const runtimeControl = await startRuntimeControl()
    const prompts: Prompted['prompts'] = []
    try {
      const executor = createRefillExecutor({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        connect: fakeConnect(fakeAcpAgent(prompts)),
      })

      await executor.execute('REFILL', context(workstreamId))

      const text = String(prompts[0]!.blocks[0]!.resource?.text)
      assert.match(text, /range=\(2,5\]/)
      assert.ok(!text.includes('message 0'), 'facts the Save proved are not sent again')
      assert.match(text, /message 3/)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('CONT-005: an unresolved Handoff gates REFILL and is never resent', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, sessionId } = await seed(db, 3)
    const runtimeControl = await startRuntimeControl()
    const prompts: Prompted['prompts'] = []
    try {
      // A first attempt whose response was lost: the command is `unknown`.
      const failing = createRefillExecutor({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        connect: fakeConnect(fakeAcpAgent(prompts, { failPrompt: true })),
      })
      await failing.execute('REFILL', context(workstreamId))
      const key = openingRequestKey(sessionId, { w: 0, h: 4, saveId: null })
      assert.equal((await replayDispatch(db.pool, workstreamId, key))?.state, 'unknown')
      assert.equal(prompts.length, 1)

      // The next tick finds it and refuses to send again — on a reconnect or on anything else.
      const retry = createRefillExecutor({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        connect: fakeConnect(fakeAcpAgent(prompts)),
      })
      await retry.execute('REFILL', context(workstreamId))

      assert.equal(prompts.length, 1, 'no blind resend of a prompt the context may already have acted on')
      assert.equal((await replayDispatch(db.pool, workstreamId, key))?.state, 'unknown')
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('the descriptor is completed once: the same range always finds the same command', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, sessionId } = await seed(db, 2)
    const client = await db.pool.connect()
    try {
      await db.asRole(client, 'agora_product', async () => {
        await client.query('BEGIN')
        const first = await completeOpeningDescriptor(client, { workstreamId, sessionId, contextId: 'ctx-1' })
        await client.query('COMMIT')
        await client.query('BEGIN')
        const second = await completeOpeningDescriptor(client, { workstreamId, sessionId, contextId: 'ctx-1' })
        await client.query('COMMIT')

        assert.equal(first?.dispatch?.id, second?.dispatch?.id, 'a second command for one range is a second delivery')
        assert.equal(first?.handoff?.digest, second?.handoff?.digest, 'and the same bytes, so the same digest')
        assert.equal(first?.descriptor.commandId, openingCommandId(openingRequestKey(sessionId, { w: 0, h: 3, saveId: null })))
        assert.equal(first?.descriptor.seedPolicyRevision, 'handoff-seed-v1')
      })
    } finally {
      client.release()
    }
  })
})

test('a degraded rendering is not dispatched without a confirmation', async () => {
  await withTestDatabase(async (db) => {
    // Enough essential content to blow the 512 KiB resource budget.
    const workstreamId = randomUUID()
    const client = await db.pool.connect()
    let sessionId = ''
    try {
      await db.asRole(client, 'agora_product', async () => {
        await client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
        await client.query('BEGIN')
        const earlier = await openSession(client, workstreamId, { podUid: 'pod-old', provenance: {} })
        for (let i = 0; i < 12; i += 1) {
          await appendFact(client, workstreamId, {
            sessionId: earlier.sessionId,
            kind: 'acp.envelope',
            payloadRawText: JSON.stringify({ method: 'session/prompt', params: { sessionId: 'ctx-old', prompt: [{ type: 'text', text: `${String(i)}-${'x'.repeat(64 * 1024)}` }] } }),
            acp: { direction: 'client_to_agent', rpcKind: 'request', method: 'session/prompt', correlatedMethod: null, rpcId: i, commandId: null, connectionId: 'c', observationId: randomUUID(), frameSize: 1 },
          })
        }
        await client.query('UPDATE sessions SET attribution_ended_at = now() WHERE id = $1', [earlier.sessionId])
        const fresh = await openSession(client, workstreamId, { podUid: 'pod-new', provenance: {} })
        sessionId = fresh.sessionId
        await recordBridgeToken(client, fresh.sessionId, 'bridge-token-1')
        await bindAcpContext(client, fresh.sessionId, { contextId: 'ctx-1', processGeneration: 0 })
        await client.query('COMMIT')
      })
    } finally {
      client.release()
    }
    const runtimeControl = await startRuntimeControl()
    const prompts: Prompted['prompts'] = []
    try {
      const unconfirmed = createRefillExecutor({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        connect: fakeConnect(fakeAcpAgent(prompts)),
      })
      await unconfirmed.execute('REFILL', context(workstreamId))
      assert.equal(prompts.length, 0, 'the seed policy requires an answer before a degraded Handoff is sent')

      const confirmed = createRefillExecutor({
        productPool: db.pool,
        runtimeControlBaseUrl: runtimeControl.url,
        bridgePort: 8765,
        degradedConfirmed: async () => true,
        connect: fakeConnect(fakeAcpAgent(prompts)),
      })
      await confirmed.execute('REFILL', context(workstreamId))
      assert.equal(prompts.length, 1)
      assert.match(String(prompts[0]!.blocks[0]!.resource?.text), /fidelity=degraded/)
      assert.ok(sessionId.length > 0)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('REFILL refuses any other verb rather than quietly doing nothing', async () => {
  await withTestDatabase(async (db) => {
    const executor = createRefillExecutor({ productPool: db.pool, runtimeControlBaseUrl: 'http://127.0.0.1:65533', bridgePort: 8765 })
    await assert.rejects(executor.execute('START', context(randomUUID())), UnsupportedVerbError)
  })
})

test('markUnknown is what a lost response leaves behind, and it is never overwritten by a retry', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, sessionId } = await seed(db, 1)
    const client = await db.pool.connect()
    try {
      await db.asRole(client, 'agora_product', async () => {
        await client.query('BEGIN')
        const completed = await completeOpeningDescriptor(client, { workstreamId, sessionId, contextId: 'ctx-1' })
        await client.query('COMMIT')
        await client.query('BEGIN')
        await markUnknown(client, completed!.dispatch!.id)
        await client.query('COMMIT')
        const after = await replayDispatch(client, workstreamId, openingRequestKey(sessionId, { w: 0, h: 2, saveId: null }))
        assert.equal(after?.state, 'unknown')
      })
    } finally {
      client.release()
    }
  })
})
