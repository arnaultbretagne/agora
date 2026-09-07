import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import type { DuplexByteStream } from '@agora/acp'
import { withTestDatabase } from '@agora/testkit'
import { openSession, bindAcpContext } from '@agora/journal'
import { AgentChannels, type ChannelConnector } from '../src/agent-channel.js'

/** A real ACP agent over an in-process duplex, recording which methods it was actually asked. */
function recordingAgent(): { readonly clientStream: DuplexByteStream; readonly methods: string[]; readonly close: () => void } {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()
  const methods: string[] = []
  const app = acp.agent({ name: 'recording-agent' })
  app.onRequest(acp.methods.agent.session.resume, () => {
    methods.push('session/resume')
    return { configOptions: [] }
  })
  app.onRequest(acp.methods.agent.session.new, () => {
    methods.push('session/new')
    return { sessionId: 'fresh' }
  })
  const connection = app.connect(acp.ndJsonStream(bToA.writable, aToB.readable))
  return { clientStream: { writable: aToB.writable, readable: bToA.readable }, methods, close: () => connection.close?.() }
}

function connectorFor(agent: ReturnType<typeof recordingAgent>, contextId: string): ChannelConnector {
  return { connect: async () => ({ stream: agent.clientStream, close: () => agent.close(), existingContextId: contextId }) }
}

async function seed(pool: import('pg').Pool, nowSql: string, harness: string): Promise<{ workstreamId: string; contextId: string }> {
  const workstreamId = randomUUID()
  const contextId = randomUUID()
  const client = await pool.connect()
  try {
    await client.query('SET ROLE agora_product')
    await client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'o@example.com', 'w', randomUUID()])
    await client.query(
      `INSERT INTO workstream_intent_events (workstream_id, intent_seq, principal, request_key, intent, revision_set)
       VALUES ($1, 1, 'o@example.com', $2, $3::jsonb, '{}'::jsonb)`,
      [workstreamId, randomUUID(), JSON.stringify({ power: 'on', harness, model: 'm', effort: 'default', capabilities: [], persona: 'default' })],
    )
    await client.query('BEGIN')
    const opened = await openSession(client, workstreamId, { podUid: 'pod-1', provenance: {} }, { nowSql })
    await bindAcpContext(client, opened.sessionId, { contextId, processGeneration: 0 })
    await client.query('COMMIT')
  } finally {
    await client.query('RESET ROLE').catch(() => {})
    client.release()
  }
  return { workstreamId, contextId }
}

test('S13: a harness that does not persist an empty context is attached WITHOUT session/resume', async () => {
  // codex answers `Internal error: no rollout found for thread id` when asked to resume a context
  // that has never been prompted — which is every context between START and the first prompt. Live,
  // that failed every first prompt to a codex Workstream before dispatch. The catalogue already
  // states this per harness (`configReadback`), so the channel reuses that fact.
  await withTestDatabase(async (db) => {
    const { workstreamId, contextId } = await seed(db.pool, db.nowSql, 'codex')
    const agent = recordingAgent()
    const channels = new AgentChannels({
      pool: db.pool,
      nowSql: db.nowSql,
      connector: connectorFor(agent, contextId),
      configReadback: new Map([['codex', 'set-config-noop']]),
    })
    const sessionId = await db.pool.query('SELECT id FROM sessions WHERE workstream_id = $1', [workstreamId])
    const channel = await channels.ensure(workstreamId, sessionId.rows[0]!['id'] as string)
    assert.equal(channel.acpSessionId, contextId, 'the bound context is used as it is')
    assert.deepEqual(agent.methods, [], 'nothing was asked of the adapter to attach')
    await channels.close(workstreamId)
  })
})

test('S13: a harness whose contexts survive a resume still gets one', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, contextId } = await seed(db.pool, db.nowSql, 'claude-code')
    const agent = recordingAgent()
    const channels = new AgentChannels({
      pool: db.pool,
      nowSql: db.nowSql,
      connector: connectorFor(agent, contextId),
      configReadback: new Map([['claude-code', 'resume'], ['codex', 'set-config-noop']]),
    })
    const sessionId = await db.pool.query('SELECT id FROM sessions WHERE workstream_id = $1', [workstreamId])
    await channels.ensure(workstreamId, sessionId.rows[0]!['id'] as string)
    assert.deepEqual(agent.methods, ['session/resume'])
    await channels.close(workstreamId)
  })
})
