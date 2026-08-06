import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import type pg from 'pg'
import { promptSession } from '@agora/acp'
import { principalId, workstreamId } from '@agora/domain'
import { createWorkstreamWithFirstSession, getAnchor, projectWorkstream } from '@agora/store-pg'
import { createHttpBrokerGrantClient } from '../src/broker-grant-client.js'
import { SessionConnectionRegistry } from '../src/connections.js'
import { provisionSessionAndPrompt, suspendSession, switchAgent } from '../src/orchestration.js'
import { startFakeBroker, type FakeBrokerHandle } from './support/fake-broker.js'
import { startFakeController, type FakeControllerHandle } from './support/fake-controller.js'
import { randomId, withTestDatabase } from './support.js'

let broker: FakeBrokerHandle
let brokerGrantClient: ReturnType<typeof createHttpBrokerGrantClient>

test.before(async () => {
  broker = await startFakeBroker()
  brokerGrantClient = createHttpBrokerGrantClient(broker.baseUrl)
})
test.after(async () => {
  await broker.close()
})

function launchEnvelope(agentId: string) {
  return {
    agentId,
    workspaceSpec: { root: '/work' },
    equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
    runtimeDefinitionVersion: 'v1',
  }
}

async function seedWorkstream(pool: pg.Pool, agentId = 'fake-agent') {
  const client = await pool.connect()
  try {
    const wsId = workstreamId(randomId())
    const sessionId = randomId()
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title: 'Handoff test', owner: principalId('alice'), createdAt: new Date() },
      session: { id: sessionId as never, ordinal: 1, launchEnvelope: launchEnvelope(agentId) },
      runtimeDefinitionVersion: 'v1',
    })
    return { workstreamId: wsId as string, sessionId }
  } finally {
    client.release()
  }
}

async function sessionPhase(pool: pg.Pool, sessionId: string): Promise<string> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ phase: string }>('SELECT phase FROM product.sessions WHERE id = $1', [sessionId])
    return rows[0]?.phase ?? 'MISSING'
  } finally {
    client.release()
  }
}

async function waitForPhase(pool: pg.Pool, sessionId: string, phase: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = await sessionPhase(pool, sessionId)
    if (current === phase) return current
    if (Date.now() > deadline) return current
    await sleep(50)
  }
}

async function project(pool: pg.Pool, wsId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await projectWorkstream(client, wsId, new Date())
  } finally {
    client.release()
  }
}

/** Waits for the (session-scoped) Handoff to reach a terminal outcome — not just Session phase
 * 'ready', which flips BEFORE the post-resume/post-provision Handoff prompt round-trip finishes.
 * Polling this (instead of a blind sleep) is what actually proves the whole fire-and-forget chain
 * has settled — both for correct assertions AND to avoid the pool closing under a still-in-flight
 * dispatch under full-suite load. */
async function waitForHandoffSettled(pool: pg.Pool, wsId: string, sessionId: string, timeoutMs = 15_000): Promise<HandoffValue> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await project(pool, wsId)
    const items = await findHandoffItems(pool, wsId, sessionId)
    const item = items[0]
    if (item && item.value.targetOutcome !== 'pending') return item.value
    if (Date.now() > deadline) throw new Error(`Handoff to Session ${sessionId} did not settle within ${timeoutMs}ms`)
    await sleep(50)
  }
}

async function withClient<T>(pool: pg.Pool, body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    return await body(client)
  } finally {
    client.release()
  }
}

async function headSeq(pool: pg.Pool, wsId: string): Promise<number> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ last_event_seq: number }>('SELECT last_event_seq FROM product.workstreams WHERE id = $1', [wsId])
    return rows[0]?.last_event_seq ?? 0
  } finally {
    client.release()
  }
}

interface HandoffValue {
  readonly sourceFromSeq: number
  readonly sourceThroughSeq: number
  readonly seedPolicyVersion: string
  readonly digest: string
  readonly fidelity: 'complete' | 'degraded'
  readonly targetOutcome: 'pending' | 'completed' | 'failed'
}

