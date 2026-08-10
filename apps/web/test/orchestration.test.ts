import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import type pg from 'pg'
import { promptSession } from '@agora/acp'
import { nameBasedUuid, principalId, workstreamId } from '@agora/domain'
import { captureCustody } from '@agora/session-runtime-control'
import { createWorkstreamWithFirstSession, getAnchor, projectWorkstream, upsertAnchor } from '@agora/store-pg'
import { createHttpBrokerGrantClient } from '../src/broker-grant-client.js'
import { SessionConnectionRegistry } from '../src/connections.js'
import {
  activateSession,
  cancelSessionCommand,
  closeSession,
  provisionSessionAndPrompt,
  SUSPEND_CAPTURE_NAMESPACE,
  suspendSession,
} from '../src/orchestration.js'
import { startFakeBroker, type FakeBrokerHandle } from './support/fake-broker.js'
import { startFakeController, type FakeControllerHandle } from './support/fake-controller.js'
import { randomId, withTestDatabase } from './support.js'

function launchEnvelope() {
  return {
    agentId: 'fake-agent',
    workspaceSpec: { root: '/work' },
    equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
    runtimeDefinitionVersion: 'v1',
  }
}

async function seedWorkstream(pool: pg.Pool) {
  const client = await pool.connect()
  try {
    const wsId = workstreamId(randomId())
    const sessionId = randomId()
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: new Date() },
      session: { id: sessionId as never, ordinal: 1, launchEnvelope: launchEnvelope() },
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

let controller: FakeControllerHandle
let broker: FakeBrokerHandle
let brokerGrantClient: ReturnType<typeof createHttpBrokerGrantClient>

test.before(async () => {
  controller = await startFakeController()
  broker = await startFakeBroker()
  brokerGrantClient = createHttpBrokerGrantClient(broker.baseUrl)
})
test.after(async () => {
  await controller.close()
  await broker.close()
})

test('required exit criterion: provisioning a Session reaches ready and the initial prompt actually round-trips', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()

    await provisionSessionAndPrompt({
      pool,
      transport: controller,
      brokerGrantClient,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      initialPrompt: [{ type: 'text', text: 'hello there' }],
      actor: { kind: 'human', id: 'alice' },
    })

    assert.equal(await sessionPhase(pool, sessionId), 'ready')
    assert.ok(connections.get(sessionId), 'a live ACP connection is registered after bootstrap')

    const client = await pool.connect()
    try {
      await projectWorkstream(client, wsId, new Date())
      const { rows } = await client.query(`SELECT item_kind FROM projection.workstream_items WHERE workstream_id = $1`, [wsId])
      assert.ok(rows.some((r) => r.item_kind === 'message'), 'the fake Agent reply actually got journaled and projected')
    } finally {
      client.release()
    }
  })
})

test('activateSession on a requested Session runs the real provisioning chain asynchronously', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()

    const result = await activateSession({
      pool,
      transport: controller,
      brokerGrantClient,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      actor: { kind: 'human', id: 'alice' },
    })
    assert.deepEqual(result, { ok: true })

    const finalPhase = await waitForPhase(pool, sessionId, 'ready')
    assert.equal(finalPhase, 'ready')

    // `activateSession` is fire-and-forget by design, and `bootstrapSession` reaches `ready`
    // BEFORE the rest of the provisioning chain has run — so returning here tears the test
    // database down underneath work that is still going, and the chain's own error handling then
    // fails trying to connect to a pool that has ended. Same reason, and same remedy, as the
    // `after` hook in server.test.ts. There is no completion signal to await instead: this path
    // passes no `provisioningCommandId`, so nothing durable settles at the end of it.
    await sleep(500)
  })
})

test('activateSession on an already-ready Session is a no-op', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()
    await provisionSessionAndPrompt({
      pool,
      transport: controller,
      brokerGrantClient,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      initialPrompt: [],
      actor: { kind: 'human', id: 'alice' },
    })

    const result = await activateSession({
      pool,
      transport: controller,
      brokerGrantClient,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      actor: { kind: 'human', id: 'alice' },
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(await sessionPhase(pool, sessionId), 'ready')
  })
})

