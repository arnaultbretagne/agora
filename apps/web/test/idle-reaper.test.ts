import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { nameBasedUuid, principalId, workstreamId } from '@agora/domain'
import { createWorkstreamWithFirstSession, projectWorkstream } from '@agora/store-pg'
import { createHttpBrokerGrantClient } from '../src/broker-grant-client.js'
import { SessionConnectionRegistry } from '../src/connections.js'
import { reapIdleSessions } from '../src/idle-reaper.js'
import { provisionSessionAndPrompt, SUSPEND_CAPTURE_NAMESPACE } from '../src/orchestration.js'
import { startFakeBroker, type FakeBrokerHandle } from './support/fake-broker.js'
import { startFakeController, type FakeControllerHandle } from './support/fake-controller.js'
import { randomId, withTestDatabase } from './support.js'

/**
 * The outage this exists to prevent, in one sentence: `agora-runs` caps concurrent Session
 * Runtimes, nothing ever gave a slot back, and four abandoned Sessions — one idle for fifteen
 * hours — made every new Session fail with `exceeded quota` (2026-08-07).
 */

let broker: FakeBrokerHandle
let brokerGrantClient: ReturnType<typeof createHttpBrokerGrantClient>

test.before(async () => {
  broker = await startFakeBroker()
  brokerGrantClient = createHttpBrokerGrantClient(broker.baseUrl)
})
test.after(async () => {
  await broker.close()
})

async function readySession(pool: pg.Pool, controller: FakeControllerHandle, connections: SessionConnectionRegistry, prompt: string | undefined = 'hello') {
  const client = await pool.connect()
  const wsId = workstreamId(randomId())
  const sessionId = randomId()
  try {
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: new Date() },
      session: {
        id: sessionId as never,
        ordinal: 1,
        launchEnvelope: {
          agentId: 'fake-agent',
          workspaceSpec: { root: '/work' },
          equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
          runtimeDefinitionVersion: 'v1',
        },
      },
      runtimeDefinitionVersion: 'v1',
    })
  } finally {
    client.release()
  }
  await provisionSessionAndPrompt({
    pool,
    transport: controller,
    brokerGrantClient,
    connections,
    workstreamId: wsId as string,
    sessionId,
    agentId: 'fake-agent',
    runtimeDefinitionVersion: 'v1',
    initialPrompt: prompt ? [{ type: 'text', text: prompt }] : [],
    actor: { kind: 'human', id: 'alice' },
  })
  const projectClient = await pool.connect()
  try {
    await projectWorkstream(projectClient, wsId as string, new Date())
  } finally {
    projectClient.release()
  }
  return { workstreamId: wsId as string, sessionId }
}

async function phaseOf(pool: pg.Pool, sessionId: string): Promise<string> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ phase: string; failure_code: string | null; failure_detail: string | null }>(
      'SELECT phase, failure_code, failure_detail FROM product.sessions WHERE id = $1',
      [sessionId],
    )
    const row = rows[0]
    if (!row) return 'MISSING'
    // Carry the reason into the assertion message: a bare "expected suspended, got failed" says
    // nothing about WHY, and the reason is right there in the row.
    return row.phase === 'failed' ? `failed(${row.failure_code}: ${row.failure_detail})` : row.phase
  } finally {
    client.release()
  }
}

test('required: an idle Session is reclaimed by suspension, so its Runtime slot comes back', async () => {
  await withTestDatabase(async (pool) => {
    const connections = new SessionConnectionRegistry()
    const controller = await startFakeController({}, pool)
    try {
    const { sessionId } = await readySession(pool, controller, connections)
    assert.equal(await phaseOf(pool, sessionId), 'ready')

    // Two hours later, with a one-hour threshold.
    const later = new Date(Date.now() + 2 * 60 * 60_000)
    const reaped = await reapIdleSessions({
      pool,
      transport: controller,
      brokerGrantClient,
      connections,
      idleAfterMs: 60 * 60_000,
      now: () => later,
      log: () => {},
    })

    assert.deepEqual([...reaped], [sessionId])
    assert.equal(await phaseOf(pool, sessionId), 'suspended', 'suspended, NOT deleted — the conversation must stay resumable')
    assert.equal(connections.get(sessionId), undefined, 'the live ACP connection is released with the Runtime')
    assert.ok(controller.dematerializeCalls.includes(sessionId), 'the Pod is actually torn down — that is what frees the quota slot')
    } finally {
      await controller.close()
    }
  })
})

test('required: a Session that has just been used is left alone', async () => {
  await withTestDatabase(async (pool) => {
    const connections = new SessionConnectionRegistry()
    const controller = await startFakeController({}, pool)
    try {
    const { sessionId } = await readySession(pool, controller, connections)

    const reaped = await reapIdleSessions({
      pool,
      transport: controller,
      brokerGrantClient,
      connections,
      idleAfterMs: 60 * 60_000,
      now: () => new Date(),
      log: () => {},
    })

    assert.deepEqual([...reaped], [], 'a Session used moments ago is not idle')
    assert.equal(await phaseOf(pool, sessionId), 'ready')
    } finally {
      await controller.close()
    }
  })
})

