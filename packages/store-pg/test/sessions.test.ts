import assert from 'node:assert/strict'
import { test } from 'node:test'
import { principalId, workstreamId } from '@agora/domain'
import { bindAcpSession, bindCapabilities, transitionSessionPhase } from '../src/sessions.js'
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

async function seedSession(pool: import('pg').Pool) {
  const client = await pool.connect()
  try {
    const wsId = workstreamId(randomId())
    const sessionId = randomId()
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: new Date() },
      session: { id: sessionId as never, ordinal: 1, launchEnvelope: launchEnvelope() },
      runtimeDefinitionVersion: 'v3',
    })
    return sessionId
  } finally {
    client.release()
  }
}

test('required: the ACP Session binding cannot be overwritten', async () => {
  await withTestDatabase(async (pool) => {
    const sessionId = await seedSession(pool)
    const client = await pool.connect()
    try {
      await bindAcpSession(client, sessionId, 'acp-session-1', new Date())
      await assert.rejects(() => bindAcpSession(client, sessionId, 'acp-session-2', new Date()))

      const { rows } = await client.query('SELECT acp_session_id FROM product.sessions WHERE id = $1', [sessionId])
      assert.equal(rows[0].acp_session_id, 'acp-session-1')
    } finally {
      client.release()
    }
  })
})

test('capability binding is bound once and requires a 32-byte digest', async () => {
  await withTestDatabase(async (pool) => {
    const sessionId = await seedSession(pool)
    const client = await pool.connect()
    try {
      await assert.rejects(() => bindCapabilities(client, sessionId, 'policy-v1', new Uint8Array(10)))
      await bindCapabilities(client, sessionId, 'policy-v1', new Uint8Array(32))
      await assert.rejects(() => bindCapabilities(client, sessionId, 'policy-v2', new Uint8Array(32)))

      const { rows } = await client.query('SELECT capability_policy_version FROM product.sessions WHERE id = $1', [sessionId])
      assert.equal(rows[0].capability_policy_version, 'policy-v1')
    } finally {
      client.release()
    }
  })
})

test('phase transitions persist', async () => {
  await withTestDatabase(async (pool) => {
    const sessionId = await seedSession(pool)
    const client = await pool.connect()
    try {
      await bindCapabilities(client, sessionId, 'policy-v1', new Uint8Array(32))
      await bindAcpSession(client, sessionId, 'acp-1', new Date())
      await transitionSessionPhase(client, sessionId, 'provisioning')
      await transitionSessionPhase(client, sessionId, 'ready')
      const { rows } = await client.query('SELECT phase FROM product.sessions WHERE id = $1', [sessionId])
      assert.equal(rows[0].phase, 'ready')
    } finally {
      client.release()
    }
  })
})
