import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { principalId, workstreamId } from '@agora/domain'
import { addWorkstreamMembership, createWorkstreamWithFirstSession } from '../src/workstreams.js'
import { createOrReuseCommand } from '../src/commands.js'
import { appendEvent } from '../src/journal.js'
import { projectWorkstream } from '../src/projector.js'
import {
  getCommand,
  getMembershipRole,
  getSession,
  getWorkstreamDetail,
  listWorkstreamItemsPage,
  listWorkstreamMembershipsWire,
  listWorkstreamsForPrincipal,
  listWorkstreamTurnsPage,
} from '../src/reads.js'
import { randomId, withTestDatabase } from './support.js'

function launchEnvelope() {
  return {
    agentId: 'fake-agent',
    workspaceSpec: { root: '/work' },
    equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
    runtimeDefinitionVersion: 'v1',
  }
}

async function seedWorkstream(pool: pg.Pool, owner = 'alice', title = 'Hello') {
  const client = await pool.connect()
  try {
    const wsId = workstreamId(randomId())
    const sessionId = randomId()
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title, owner: principalId(owner), createdAt: new Date() },
      session: { id: sessionId as never, ordinal: 1, launchEnvelope: launchEnvelope() },
      runtimeDefinitionVersion: 'v1',
    })
    return { workstreamId: wsId as string, sessionId }
  } finally {
    client.release()
  }
}

test('listWorkstreamsForPrincipal only returns Workstreams the principal is a member of, with their role', async () => {
  await withTestDatabase(async (pool) => {
    const mine = await seedWorkstream(pool, 'alice', 'Mine')
    await seedWorkstream(pool, 'bob', 'Not mine')

    const result = await pool.connect().then(async (client) => {
      try {
        return await listWorkstreamsForPrincipal(client, 'alice', { limit: 30 })
      } finally {
        client.release()
      }
    })
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0]?.id, mine.workstreamId)
    assert.equal(result.items[0]?.role, 'owner')
    assert.equal(result.nextCursor, null)
  })
})

test('listWorkstreamsForPrincipal pagination: cursor walks strictly older pages with no overlap/gap', async () => {
  await withTestDatabase(async (pool) => {
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const { workstreamId: id } = await seedWorkstream(pool, 'alice', `ws-${i}`)
      ids.push(id)
    }
    const client = await pool.connect()
    try {
      const page1 = await listWorkstreamsForPrincipal(client, 'alice', { limit: 2 })
      assert.equal(page1.items.length, 2)
      assert.ok(page1.nextCursor)
      const page2 = await listWorkstreamsForPrincipal(client, 'alice', { limit: 2, cursor: page1.nextCursor! })
      assert.equal(page2.items.length, 2)
      const page3 = await listWorkstreamsForPrincipal(client, 'alice', { limit: 2, cursor: page2.nextCursor! })
      assert.equal(page3.items.length, 1)
      assert.equal(page3.nextCursor, null)
      const allIds = [...page1.items, ...page2.items, ...page3.items].map((i) => i.id)
      assert.equal(new Set(allIds).size, 5, 'no duplicates or gaps across pages')
    } finally {
      client.release()
    }
  })
})

test('required: unauthorized Workstream access is denied (getWorkstreamDetail returns undefined for a non-member)', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId } = await seedWorkstream(pool, 'alice')
    const client = await pool.connect()
    try {
      const asOwner = await getWorkstreamDetail(client, wsId, 'alice')
      assert.ok(asOwner)
      assert.equal(asOwner?.sessions.length, 1)
      assert.equal(asOwner?.projectionHead, 0)

      const asStranger = await getWorkstreamDetail(client, wsId, 'mallory')
      assert.equal(asStranger, undefined)
    } finally {
      client.release()
    }
  })
})