async function findHandoffItems(pool: pg.Pool, wsId: string, sessionId: string): Promise<{ id: string; value: HandoffValue }[]> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ id: string; current_value: HandoffValue }>(
      `SELECT id, current_value FROM projection.workstream_items WHERE workstream_id = $1 AND session_id = $2 AND item_kind = 'handoff'`,
      [wsId, sessionId],
    )
    return rows.map((r) => ({ id: r.id, value: r.current_value }))
  } finally {
    client.release()
  }
}

const equipmentRequest = { catalogueVersion: '2026-08-01', resources: [] }
const actor = { kind: 'human' as const, id: 'alice' }

test('required exit criterion: full A -> B -> A handoff — B (new Agent) gets (0, C], A gets exactly (C, D]', async () => {
  await withTestDatabase(async (pool) => {
    const custodyController = await startFakeController({}, pool)
    try {
      const { workstreamId: wsId, sessionId: sessionA } = await seedWorkstream(pool, 'fake-agent')
      const connections = new SessionConnectionRegistry()

      await provisionSessionAndPrompt({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        sessionId: sessionA,
        agentId: 'fake-agent',
        runtimeDefinitionVersion: 'v1',
        initialPrompt: [{ type: 'text', text: 'A turn 1' }],
        actor,
      })
      await waitForPhase(pool, sessionA, 'ready')
      await project(pool, wsId)
      const acpSessionIdA = connections.get(sessionA)?.acpSessionId
      const acpConnectionA = connections.get(sessionA)?.connection
      assert.ok(acpSessionIdA)
      assert.ok(acpConnectionA)

      await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId: sessionA, idempotencyKey: randomId() })
      assert.equal(await sessionPhase(pool, sessionA), 'suspended')
      assert.equal(connections.get(sessionA), undefined, 'suspend must drop the live connection')
      // The suspend's own session/cancel notification is itself a canonical event — catch the
      // projector up to it before reading the true Anchor watermark or building any Handoff.
      await project(pool, wsId)
      const C = (await withClient(pool, (c) => getAnchor(c, wsId, 'fake-agent')))?.syncedThroughSeq
      assert.ok(typeof C === 'number' && C > 0)

      // required: "A new Agent receives policy-selected (0,D]" — here D=C, B is brand new.
      const switchToB = await switchAgent({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        agentId: 'fake-agent-b',
        runtimeDefinitionVersion: 'v1',
        workspaceRef: 'ws-1',
        equipmentRequest,
        actor,
        idempotencyKey: 'switch-to-b',
      })
      assert.ok(switchToB.ok, switchToB.ok ? '' : switchToB.detail)
      const sessionB = switchToB.ok ? switchToB.sessionId : ''
      assert.notEqual(sessionB, sessionA)
      await waitForPhase(pool, sessionB, 'ready')
      await waitForHandoffSettled(pool, wsId, sessionB)

      const handoffsToB = await findHandoffItems(pool, wsId, sessionB)
      assert.equal(handoffsToB.length, 1)
      assert.equal(handoffsToB[0]!.value.sourceFromSeq, 0)
      assert.equal(handoffsToB[0]!.value.sourceThroughSeq, C)
      assert.equal(handoffsToB[0]!.value.seedPolicyVersion, 'handoff-v1')

      const liveB = connections.get(sessionB)
      assert.ok(liveB)
      // The fake driver's own default ACP session id ('fake-acp-session') is a per-connection
      // constant, so it can coincide across two independent Agent identities in this harness —
      // the real signal is that B got a genuinely SEPARATE connection object, never A's.
      assert.notEqual(liveB.connection, acpConnectionA, "B must never reuse A's live ACP connection/authority")

      // B does its own work — head advances from C to D.
      await promptSession({
        pool,
        workstreamId: wsId,
        sessionId: sessionB,
        connection: liveB.connection,
        storePersist: liveB.storePersist,
        acpSessionId: liveB.acpSessionId,
        prompt: [{ type: 'text', text: 'B turn 1' }],
        purpose: 'user',
        actor,
        idempotencyKey: 'b-turn-1',
      })
      await project(pool, wsId)

      await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId: sessionB, idempotencyKey: randomId() })
      assert.equal(await sessionPhase(pool, sessionB), 'suspended')
      await project(pool, wsId)
      const D = (await withClient(pool, (c) => getAnchor(c, wsId, 'fake-agent-b')))?.syncedThroughSeq
      assert.ok(typeof D === 'number' && D > C)

      // required exit criterion: switching back to A must resume the SAME Session and receive exactly (C, D].
      const switchToA = await switchAgent({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        agentId: 'fake-agent',
        runtimeDefinitionVersion: 'v1',
        workspaceRef: 'ws-1',
        equipmentRequest,
        actor,
        idempotencyKey: 'switch-to-a',
      })
      assert.ok(switchToA.ok, switchToA.ok ? '' : switchToA.detail)
      assert.equal(switchToA.ok && switchToA.sessionId, sessionA, 'must resume the SAME Session A, never a third one')
      await waitForPhase(pool, sessionA, 'ready')
      await waitForHandoffSettled(pool, wsId, sessionA)

      const handoffsToA = await findHandoffItems(pool, wsId, sessionA)
      assert.equal(handoffsToA.length, 1)
      assert.equal(handoffsToA[0]!.value.sourceFromSeq, C)
      assert.equal(handoffsToA[0]!.value.sourceThroughSeq, D)

      const liveA = connections.get(sessionA)
      assert.ok(liveA)
      assert.equal(liveA.acpSessionId, acpSessionIdA, 'resume must reuse the SAME ACP Session id, never rebind')
      assert.notEqual(liveA.connection, acpConnectionA, 'resume opens a genuinely NEW connection object, not the old (already-closed) one')
      assert.notEqual(liveA.connection, liveB.connection, 'no cross-Session bearer/connection reuse')

      // required: no source duplication — the projector never expands a Handoff back into copies
      // of the source items. B's own Session has exactly 2 messages of its own (the fake Agent's
      // generic reply to the Handoff prompt it received, plus its reply to "B turn 1") — the
      // Handoff TO A must not add any more of them, and A's Session must show no 'message' item
      // carrying B's reply text.
      const client = await pool.connect()
      try {
        const { rows: bMessages } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM projection.workstream_items WHERE workstream_id = $1 AND session_id = $2 AND item_kind = 'message'`,
          [wsId, sessionB],
        )
        assert.equal(bMessages[0]!.n, 2, "B's own two replies (to the Handoff prompt, and to 'B turn 1'), never duplicated")

        const { rows: aMessages } = await client.query<{ content: unknown }>(
          `SELECT m.content FROM projection.workstream_items i JOIN projection.messages m ON m.item_id = i.id
           WHERE i.workstream_id = $1 AND i.session_id = $2 AND i.item_kind = 'message'`,
          [wsId, sessionA],
        )
        const aText = JSON.stringify(aMessages.map((r) => r.content))
        assert.equal(aText.includes('B turn 1'), false, "A's own Session must never carry a copy of B's source message")
      } finally {
        client.release()
      }
    } finally {
      await custodyController.close()
    }
  })
})

test('required: the same switch command cannot duplicate a Handoff (byte-identical retry)', async () => {
  await withTestDatabase(async (pool) => {
    const custodyController = await startFakeController({}, pool)
    try {
      const { workstreamId: wsId, sessionId: sessionA } = await seedWorkstream(pool, 'fake-agent')
      const connections = new SessionConnectionRegistry()
      await provisionSessionAndPrompt({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        sessionId: sessionA,
        agentId: 'fake-agent',
        runtimeDefinitionVersion: 'v1',
        initialPrompt: [{ type: 'text', text: 'A turn 1' }],
        actor,
      })
      await waitForPhase(pool, sessionA, 'ready')
      await project(pool, wsId)
      await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId: sessionA, idempotencyKey: randomId() })
      await project(pool, wsId)

      const first = await switchAgent({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        agentId: 'fake-agent-b',
        runtimeDefinitionVersion: 'v1',
        workspaceRef: 'ws-1',
        equipmentRequest,
        actor,
        idempotencyKey: 'same-key',
      })
      assert.ok(first.ok)
      const sessionB = first.ok ? first.sessionId : ''
      await waitForPhase(pool, sessionB, 'ready')
      await waitForHandoffSettled(pool, wsId, sessionB)
      const firstHandoffs = await findHandoffItems(pool, wsId, sessionB)
      assert.equal(firstHandoffs.length, 1)

      // Retry with the SAME idempotency key: must resolve to the SAME Session, and must not
      // create a second Handoff command/item.
      const second = await switchAgent({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        agentId: 'fake-agent-b',
        runtimeDefinitionVersion: 'v1',
        workspaceRef: 'ws-1',
        equipmentRequest,
        actor,
        idempotencyKey: 'same-key',
      })
      assert.ok(second.ok)
      assert.equal(second.ok && second.sessionId, sessionB)
      await waitForHandoffSettled(pool, wsId, sessionB)

      const secondHandoffs = await findHandoffItems(pool, wsId, sessionB)
      assert.equal(secondHandoffs.length, 1, 'still exactly one Handoff item — no duplicate')
      assert.equal(secondHandoffs[0]!.value.digest, firstHandoffs[0]!.value.digest, 'byte-identical content digest on retry')

      const client = await pool.connect()
      try {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM product.commands WHERE workstream_id = $1 AND purpose = 'handoff'`,
          [wsId],
        )
        assert.equal(rows[0]!.n, 1, 'exactly one durable Handoff command')
      } finally {
        client.release()
      }
    } finally {
      await custodyController.close()
    }
  })
})

