import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { openSession } from '@agora/journal'
import { markResponded, reserveDispatch } from '@agora/acp'
import {
  buildClientConnection,
  createPersist,
  initializeParams,
  startFakeAgent,
  type DevHarness,
} from '@agora/acp'
import * as acp from '@agentclientprotocol/sdk'
import { createAcpModelProjector, feedAfter, rebuild, runIncremental, stateHash } from '../src/index.js'
import { PRODUCT, PROJECTOR } from './support.js'

const DEBUG = process.env.ACP_DEBUG === '1'
function mark(message: string): void {
  if (DEBUG) console.error(`M: ${message}`)
}

/** The agent's notify resolves at transport-write acceptance, not at the client's capture commit: poll until the fact lands. */
async function waitForAcpFacts(db: TestDatabase, workstreamId: string, count: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = (await db.pool.query("SELECT count(*)::int AS n FROM workstream_facts WHERE workstream_id = $1 AND kind = 'acp.envelope'", [workstreamId])).rows[0]!
    if (Number(row['n']) >= count) return Number(row['n'])
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`expected ${count} acp.envelope facts, never arrived`)
}

async function connect(db: TestDatabase): Promise<pg.PoolClient> {
  return db.pool.connect()
}

async function createWorkstreamWithSession(db: TestDatabase, client: pg.PoolClient): Promise<string> {
  const id = crypto.randomUUID()
  await client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [id, 'owner@example.com', 'w', crypto.randomUUID()])
  await db.asRole(client, PRODUCT, () =>
    withTx(db, client, () => openSession(client, id, { podUid: 'pod-1', provenance: {} }, { nowSql: db.nowSql })),
  )
  return id
}

async function withTx<T>(db: TestDatabase, client: pg.PoolClient, body: () => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    const result = await body()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

interface CapturingChannel {
  readonly connection: acp.ClientConnection
  readonly harness: DevHarness
  readonly runProjectors: () => Promise<void>
  readonly close: () => Promise<void>
}

/** One live ACP channel: harness → journaled duplex (persist per frame, one tx per frame) → SDK client. */
async function openChannel(
  db: TestDatabase,
  client: pg.PoolClient,
  workstreamId: string,
  connectionId: string,
  commandIdFor: (direction: 'client_to_agent' | 'agent_to_client', method: string | null) => string | null = () => null,
): Promise<CapturingChannel> {
  const session = (await db.pool.query('SELECT id FROM sessions WHERE workstream_id = $1 AND attribution_ended_at IS NULL LIMIT 1', [workstreamId])).rows[0]!['id'] as string
  const productClient = await connect(db)
  await productClient.query(`SET ROLE ${PRODUCT}`)
  const persist = createPersist(productClient, { workstreamId, sessionId: session, connectionId, nowSql: db.nowSql, commandIdFor })
  const harness = startFakeAgent({})
  const connection = buildClientConnection(harness.clientStream, persist, {
    onPermissionRequest: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
  })
  const projectorClient = await connect(db)
  await projectorClient.query(`SET ROLE ${PROJECTOR}`)
  const projector = createAcpModelProjector({})
  mark(`channel ${connectionId} open`)
  return {
    connection,
    harness,
    runProjectors: async () => {
      await db.asRole(projectorClient, PROJECTOR, () => runIncremental(projectorClient, workstreamId, projector))
    },
    close: async () => {
      harness.close()
      await productClient.query('RESET ROLE')
      productClient.release()
      projectorClient.release()
      void client
    },
  }
}

test('initialize → session/new → session/prompt round-trips with every envelope captured in order', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await createWorkstreamWithSession(db, client)
      const sessionId = (await db.pool.query('SELECT id FROM sessions WHERE workstream_id = $1 LIMIT 1', [workstreamId])).rows[0]!['id'] as string
      // The prompt is a command: its dispatch is reserved before the send, and the outbound
      // envelope carries the command id the turn folds on.
      const commandId = crypto.randomUUID()
      await db.asRole(client, PRODUCT, () =>
        withTx(db, client, () =>
          reserveDispatch(client, { workstreamId, sessionId, kind: 'prompt', request: { text: 'bonjour' }, requestKey: 'prompt-1' }),
        ),
      )
      const channel = await openChannel(db, client, workstreamId, 'conn-1', (direction, method) =>
        direction === 'client_to_agent' && method === 'session/prompt' ? commandId : null,
      )

      const initialize = (await channel.connection.agent.request(acp.methods.agent.initialize, initializeParams('/workspace'))) as { protocolVersion: number }
      mark('initialize resolved')
      assert.equal(initialize.protocolVersion, 1)
      const created = (await channel.connection.agent.request(acp.methods.agent.session.new, { cwd: '/workspace', mcpServers: [] })) as { sessionId: string }
      mark('session/new resolved')
      assert.equal(created.sessionId, 'acp-dev-session')
      const prompt = (await channel.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'bonjour' }],
      })) as { stopReason: string }
      mark('prompt resolved')
      assert.equal(prompt.stopReason, 'end_turn')
      await db.asRole(client, PRODUCT, () => withTx(db, client, () => markResponded(client, commandId)))
      await channel.runProjectors()
      mark('projectors ran')
      // Close before asserting: the ACP channel holds pool clients, and withTestDatabase cannot
      // settle while any client is unreleased — an assertion failure must surface, never park.
      await channel.close()

      const facts = (await db.pool.query("SELECT seq, direction, rpc_kind, method, correlated_method FROM workstream_facts WHERE workstream_id = $1 AND kind = 'acp.envelope' ORDER BY seq", [workstreamId])).rows as Array<Record<string, unknown>>
      const methods = facts.map((fact) => `${fact['direction']}:${fact['rpc_kind']}:${fact['method'] ?? fact['correlated_method']}`)
      assert.deepEqual(methods, [
        'client_to_agent:request:initialize',
        'agent_to_client:response:initialize',
        'client_to_agent:request:session/new',
        'agent_to_client:response:session/new',
        'client_to_agent:request:session/prompt',
        'agent_to_client:notification:session/update',
        'agent_to_client:request:session/request_permission',
        'client_to_agent:response:session/request_permission',
        'agent_to_client:response:session/prompt',
      ])

      const items = (await db.pool.query('SELECT item_kind, value FROM projection_items WHERE workstream_id = $1 ORDER BY first_seq', [workstreamId])).rows as Array<Record<string, unknown>>
      // BOTH halves of the conversation, in the order they were said. The operator's own message
      // used to be in no projection at all — the record kept the agent's answers and not the
      // questions, and the browser filled the gap with a local echo that rendered after the answer
      // and disappeared on reload.
      assert.deepEqual(items.map((item) => item['item_kind']), ['message', 'message', 'permission'])
      const asked = items[0]!['value'] as { role: string; completed: boolean; content: Array<{ type: string; text?: string }> }
      assert.equal(asked.role, 'user')
      assert.equal(asked.content.map((block) => block.text ?? '').join(''), 'bonjour')
      const messageValue = items[1]!['value'] as { role: string; completed: boolean; content: Array<{ type: string; text?: string }> }
      assert.equal(messageValue.role, 'agent')
      assert.equal(messageValue.completed, true)
      assert.equal(messageValue.content.map((block) => block.text ?? '').join(''), 'hello from the fake agent')
      assert.equal((items[2]!['value'] as Record<string, unknown>)['status'], 'decided')

      const turns = (await db.pool.query('SELECT status, stop_reason FROM projection_turns WHERE workstream_id = $1', [workstreamId])).rows
      assert.deepEqual(turns.map((row) => [row['status'], row['stop_reason']]), [['completed', 'end_turn']])

      const feed = await feedAfter(db.pool, workstreamId, 0)
      assert.ok(feed.length >= 3, 'messages, permissions and the turn status reached the feed')
    } finally {
      client.release()
    }
  })
})

