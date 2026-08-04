import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import type pg from 'pg'
import { principalId, workstreamId } from '@agora/domain'
import { createWorkstreamWithFirstSession, projectWorkstream } from '@agora/store-pg'
import { SessionConnectionRegistry } from '../src/connections.js'
import {
  activateSession,
  cancelSessionCommand,
  closeSession,
  provisionSessionAndPrompt,
  suspendSession,
} from '../src/orchestration.js'
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

test.before(async () => {
  controller = await startFakeController()
})
test.after(async () => {
  await controller.close()
})

test('required exit criterion: provisioning a Session reaches ready and the initial prompt actually round-trips', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()

    await provisionSessionAndPrompt({
      pool,
      transport: controller,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      workspaceMountRef: 'pvc-1',
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
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      workspaceMountRef: 'pvc-1',
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
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      workspaceMountRef: 'pvc-1',
      initialPrompt: [],
      actor: { kind: 'human', id: 'alice' },
    })

    const result = await activateSession({
      pool,
      transport: controller,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      workspaceMountRef: 'pvc-1',
      actor: { kind: 'human', id: 'alice' },
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(await sessionPhase(pool, sessionId), 'ready')
  })
})

test('suspendSession dematerializes the real Session Runtime and reaches suspended', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()
    await provisionSessionAndPrompt({
      pool,
      transport: controller,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      workspaceMountRef: 'pvc-1',
      initialPrompt: [],
      actor: { kind: 'human', id: 'alice' },
    })

    await suspendSession({ pool, transport: controller, connections, sessionId })
    assert.equal(await sessionPhase(pool, sessionId), 'suspended')
    assert.ok(controller.dematerializeCalls.includes(sessionId))
    assert.equal(connections.get(sessionId), undefined)
  })
})

test('required: a suspended Session cannot be silently resumed — activateSession fails closed with a typed reason', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()
    await provisionSessionAndPrompt({
      pool,
      transport: controller,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      workspaceMountRef: 'pvc-1',
      initialPrompt: [],
      actor: { kind: 'human', id: 'alice' },
    })
    await suspendSession({ pool, transport: controller, connections, sessionId })

    const result = await activateSession({
      pool,
      transport: controller,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      workspaceMountRef: 'pvc-1',
      actor: { kind: 'human', id: 'alice' },
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'resume_failed')
  })
})

test('closeSession cancels live work, dematerializes and reaches closed', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const connections = new SessionConnectionRegistry()
    await provisionSessionAndPrompt({
      pool,
      transport: controller,
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      workspaceMountRef: 'pvc-1',
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
      connections,
      workstreamId: wsId,
      sessionId,
      agentId: 'fake-agent',
      runtimeDefinitionVersion: 'v1',
      workspaceMountRef: 'pvc-1',
      initialPrompt: [],
      actor: { kind: 'human', id: 'alice' },
    })
    const withLive = await cancelSessionCommand({ connections, sessionId })
    assert.deepEqual(withLive, { ok: true })
  })
})
