import assert from 'node:assert/strict'
import { test } from 'node:test'
import { principalId, workstreamId } from '@agora/domain'
import { createOrReuseCommand, transitionCommandState } from '../src/commands.js'
import { createWorkstreamWithFirstSession } from '../src/workstreams.js'
import { randomId, withTestDatabase } from './support.js'

function launchEnvelope() {
  return {
    agentId: 'claude-code',
    workspaceSpec: { root: '/work' },
    equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
    runtimeDefinitionVersion: 'v3',
  }
}

async function seedWorkstream(pool: import('pg').Pool) {
  const client = await pool.connect()
  try {
    const wsId = workstreamId(randomId())
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: new Date() },
      session: { id: randomId() as never, ordinal: 1, launchEnvelope: launchEnvelope() },
      runtimeDefinitionVersion: 'v3',
    })
    return wsId as string
  } finally {
    client.release()
  }
}

test('required: a duplicate command (same idempotency scope/key) does not duplicate the row — same command returned', async () => {
  await withTestDatabase(async (pool) => {
    const wsId = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      const input = {
        type: 'RenameWorkstream' as const,
        workstreamId: workstreamId(wsId),
        actor: { kind: 'human' as const, id: principalId('alice') },
        idempotencyScope: 'rename',
        idempotencyKey: 'retry-key-1',
        acceptedAt: new Date(),
        request: { title: 'New title' },
      }
      const first = await createOrReuseCommand(client, input)
      const second = await createOrReuseCommand(client, input)
      assert.equal(first.id, second.id)

      const { rows } = await client.query('SELECT * FROM product.commands WHERE workstream_id = $1', [wsId])
      assert.equal(rows.length, 1)
    } finally {
      client.release()
    }
  })
})

test('required: concurrent identical retries collapse to one command row (DB UNIQUE constraint is the race-safe source of truth)', async () => {
  await withTestDatabase(async (pool) => {
    const wsId = await seedWorkstream(pool)
    const clients = await Promise.all(Array.from({ length: 8 }, () => pool.connect()))
    try {
      const input = {
        type: 'RenameWorkstream' as const,
        workstreamId: workstreamId(wsId),
        actor: { kind: 'human' as const, id: principalId('alice') },
        idempotencyScope: 'rename',
        idempotencyKey: 'race-key',
        acceptedAt: new Date(),
        request: { title: 'Racing title' },
      }
      const results = await Promise.all(clients.map((client) => createOrReuseCommand(client, input)))
      const ids = new Set(results.map((r) => r.id))
      assert.equal(ids.size, 1)

      const { rows } = await clients[0]!.query('SELECT * FROM product.commands WHERE workstream_id = $1 AND idempotency_key = $2', [
        wsId,
        'race-key',
      ])
      assert.equal(rows.length, 1)
    } finally {
      for (const client of clients) client.release()
    }
  })
})

test('command state transitions and typed completion', async () => {
  await withTestDatabase(async (pool) => {
    const wsId = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      const command = await createOrReuseCommand(client, {
        type: 'RenameWorkstream',
        workstreamId: workstreamId(wsId),
        actor: { kind: 'human', id: principalId('alice') },
        idempotencyScope: 'rename',
        idempotencyKey: 'key-2',
        acceptedAt: new Date(),
        request: {},
      })
      await transitionCommandState(client, command.id, 'dispatching', new Date())
      await transitionCommandState(client, command.id, 'failed', new Date(), { code: 'boom', detail: 'nope' })

      const { rows } = await client.query('SELECT state, error_code, completed_at FROM product.commands WHERE id = $1', [command.id])
      assert.equal(rows[0].state, 'failed')
      assert.equal(rows[0].error_code, 'boom')
      assert.notEqual(rows[0].completed_at, null)
    } finally {
      client.release()
    }
  })
})