test('a frame from a replaced connection keeps its original connection attribution (SESSION-A05)', async () => {
  await withTestDatabase(async (db) => {
    const client1 = await connect(db)
    const client2 = await connect(db)
    try {
      const workstreamId = await createWorkstreamWithSession(db, client2)
      const old = await openChannel(db, client1, workstreamId, 'conn-1')

      // A late frame crosses the OLD connection: it must be attributed to conn-1 even though a
      // successor connection now exists.
      await old.harness.notifyUpdate('acp-dev-session', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'late frame' },
      })
      await waitForAcpFacts(db, workstreamId, 1)

      const fact = (await db.pool.query("SELECT connection_id FROM workstream_facts WHERE workstream_id = $1 AND kind = 'acp.envelope' ORDER BY seq", [workstreamId])).rows[0]!
      assert.equal(fact['connection_id'], 'conn-1', 'receipt on the new connection cannot relabel the old frame')
      await old.close()
    } finally {
      client1.release()
      client2.release()
    }
  })
})

test('an unknown discriminator lands in the unknown bucket; rebuild equals incremental', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await createWorkstreamWithSession(db, client)
      const sessionId = (await db.pool.query('SELECT id FROM sessions WHERE workstream_id = $1 LIMIT 1', [workstreamId])).rows[0]!['id'] as string
      const channel = await openChannel(db, client, workstreamId, 'conn-1')

      // A synthetic extension notification — accepted at capture, preserved, bucketed as unknown.
      await channel.harness.notifyExtension('vendor/example', { opaque: { retained: true } })
      await waitForAcpFacts(db, workstreamId, 1)
      await channel.runProjectors()
      await channel.close()

      const unknownItems = (await db.pool.query("SELECT value FROM projection_items WHERE workstream_id = $1 AND item_kind = 'unknown'", [workstreamId])).rows
      assert.equal(unknownItems.length, 1)
      assert.equal((unknownItems[0]!['value'] as Record<string, unknown>)['method'], 'vendor/example')

      // A future discriminator under a known method is rejected at the capture seam itself:
      // diagnostic, never a canonical fact (findings §1).
      const futureUpdate = JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'acp-dev-session', update: { sessionUpdate: 'future_update_variant', futurePayload: { retained: true } } },
      })
      const productClient = await connect(db)
      await productClient.query(`SET ROLE ${PRODUCT}`)
      const persist = createPersist(productClient, { workstreamId, sessionId, connectionId: 'conn-check', nowSql: db.nowSql, commandIdFor: () => null })
      await assert.rejects(() => persist('agent_to_client', futureUpdate), /acp_protocol_error:method_schema/)
      await productClient.query('RESET ROLE')
      productClient.release()
      const facts = (await db.pool.query("SELECT count(*)::int AS n FROM workstream_facts WHERE workstream_id = $1 AND kind = 'acp.envelope'", [workstreamId])).rows[0]!['n']
      assert.equal(facts, 1, 'the rejected update produced no fact')

      const projectorClient = await connect(db)
      await projectorClient.query(`SET ROLE ${PROJECTOR}`)
      const projector = createAcpModelProjector({})
      const incrementalHash = await db.asRole(projectorClient, PROJECTOR, () => stateHash(projectorClient, workstreamId, projector))
      await db.asRole(projectorClient, PROJECTOR, () => rebuild(projectorClient, workstreamId, projector))
      const rebuildHash = await db.asRole(projectorClient, PROJECTOR, () => stateHash(projectorClient, workstreamId, projector))
      assert.equal(rebuildHash, incrementalHash)
      projectorClient.release()
    } finally {
      client.release()
    }
  })
})