test('required: custody is captured before the Runtime goes away, so the reaped Session can resume', async () => {
  await withTestDatabase(async (pool) => {
    const connections = new SessionConnectionRegistry()
    const controller = await startFakeController({}, pool)
    try {
    const { workstreamId: wsId, sessionId } = await readySession(pool, controller, connections)

    const later = new Date(Date.now() + 2 * 60 * 60_000)
    await reapIdleSessions({
      pool,
      transport: controller,
      brokerGrantClient,
      connections,
      idleAfterMs: 60 * 60_000,
      now: () => later,
      log: () => {},
    })

    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ session_id: string; custody_snapshot_id: string }>(
        'SELECT session_id, custody_snapshot_id FROM product.agent_anchors WHERE workstream_id = $1',
        [wsId],
      )
      assert.equal(rows.length, 1, 'an Anchor is committed — without one the conversation could never be resumed')
      assert.equal(rows[0]?.session_id, sessionId)
      assert.ok(rows[0]?.custody_snapshot_id, 'the Anchor points at real captured custody')
    } finally {
      client.release()
    }
    } finally {
      await controller.close()
    }
  })
})

test('required: repeating a sweep for the same idleness reuses one custody capture, never allocating a second generation', async () => {
  await withTestDatabase(async (pool) => {
    const connections = new SessionConnectionRegistry()
    const controller = await startFakeController({}, pool)
    try {
    const { sessionId } = await readySession(pool, controller, connections)

    const client = await pool.connect()
    let lastActivityAt: Date
    try {
      const { rows } = await client.query<{ at: Date }>(
        `SELECT GREATEST(s.created_at, COALESCE(MAX(t.ended_at), s.created_at)) AS at
           FROM product.sessions s LEFT JOIN projection.turns t ON t.session_id = s.id AND t.ended_at IS NOT NULL
          WHERE s.id = $1 GROUP BY s.created_at`,
        [sessionId],
      )
      lastActivityAt = rows[0]!.at
    } finally {
      client.release()
    }

    const later = new Date(Date.now() + 2 * 60 * 60_000)
    await reapIdleSessions({ pool, transport: controller, brokerGrantClient, connections, idleAfterMs: 60 * 60_000, now: () => later, log: () => {} })

    // docs/specs/13: a retried capture must not allocate two generations for one request id. The
    // reaper's key is derived from the activity timestamp, so the SAME idleness always maps to the
    // SAME capture request — which is only true because the timestamp is durable, not remembered.
    const expected = nameBasedUuid(SUSPEND_CAPTURE_NAMESPACE, `${sessionId}:idle-reap:${lastActivityAt.toISOString()}`)
    const check = await pool.connect()
    try {
      const { rows } = await check.query<{ capture_request_id: string; generation: string }>(
        'SELECT capture_request_id, generation FROM custody.snapshots WHERE session_id = $1',
        [sessionId],
      )
      assert.equal(rows.length, 1, 'exactly one custody generation for one idleness')
      assert.equal(
        rows[0]?.capture_request_id,
        expected,
        'the capture request id must be derived from the durable activity timestamp, so a retried sweep for the same idleness lands on the same capture',
      )
    } finally {
      check.release()
    }
    } finally {
      await controller.close()
    }
  })
})

test('required: a Session that fails to suspend is reported as such, never counted as reclaimed', async () => {
  await withTestDatabase(async (pool) => {
    const connections = new SessionConnectionRegistry()
    const controller = await startFakeController({}, pool)
    try {
      const { sessionId } = await readySession(pool, controller, connections)

      // `suspendSession` routes its own failures into `failClosed` and returns normally, so a
      // reaper that trusts the return value reports success unconditionally — which is exactly what
      // the first production sweep did, announcing six suspensions that were six failures.
      controller.failNextCapture()

      const later = new Date(Date.now() + 2 * 60 * 60_000)
      const reaped = await reapIdleSessions({
        pool,
        transport: controller,
        brokerGrantClient,
        connections,
        idleAfterMs: 60 * 60_000,
        now: () => later,
        log: () => {},
      })

      assert.deepEqual([...reaped], [], 'a Session that did not suspend must not be counted as reclaimed')
      assert.match(await phaseOf(pool, sessionId), /^failed/, 'and its real outcome is what the row says')
    } finally {
      await controller.close()
    }
  })
})

/**
 * The reason the run namespace filled up again after the reaper shipped: the reaper suspends, the
 * suspension fails, `failClosed` marks the Session `failed` — and the Pod it was trying to reclaim
 * stayed exactly where it was, holding its quota slot for good. A reclamation path that leaks on
 * its own failure reclaims nothing. Found live 2026-08-07 with three orphaned Pods whose Sessions
 * had all been terminal for over an hour.
 */
test('required: a Session that fails to suspend still gives its Pod back', async () => {
  await withTestDatabase(async (pool) => {
    const connections = new SessionConnectionRegistry()
    const controller = await startFakeController({}, pool)
    try {
      const { sessionId } = await readySession(pool, controller, connections)
      controller.failNextCapture()

      const later = new Date(Date.now() + 2 * 60 * 60_000)
      await reapIdleSessions({
        pool,
        transport: controller,
        brokerGrantClient,
        connections,
        idleAfterMs: 60 * 60_000,
        now: () => later,
        log: () => {},
      })

      assert.match(await phaseOf(pool, sessionId), /^failed/, 'the capture genuinely failed')
      assert.ok(
        controller.dematerializeCalls.includes(sessionId),
        'and the Runtime was torn down anyway — a terminal Session must never keep a Pod, whatever went wrong',
      )
    } finally {
      await controller.close()
    }
  })
})
