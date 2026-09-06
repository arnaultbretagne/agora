import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import type { DuplexByteStream } from '@agora/acp'
import { markDispatched, markResponded, markUnknown, reserveDispatch } from '@agora/acp'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { bindAcpContext, openSession, recordBridgeToken } from '@agora/journal'
import { recoverPromptDelivery, type PromptRecoveryOptions } from '../../src/recovery/context.js'

const CONTEXT_ID = 'ctx-1'

interface RuntimeControlStub {
  readonly server: Server
  readonly url: string
}

function startRuntimeControl(processGeneration: number): Promise<RuntimeControlStub> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? ''
      if (url.startsWith('/v1/workstreams/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ pods: [{ name: 'pod-1', forcedDeletion: false, podIP: '10.0.0.5' }], obligations: [], complete: true }))
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

/**
 * A fake agent whose `session/load` replays a scripted history as `session/update` notifications —
 * the exact shape measured against the real adapter on 2026-09-06 (harnesses/claude-code/README.md):
 * `{sessionId, update: {sessionUpdate: 'user_message_chunk'|'agent_message_chunk', content: {type:'text', text}}}`.
 */
function fakeAgentReplaying(history: readonly { role: 'user' | 'agent'; text: string }[]): {
  readonly clientStream: DuplexByteStream
  readonly close: () => void
  loadCalls: number
} {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()
  const clientStream: DuplexByteStream = { writable: aToB.writable, readable: bToA.readable }
  const agentStream: DuplexByteStream = { writable: bToA.writable, readable: aToB.readable }
  const agentApp = acp.agent({ name: 'replaying-fake-agent' })
  const counters = { loadCalls: 0 }
  agentApp.onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
  agentApp.onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    counters.loadCalls += 1
    const sessionId = (params as { sessionId: string }).sessionId
    for (const entry of history) {
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: entry.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: entry.text },
        },
      })
    }
    return {}
  })
  const agentConnection = agentApp.connect(acp.ndJsonStream(agentStream.writable, agentStream.readable))
  return {
    clientStream,
    close: () => agentConnection.close?.(),
    get loadCalls() {
      return counters.loadCalls
    },
  }
}

function recoveryOptions(db: TestDatabase, runtimeControlUrl: string, agent: ReturnType<typeof fakeAgentReplaying>): PromptRecoveryOptions {
  return {
    productPool: db.pool,
    runtimeControlBaseUrl: runtimeControlUrl,
    bridgePort: 8765,
    connect: async () => ({ connectionId: 'c1', stream: agent.clientStream, close: async () => agent.close(), closed: Promise.resolve() }),
  }
}

interface Seeded {
  readonly workstreamId: string
  readonly sessionId: string
  readonly commandIds: readonly string[]
}

/** Seeds a Session bound to CONTEXT_ID at generation 0, plus the given prompt history through the real dispatch state machine. */
async function seed(db: TestDatabase, prompts: readonly { text: string; state: 'responded' | 'unknown' }[]): Promise<Seeded> {
  const workstreamId = randomUUID()
  await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
  const client = await db.pool.connect()
  const commandIds: string[] = []
  try {
    await client.query('BEGIN')
    const opened = await openSession(client, workstreamId, { podUid: 'pod-a', provenance: {} })
    await client.query('COMMIT')
    await client.query('BEGIN')
    await recordBridgeToken(client, opened.sessionId, 'bridge-token-1')
    await bindAcpContext(client, opened.sessionId, { contextId: CONTEXT_ID, processGeneration: 0 })
    await client.query('COMMIT')

    for (const prompt of prompts) {
      await client.query('BEGIN')
      const dispatch = await reserveDispatch(client, {
        workstreamId,
        sessionId: opened.sessionId,
        kind: 'prompt',
        request: { text: prompt.text },
        requestKey: randomUUID(),
      })
      await markDispatched(client, dispatch.id)
      if (prompt.state === 'responded') await markResponded(client, dispatch.id)
      else await markUnknown(client, dispatch.id)
      await client.query('COMMIT')
      commandIds.push(dispatch.id)
    }
    return { workstreamId, sessionId: opened.sessionId, commandIds }
  } finally {
    client.release()
  }
}

async function stateOf(db: TestDatabase, commandId: string): Promise<string> {
  const row = await db.pool.query('SELECT state FROM command_dispatches WHERE id = $1', [commandId])
  return row.rows[0]!['state'] as string
}