test('suspendSession dematerializes the real Session Runtime and reaches suspended', async () => {
  await withTestDatabase(async (pool) => {
    const custodyController = await startFakeController({}, pool)
    try {
      const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
      const connections = new SessionConnectionRegistry()
      await provisionSessionAndPrompt({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        sessionId,
        agentId: 'fake-agent',
        runtimeDefinitionVersion: 'v1',
        initialPrompt: [],
        actor: { kind: 'human', id: 'alice' },
      })

      await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId, idempotencyKey: randomId() })
      assert.equal(await sessionPhase(pool, sessionId), 'suspended')
      assert.ok(custodyController.dematerializeCalls.includes(sessionId))
      assert.equal(connections.get(sessionId), undefined)
    } finally {
      await custodyController.close()
    }
  })
})

test('required: suspend commits a custody Anchor, and activateSession fails closed when none exists', async () => {
  await withTestDatabase(async (pool) => {
    const custodyController = await startFakeController({}, pool)
    try {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()
    await provisionSessionAndPrompt({
      pool,
      transport: custodyController,
      brokerGrantClient,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      initialPrompt: [],
      actor: { kind: 'human', id: 'alice' },
    })
    await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId, idempotencyKey: randomId() })
    assert.equal(await sessionPhase(pool, sessionId), 'suspended')

    const client = await pool.connect()
    try {
      const anchor = await getAnchor(client, wsId, 'fake-agent')
      assert.ok(anchor, 'suspend must commit a durable Anchor before dematerializing')
      assert.equal(anchor?.sessionId, sessionId)
    } finally {
      client.release()
    }
    } finally {
      await custodyController.close()
    }
  })
})

test('required: a crash after capture but before the Anchor commits is recovered by a retry that reuses the SAME snapshot', async () => {
  await withTestDatabase(async (pool) => {
    const custodyController = await startFakeController({}, pool)
    try {
      const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
      const connections = new SessionConnectionRegistry()
      await provisionSessionAndPrompt({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        sessionId,
        agentId: 'fake-agent',
        runtimeDefinitionVersion: 'v1',
        initialPrompt: [],
        actor: { kind: 'human', id: 'alice' },
      })

      // Exactly what suspendSession's first half does — capture, then "crash" (no Anchor, no dematerialize).
      const idempotencyKey = randomId()
      const captureRequestId = nameBasedUuid(SUSPEND_CAPTURE_NAMESPACE, `${sessionId}:${idempotencyKey}`)
      const ref = await captureCustody(custodyController, sessionId as never, captureRequestId, 0)

      const beforeClient = await pool.connect()
      try {
        assert.equal(await getAnchor(beforeClient, wsId, 'fake-agent'), undefined, 'no Anchor yet — this snapshot is still unreferenced')
      } finally {
        beforeClient.release()
      }
      assert.equal(await sessionPhase(pool, sessionId), 'ready', 'the crash left the Session phase untouched')

      // The retry (same Idempotency-Key): must reuse the SAME snapshot, not allocate generation 2.
      await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId, idempotencyKey })
      assert.equal(await sessionPhase(pool, sessionId), 'suspended')

      const afterClient = await pool.connect()
      try {
        const anchor = await getAnchor(afterClient, wsId, 'fake-agent')
        assert.ok(anchor)
        assert.equal(anchor?.custodySnapshotId, ref.snapshotId)
        const { rows } = await afterClient.query('SELECT count(*)::int AS n FROM custody.snapshots WHERE session_id = $1', [sessionId])
        assert.equal(rows[0].n, 1, 'the retry must not have allocated a second generation')
      } finally {
        afterClient.release()
      }
    } finally {
      await custodyController.close()
    }
  })
})