test('getSession and getCommand read back the exact durable state', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      const session = await getSession(client, sessionId)
      assert.equal(session?.phase, 'requested')
      assert.equal(session?.current, true)
      assert.equal(session?.runtimeDefinitionVersion, 'v1')

      const command = await createOrReuseCommand(client, {
        type: 'PromptSession',
        workstreamId: wsId as never,
        sessionId: sessionId as never,
        actor: { kind: 'human', id: 'alice' as never },
        idempotencyScope: 'prompt',
        idempotencyKey: 'k1',
        purpose: 'user',
        acceptedAt: new Date(),
        request: { prompt: [] },
      })
      const wireCommand = await getCommand(client, command.id as string)
      assert.equal(wireCommand?.commandType, 'PromptSession')
      assert.equal(wireCommand?.state, 'accepted')
      assert.equal(wireCommand?.workstreamId, wsId)
    } finally {
      client.release()
    }
  })
})

test('required: owner-only membership listing reflects added members and roles', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId } = await seedWorkstream(pool, 'alice')
    const client = await pool.connect()
    try {
      await addWorkstreamMembership(client, wsId, principalId('bob'), 'editor', new Date())
      const memberships = await listWorkstreamMembershipsWire(client, wsId)
      assert.equal(memberships.length, 2)
      assert.deepEqual(
        memberships.map((m) => [m.principalId, m.role]).sort(),
        [
          ['alice', 'owner'],
          ['bob', 'editor'],
        ],
      )
      assert.equal(await getMembershipRole(client, wsId, 'bob'), 'editor')
      assert.equal(await getMembershipRole(client, wsId, 'mallory'), undefined)
    } finally {
      client.release()
    }
  })
})

test('listWorkstreamItemsPage and listWorkstreamTurnsPage return one consistent snapshot with working pagination', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const setupClient = await pool.connect()
    let turnId: string
    try {
      const command = await createOrReuseCommand(setupClient, {
        type: 'PromptSession',
        workstreamId: wsId as never,
        sessionId: sessionId as never,
        actor: { kind: 'human', id: 'alice' as never },
        idempotencyScope: 'prompt',
        idempotencyKey: 'k1',
        purpose: 'user',
        acceptedAt: new Date(),
        request: { prompt: [] },
      })
      turnId = command.id as string
    } finally {
      setupClient.release()
    }

    async function append(input: Parameters<typeof appendEvent>[1]) {
      const client = await pool.connect()
      try {
        return await appendEvent(client, input)
      } finally {
        client.release()
      }
    }

    await append({
      eventId: randomId(),
      workstreamId: wsId,
      sessionId,
      direction: 'client_to_agent',
      rpcKind: 'request',
      method: 'session/prompt',
      rpcId: 'req-1',
      envelope: JSON.stringify({ jsonrpc: '2.0', id: 'req-1', method: 'session/prompt', params: {} }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
      observedAt: new Date(),
    })
    for (const text of ['a', 'b', 'c']) {
      await append({
        eventId: randomId(),
        workstreamId: wsId,
        sessionId,
        direction: 'agent_to_client',
        rpcKind: 'notification',
        method: 'session/update',
        envelope: JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
        }),
        commandId: turnId,
        purpose: 'user',
        ingestMode: 'live',
        observedAt: new Date(),
      })
    }
    await append({
      eventId: randomId(),
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'response',
      rpcId: 'req-1',
      envelope: JSON.stringify({ jsonrpc: '2.0', id: 'req-1', result: { stopReason: 'end_turn' } }),
      commandId: turnId,
      purpose: 'user',
      ingestMode: 'live',
      observedAt: new Date(),
    })

    const projectorClient = await pool.connect()
    try {
      await projectWorkstream(projectorClient, wsId, new Date())
    } finally {
      projectorClient.release()
    }

    const client = await pool.connect()
    try {
      const itemsPage = await listWorkstreamItemsPage(client, wsId, { limit: 100 })
      assert.equal(itemsPage.items.length, 1, 'three chunks with no messageId collapse into one item')
      assert.equal(itemsPage.throughWorkstreamSeq, 5)
      assert.ok(itemsPage.feedPosition > 0)
      assert.equal(itemsPage.nextBeforeSeq, null)

      const turnsPage = await listWorkstreamTurnsPage(client, wsId, { limit: 100 })
      assert.equal(turnsPage.turns.length, 1)
      assert.equal(turnsPage.turns[0]?.status, 'completed')
      assert.equal(turnsPage.throughWorkstreamSeq, itemsPage.throughWorkstreamSeq)
      assert.equal(turnsPage.feedPosition, itemsPage.feedPosition)
    } finally {
      client.release()
    }
  })
})