test('CONT-005: the replay shows the ambiguous prompt AND a reply — settled as delivered, never re-sent', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db, [{ text: 'bonjour', state: 'unknown' }])
    const runtimeControl = await startRuntimeControl(0)
    const agent = fakeAgentReplaying([
      { role: 'user', text: 'bonjour' },
      { role: 'agent', text: 'salut' },
    ])
    try {
      const verdict = await recoverPromptDelivery(recoveryOptions(db, runtimeControl.url, agent), seeded.workstreamId)
      assert.deepEqual(verdict, { kind: 'delivered', commandId: seeded.commandIds[0], answered: true })
      assert.equal(await stateOf(db, seeded.commandIds[0]!), 'responded')
      assert.equal(agent.loadCalls, 1)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('CONT-005: the replay shows the prompt with no reply — delivered but unanswered, still not re-sent', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db, [{ text: 'bonjour', state: 'unknown' }])
    const runtimeControl = await startRuntimeControl(0)
    const agent = fakeAgentReplaying([{ role: 'user', text: 'bonjour' }])
    try {
      const verdict = await recoverPromptDelivery(recoveryOptions(db, runtimeControl.url, agent), seeded.workstreamId)
      assert.deepEqual(verdict, { kind: 'delivered', commandId: seeded.commandIds[0], answered: false })
      assert.equal(await stateOf(db, seeded.commandIds[0]!), 'responded')
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('CONT-005: the replay has no trace of it — provably never sent, so it becomes rejected_before_acceptance', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db, [{ text: 'bonjour', state: 'unknown' }])
    const runtimeControl = await startRuntimeControl(0)
    const agent = fakeAgentReplaying([])
    try {
      const verdict = await recoverPromptDelivery(recoveryOptions(db, runtimeControl.url, agent), seeded.workstreamId)
      assert.deepEqual(verdict, { kind: 'never_delivered', commandId: seeded.commandIds[0] })
      assert.equal(await stateOf(db, seeded.commandIds[0]!), 'rejected_before_acceptance')
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('CONT-005: an earlier answered prompt shifts the position — the second prompt is matched at its own index', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db, [
      { text: 'premier', state: 'responded' },
      { text: 'second', state: 'unknown' },
    ])
    const runtimeControl = await startRuntimeControl(0)
    const agent = fakeAgentReplaying([
      { role: 'user', text: 'premier' },
      { role: 'agent', text: 'réponse au premier' },
      { role: 'user', text: 'second' },
    ])
    try {
      const verdict = await recoverPromptDelivery(recoveryOptions(db, runtimeControl.url, agent), seeded.workstreamId)
      assert.deepEqual(verdict, { kind: 'delivered', commandId: seeded.commandIds[1], answered: false })
      assert.equal(await stateOf(db, seeded.commandIds[1]!), 'responded')
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('CONT-005: only the earlier prompt is in the replay — the ambiguous second one provably never landed', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db, [
      { text: 'premier', state: 'responded' },
      { text: 'second', state: 'unknown' },
    ])
    const runtimeControl = await startRuntimeControl(0)
    const agent = fakeAgentReplaying([
      { role: 'user', text: 'premier' },
      { role: 'agent', text: 'réponse au premier' },
    ])
    try {
      const verdict = await recoverPromptDelivery(recoveryOptions(db, runtimeControl.url, agent), seeded.workstreamId)
      assert.deepEqual(verdict, { kind: 'never_delivered', commandId: seeded.commandIds[1] })
      assert.equal(await stateOf(db, seeded.commandIds[1]!), 'rejected_before_acceptance')
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('CONT-005: the histories disagree at that position — unresolved, and the record is left exactly as it was', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db, [{ text: 'bonjour', state: 'unknown' }])
    const runtimeControl = await startRuntimeControl(0)
    const agent = fakeAgentReplaying([{ role: 'user', text: 'something else entirely' }])
    try {
      const verdict = await recoverPromptDelivery(recoveryOptions(db, runtimeControl.url, agent), seeded.workstreamId)
      assert.equal(verdict.kind, 'unresolved')
      assert.equal(await stateOf(db, seeded.commandIds[0]!), 'unknown', 'never guessed away')
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('CONT-005: a moved process generation is unresolved — SESSION-A06 retires it, recovery never reaches across', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db, [{ text: 'bonjour', state: 'unknown' }])
    const runtimeControl = await startRuntimeControl(1)
    const agent = fakeAgentReplaying([{ role: 'user', text: 'bonjour' }])
    try {
      const verdict = await recoverPromptDelivery(recoveryOptions(db, runtimeControl.url, agent), seeded.workstreamId)
      assert.equal(verdict.kind, 'unresolved')
      assert.equal(agent.loadCalls, 0, 'never even connects across a retired generation')
      assert.equal(await stateOf(db, seeded.commandIds[0]!), 'unknown')
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('CONT-005: nothing ambiguous to resolve is reported as such, not as a failure', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db, [{ text: 'bonjour', state: 'responded' }])
    const runtimeControl = await startRuntimeControl(0)
    const agent = fakeAgentReplaying([])
    try {
      const verdict = await recoverPromptDelivery(recoveryOptions(db, runtimeControl.url, agent), seeded.workstreamId)
      assert.deepEqual(verdict, { kind: 'nothing_to_recover' })
      assert.equal(agent.loadCalls, 0)
    } finally {
      runtimeControl.server.close()
    }
  })
})

test('CONT-005: an unreachable runtime-control is unresolved, never a thrown failure the caller must handle', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db, [{ text: 'bonjour', state: 'unknown' }])
    const agent = fakeAgentReplaying([])
    const verdict = await recoverPromptDelivery(
      { ...recoveryOptions(db, 'http://127.0.0.1:65533', agent), logger: () => {} },
      seeded.workstreamId,
    )
    assert.equal(verdict.kind, 'unresolved')
    assert.equal(await stateOf(db, seeded.commandIds[0]!), 'unknown')
  })
})