test('required: a crash after the Anchor commits but before dematerialize is reconciled by a retry', async () => {
  await withTestDatabase(async (pool) => {
    const custodyController = await startFakeController({}, pool)
    try {
      const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
      const connections = new SessionConnectionRegistry()
      await provisionSessionAndPrompt({
        pool,
        transport: custodyController,
        brokerGrantClient,
        connections,
        workstreamId: wsId,
        sessionId,
        agentId: 'fake-agent',
        runtimeDefinitionVersion: 'v1',
        initialPrompt: [],
        actor: { kind: 'human', id: 'alice' },
      })

      // Everything suspendSession does UP TO AND INCLUDING the Anchor commit, then "crash" before dematerialize.
      const idempotencyKey = randomId()
      const captureRequestId = nameBasedUuid(SUSPEND_CAPTURE_NAMESPACE, `${sessionId}:${idempotencyKey}`)
      const ref = await captureCustody(custodyController, sessionId as never, captureRequestId, 0)
      const anchorClient = await pool.connect()
      try {
        await upsertAnchor(anchorClient, {
          workstreamId: wsId,
          agentId: 'fake-agent',
          sessionId,
          custodySnapshotId: ref.snapshotId,
          syncedThroughSeq: ref.syncedThroughSeq,
          updatedAt: new Date(),
        })
      } finally {
        anchorClient.release()
      }
      assert.equal(custodyController.dematerializeCalls.includes(sessionId), false, 'the crash never reached dematerialize')

      // The retry (same Idempotency-Key): reuses the SAME Anchor/snapshot and completes dematerialize.
      await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId, idempotencyKey })
      assert.equal(await sessionPhase(pool, sessionId), 'suspended')
      assert.ok(custodyController.dematerializeCalls.includes(sessionId))

      const client = await pool.connect()
      try {
        const anchor = await getAnchor(client, wsId, 'fake-agent')
        assert.equal(anchor?.custodySnapshotId, ref.snapshotId, 'the retry must not have allocated a second generation')
      } finally {
        client.release()
      }
    } finally {
      await custodyController.close()
    }
  })
})

test('required exit criterion: resume rematerializes and reconnects with the SAME ACP Session id, no new Session, no duplicated Workstream items', async () => {
  await withTestDatabase(async (pool) => {
    const custodyController = await startFakeController({}, pool)
    try {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()
    await provisionSessionAndPrompt({
      pool,
      transport: custodyController,
      brokerGrantClient,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      initialPrompt: [{ type: 'text', text: 'before suspend' }],
      actor: { kind: 'human', id: 'alice' },
    })
    await waitForPhase(pool, sessionId, 'ready')

    async function acpSessionIdOf(): Promise<string | undefined> {
      const client = await pool.connect()
      try {
        const { rows } = await client.query<{ acp_session_id: string | null }>('SELECT acp_session_id FROM product.sessions WHERE id = $1', [
          sessionId,
        ])
        return rows[0]?.acp_session_id ?? undefined
      } finally {
        client.release()
      }
    }
    const acpSessionIdBeforeSuspend = await acpSessionIdOf()
    assert.ok(acpSessionIdBeforeSuspend)

    await suspendSession({ pool, transport: custodyController, brokerGrantClient, connections, sessionId, idempotencyKey: randomId() })
    assert.equal(await sessionPhase(pool, sessionId), 'suspended')
    assert.equal(connections.get(sessionId), undefined)

    const result = await activateSession({
      pool,
      transport: custodyController,
      brokerGrantClient,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      actor: { kind: 'human', id: 'alice' },
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(await waitForPhase(pool, sessionId, 'ready'), 'ready')

    // required: never a new ACP Session id — `bindAcpSession` is write-once, resume just reuses it.
    assert.equal(await acpSessionIdOf(), acpSessionIdBeforeSuspend)

    const live = connections.get(sessionId)
    assert.ok(live, 'a live ACP connection is registered after resume')

    await promptSession({
      pool,
      workstreamId: wsId,
      sessionId,
      connection: live!.connection,
      storePersist: live!.storePersist,
      acpSessionId: live!.acpSessionId,
      prompt: [{ type: 'text', text: 'after resume' }],
      purpose: 'user',
      actor: { kind: 'human', id: 'alice' },
      idempotencyKey: 'after-resume-prompt',
    })

    const client = await pool.connect()
    try {
      await projectWorkstream(client, wsId, new Date())
      // Split by role since 2026-08-07: the projector now folds the user's own prompt into a
      // `message` too, so an undifferentiated count would say 4 and mean nothing. What this test
      // is actually about is the AGENT's side not being replayed on resume.
      const { rows } = await client.query<{ id: string; item_kind: string; role: string | null }>(
        `SELECT i.id, i.item_kind, m.role FROM projection.workstream_items i
           LEFT JOIN projection.messages m ON m.item_id = i.id
          WHERE i.workstream_id = $1`,
        [wsId],
      )
      const messageItems = rows.filter((r) => r.item_kind === 'message')
      const uniqueIds = new Set(messageItems.map((r) => r.id))
      assert.equal(uniqueIds.size, messageItems.length, 'no duplicated Workstream items after resume')
      const agentReplies = messageItems.filter((r) => r.role === 'agent')
      const userPrompts = messageItems.filter((r) => r.role === 'user')
      assert.equal(agentReplies.length, 2, 'exactly one agent reply per prompt (before suspend + after resume), no replay duplication')
      assert.equal(userPrompts.length, 2, 'and both prompts the user sent are in the transcript, each exactly once')
    } finally {
      client.release()
    }
    } finally {
      await custodyController.close()
    }
  })
})

test('closeSession cancels live work, dematerializes and reaches closed', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()
    await provisionSessionAndPrompt({
      pool,
      transport: controller,
      brokerGrantClient,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      initialPrompt: [],
      actor: { kind: 'human', id: 'alice' },
    })

    await closeSession({ pool, transport: controller, brokerGrantClient, connections, sessionId })
    assert.equal(await sessionPhase(pool, sessionId), 'closed')
    assert.ok(controller.dematerializeCalls.includes(sessionId))
  })
})