test('required: an echoed Handoff resource stays correlated to one Handoff card, not expanded into duplicate items', async () => {
  await withTestDatabase(async (pool) => {
    // A custom fake Agent that ECHOES the received prompt content back as its own message —
    // simulating an Agent that quotes/repeats the Handoff resource it was given.
    const custodyController = await startFakeController(
      {
        onPrompt: async (params, context) => {
          const resourceBlock = params.prompt.find((b): b is Extract<typeof b, { type: 'resource' }> => b.type === 'resource')
          const echoedText = resourceBlock && 'text' in resourceBlock.resource ? resourceBlock.resource.text.slice(0, 40) : ''
          await context.client.notify('session/update' as never, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${echoedText}` } },
          } as never)
          return { stopReason: 'end_turn' }
        },
      },
      pool,
    )
    try {
      const { workstreamId: wsId, sessionId: sessionA } = await seedWorkstream(pool, 'fake-agent')
      const connections = new SessionConnectionRegistry()
      await provisionSessionAndPrompt({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        sessionId: sessionA,
        agentId: 'fake-agent',
        runtimeDefinitionVersion: 'v1',
        initialPrompt: [{ type: 'text', text: 'A turn 1' }],
        actor,
      })
      await waitForPhase(pool, sessionA, 'ready')
      await project(pool, wsId)
      await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId: sessionA, idempotencyKey: randomId() })
      await project(pool, wsId)

      const result = await switchAgent({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        agentId: 'fake-agent-b',
        runtimeDefinitionVersion: 'v1',
        workspaceRef: 'ws-1',
        equipmentRequest,
        actor,
        idempotencyKey: 'switch-with-echo',
      })
      assert.ok(result.ok)
      const sessionB = result.ok ? result.sessionId : ''
      await waitForPhase(pool, sessionB, 'ready')
      await waitForHandoffSettled(pool, wsId, sessionB)

      const handoffs = await findHandoffItems(pool, wsId, sessionB)
      assert.equal(handoffs.length, 1, 'exactly one Handoff card, regardless of the echo')
      assert.equal(handoffs[0]!.value.targetOutcome, 'completed')

      const client = await pool.connect()
      try {
        const { rows } = await client.query<{ item_kind: string; current_value: unknown; turn_id: string | null }>(
          `SELECT item_kind, current_value, turn_id FROM projection.workstream_items WHERE workstream_id = $1 AND session_id = $2`,
          [wsId, sessionB],
        )
        const echoMessage = rows.find((r) => r.item_kind === 'message')
        const handoffItem = rows.find((r) => r.item_kind === 'handoff')
        assert.ok(echoMessage, 'the echo is a normal message item')
        assert.ok(handoffItem)
        assert.equal(echoMessage!.turn_id, handoffItem!.turn_id, 'the echo stays correlated to the SAME Handoff turn')
        assert.equal(rows.filter((r) => r.item_kind === 'handoff').length, 1, 'no expansion into a second handoff-shaped item')
      } finally {
        client.release()
      }
    } finally {
      await custodyController.close()
    }
  })
})

test('required: a capture failure after a successful Handoff preserves the old durable Anchor', async () => {
  await withTestDatabase(async (pool) => {
    const custodyController = await startFakeController({}, pool)
    try {
      const { workstreamId: wsId, sessionId: sessionA } = await seedWorkstream(pool, 'fake-agent')
      const connections = new SessionConnectionRegistry()
      await provisionSessionAndPrompt({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        sessionId: sessionA,
        agentId: 'fake-agent',
        runtimeDefinitionVersion: 'v1',
        initialPrompt: [{ type: 'text', text: 'A turn 1' }],
        actor,
      })
      await waitForPhase(pool, sessionA, 'ready')
      await project(pool, wsId)
      await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId: sessionA, idempotencyKey: randomId() })
      await project(pool, wsId)

      const switchToB = await switchAgent({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        agentId: 'fake-agent-b',
        runtimeDefinitionVersion: 'v1',
        workspaceRef: 'ws-1',
        equipmentRequest,
        actor,
        idempotencyKey: 'switch-to-b',
      })
      assert.ok(switchToB.ok)
      const sessionB = switchToB.ok ? switchToB.sessionId : ''
      await waitForPhase(pool, sessionB, 'ready')
      await waitForHandoffSettled(pool, wsId, sessionB)

      // B does more work, then suspends successfully — a real Anchor for B now exists.
      const liveB = connections.get(sessionB)
      assert.ok(liveB)
      await promptSession({
        pool,
        workstreamId: wsId,
        sessionId: sessionB,
        connection: liveB.connection,
        storePersist: liveB.storePersist,
        acpSessionId: liveB.acpSessionId,
        prompt: [{ type: 'text', text: 'B turn 1' }],
        purpose: 'user',
        actor,
        idempotencyKey: 'b-turn-1',
      })
      await project(pool, wsId)
      await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId: sessionB, idempotencyKey: 'suspend-b-1' })
      assert.equal(await sessionPhase(pool, sessionB), 'suspended')

      const client = await pool.connect()
      let anchorBefore
      try {
        anchorBefore = await getAnchor(client, wsId, 'fake-agent-b')
      } finally {
        client.release()
      }
      assert.ok(anchorBefore)

      // Resume B again (no Handoff needed — B is anchored to itself, watermark == head), do a
      // bit more work, then force the NEXT capture to fail.
      const reactivate = await switchAgent({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        agentId: 'fake-agent-b',
        runtimeDefinitionVersion: 'v1',
        workspaceRef: 'ws-1',
        equipmentRequest,
        actor,
        idempotencyKey: 'reactivate-b',
      })
      assert.ok(reactivate.ok)
      await waitForPhase(pool, sessionB, 'ready')
      const liveB2 = connections.get(sessionB)
      assert.ok(liveB2)
      await promptSession({
        pool,
        workstreamId: wsId,
        sessionId: sessionB,
        connection: liveB2.connection,
        storePersist: liveB2.storePersist,
        acpSessionId: liveB2.acpSessionId,
        prompt: [{ type: 'text', text: 'B turn 2' }],
        purpose: 'user',
        actor,
        idempotencyKey: 'b-turn-2',
      })
      await project(pool, wsId)

      custodyController.failNextCapture()
      await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId: sessionB, idempotencyKey: 'suspend-b-2-fails' })

      // Capture failed -> suspend fails closed; the Session must NOT be cleanly 'suspended'.
      assert.equal(await sessionPhase(pool, sessionB), 'failed')

      const afterClient = await pool.connect()
      let anchorAfter
      try {
        anchorAfter = await getAnchor(afterClient, wsId, 'fake-agent-b')
      } finally {
        afterClient.release()
      }
      assert.deepEqual(anchorAfter, anchorBefore, 'the old durable Anchor must be byte-for-byte unchanged after a capture failure')
    } finally {
      await custodyController.close()
    }
  })
})
