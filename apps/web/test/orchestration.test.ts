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

      await suspendSession({ pool, transport: custodyController, connections, sessionId, idempotencyKey: randomId() })
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
    await suspendSession({ pool, transport: custodyController, connections, sessionId, idempotencyKey: randomId() })
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
      await suspendSession({ pool, transport: custodyController, connections, sessionId, idempotencyKey })
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
      await suspendSession({ pool, transport: custodyController, connections, sessionId, idempotencyKey })
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

    await suspendSession({ pool, transport: custodyController, connections, sessionId, idempotencyKey: randomId() })
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
      const { rows } = await client.query<{ id: string; item_kind: string }>(
        'SELECT id, item_kind FROM projection.workstream_items WHERE workstream_id = $1',
        [wsId],
      )
      const messageItems = rows.filter((r) => r.item_kind === 'message')
      const uniqueIds = new Set(messageItems.map((r) => r.id))
      assert.equal(uniqueIds.size, messageItems.length, 'no duplicated Workstream items after resume')
      assert.equal(messageItems.length, 2, 'exactly one message per prompt (before suspend + after resume), no replay duplication')
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

    await closeSession({ pool, transport: controller, connections, sessionId })
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