test('cancelSessionCommand is a no-op without a live connection and succeeds with one', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()

    const noLive = await cancelSessionCommand({ connections, sessionId })
    assert.deepEqual(noLive, { ok: false })

    await provisionSessionAndPrompt({
      pool,
      transport: controller,
      brokerGrantClient,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      initialPrompt: [],
      actor: { kind: 'human', id: 'alice' },
    })
    const withLive = await cancelSessionCommand({ connections, sessionId })
    assert.deepEqual(withLive, { ok: true })
  })
})

test('required, P11: a closed Session revokes its execution grant — this is what reclaims its OneCLI Agent', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()
    const before = broker.revokeCalls.length

    await provisionSessionAndPrompt({
      pool,
      transport: controller,
      brokerGrantClient,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      initialPrompt: [],
      actor: { kind: 'human', id: 'alice' },
    })
    await closeSession({ pool, transport: controller, brokerGrantClient, connections, sessionId })

    assert.equal(await sessionPhase(pool, sessionId), 'closed')
    // Found live, P11: nothing ever called the Broker's revoke endpoint, so every terminal Session
    // stranded its dedicated OneCLI Agent (20 had accumulated on the real instance).
    assert.equal(broker.revokeCalls.length, before + 1, 'closing revokes exactly one grant')
  })
})

test('required, P11: a Session that fails provisioning still revokes its grant — failures were the real source of orphaned Agents', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()
    const before = broker.revokeCalls.length

    // A transport that materializes nothing: provisioning fails AFTER the grant was issued, which
    // is exactly the shape that leaked Agents in production.
    const brokenTransport = { baseUrl: 'http://127.0.0.1:1', fetch: controller.fetch }
    await provisionSessionAndPrompt({
      pool,
      transport: brokenTransport as never,
      brokerGrantClient,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      initialPrompt: [],
      actor: { kind: 'human', id: 'alice' },
    })

    assert.equal(await sessionPhase(pool, sessionId), 'failed')
    assert.equal(broker.revokeCalls.length, before + 1, 'a failed Session releases its grant too')
  })
})
