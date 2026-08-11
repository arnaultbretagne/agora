import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EquipmentRequest } from '@agora/domain'
import { EQUIPMENT_CATALOGUE_VERSION } from '@agora/equipment-policy'
import type pg from 'pg'
import { issueExecutionGrant, revokeExecutionGrant, type GrantServiceDeps } from '../src/grant-service.js'
import { ORPHAN_GRACE_MS, reapOrphanOnecliAgents } from '../src/onecli-agent-reaper.js'
import { FakeOneCliControlAdapter } from '../src/onecli-fake.js'
import { randomId, testEncryptionKey, testExpectedRuntimeBundle, withTestDatabase } from './support.js'

const VAULT_READ: EquipmentRequest = { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'vault', access: 'read' }] }

function deps(): GrantServiceDeps & { onecli: FakeOneCliControlAdapter } {
  return { onecli: new FakeOneCliControlAdapter(), encryptionKey: testEncryptionKey(), expectedRuntimeBundle: testExpectedRuntimeBundle() }
}

async function issue(pool: pg.Pool, d: GrantServiceDeps) {
  const client = await pool.connect()
  try {
    return await issueExecutionGrant(
      client,
      d,
      {
        sessionId: randomId(),
        agentId: 'fake-agent',
        principalId: 'alice',
        workstreamCategory: 'discussion',
        runtimeDefinitionVersion: 'v1',
        equipment: VAULT_READ,
        requestId: randomId(),
      },
      new Date(),
    )
  } finally {
    client.release()
  }
}

/** An Agent OneCLI holds that this Broker has no mapping row for — what a crash between
 * `ensureSelectiveAgent` and the grant row, or a revoke whose OneCLI call failed, leaves behind. */
async function seedOrphan(onecli: FakeOneCliControlAdapter, identifier: string, ageMs: number): Promise<void> {
  await onecli.ensureSelectiveAgent(identifier, 'orphaned-session')
  onecli.setAgentCreatedAtForTest(identifier, new Date(Date.now() - ageMs))
}

test('required: an orphaned sagt- Agent is deleted, and a live Session\'s Agent is never touched', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const live = await issue(pool, d)
    const orphan = `sagt-${'a'.repeat(40)}`
    await seedOrphan(d.onecli, orphan, ORPHAN_GRACE_MS + 1000)

    const result = await reapOrphanOnecliAgents(pool, d.onecli, new Date())

    assert.deepEqual(result.reaped, [orphan])
    const remaining = (await d.onecli.listAgents()).map((agent) => agent.identifier)
    assert.ok(remaining.includes(live.onecliIdentifier), 'a live Session\'s credential authority must survive every reap cycle')
    assert.ok(!remaining.includes(orphan))
  })
})

test('required: after a Session is revoked, its Agent is gone within one reap cycle', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)

    // Revocation already deletes the Agent directly; the reaper is the backstop for when that
    // OneCLI call FAILED — revocation deliberately does not depend on OneCLI succeeding, so the
    // mapping row ends `deleted` while OneCLI still holds a fully credentialed Agent. Simulate
    // exactly that failure rather than a state the fake would refuse to reach.
    const realDelete = d.onecli.deleteAgent.bind(d.onecli)
    d.onecli.deleteAgent = async (): Promise<void> => {
      throw new Error('onecli was unreachable during revoke')
    }
    const client = await pool.connect()
    try {
      await assert.rejects(() => revokeExecutionGrant(client, d, grant.id, new Date()))
      const { rows } = await client.query('SELECT 1 FROM broker.onecli_agents WHERE session_id = $1', [grant.sessionId])
      assert.equal(rows.length, 0, 'the Broker has already given up on this Agent — no row, not a tombstone')
    } finally {
      client.release()
    }
    d.onecli.deleteAgent = realDelete
    d.onecli.setAgentCreatedAtForTest(grant.onecliIdentifier, new Date(Date.now() - ORPHAN_GRACE_MS - 1000))
    assert.ok((await d.onecli.listAgents()).some((agent) => agent.identifier === grant.onecliIdentifier))

    const result = await reapOrphanOnecliAgents(pool, d.onecli, new Date())
    assert.deepEqual(result.reaped, [grant.onecliIdentifier])
    assert.deepEqual(await d.onecli.listAgents(), [])
  })
})

test('required: an Agent younger than the grace window is left alone — a concurrent issue is never reaped out from under itself', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    // `ensureSelectiveAgent` necessarily runs before `ensureOnecliAgentMapping` commits, so this
    // is a real state an in-flight issue passes through, not a hypothetical.
    const inFlight = `sagt-${'b'.repeat(40)}`
    await seedOrphan(d.onecli, inFlight, 1000)

    const result = await reapOrphanOnecliAgents(pool, d.onecli, new Date())
    assert.deepEqual(result.reaped, [])
    assert.equal(result.skippedTooYoung, 1)
    assert.ok((await d.onecli.listAgents()).some((agent) => agent.identifier === inFlight))
  })
})

test('required: Agents the operator created are never candidates — only Agora\'s own sagt- prefix', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    for (const identifier of ['default', 'test', 'some-humans-agent']) {
      await seedOrphan(d.onecli, identifier, ORPHAN_GRACE_MS * 10)
    }
    const result = await reapOrphanOnecliAgents(pool, d.onecli, new Date())
    assert.deepEqual(result.reaped, [])
    assert.equal((await d.onecli.listAgents()).length, 3)
  })
})

test('required: a Session\'s Agent is NEVER reaped for having an expired grant — the Session lifecycle decides, not this reaper', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      // The exact state that caused the 2026-08-11 outage: mapping `active`, grant `issued` but
      // expired days ago. The old rule read that as "abandoned, dead credential authority" and
      // deleted the Agent. It was wrong: `renewGrant` never checks expiry, so such a Session
      // resumes perfectly happily — and then died on `rotateAgentAuthority` because its Agent was
      // gone. All 14 suspended Sessions on the real instance were unresumable this way.
      await client.query(`UPDATE broker.execution_grants SET expires_at = now() - interval '2 days' WHERE id = $1`, [grant.id])
    } finally {
      client.release()
    }
    d.onecli.setAgentCreatedAtForTest(grant.onecliIdentifier, new Date(Date.now() - ORPHAN_GRACE_MS * 10))

    const result = await reapOrphanOnecliAgents(pool, d.onecli, new Date())
    assert.deepEqual(result.reaped, [], 'an expired grant is a stale credential, not a dead Session')
    assert.ok((await d.onecli.listAgents()).some((agent) => agent.identifier === grant.onecliIdentifier))
  })
})

test('required: a mapping with no grant row yet is protected while it is young, and reaped once it is stale', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const identifier = `sagt-${'e'.repeat(40)}`
    await seedOrphan(d.onecli, identifier, ORPHAN_GRACE_MS + 1000)
    const client = await pool.connect()
    try {
      // The window between `ensureSelectiveAgent` and the grant insert.
      await client.query(
        `INSERT INTO broker.onecli_agents (session_id, onecli_identifier, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, now(), now())`,
        [identifier],
      )
      assert.deepEqual((await reapOrphanOnecliAgents(pool, d.onecli, new Date())).reaped, [], 'an in-flight issue is never reaped out from under itself')

      await client.query(`UPDATE broker.onecli_agents SET created_at = now() - interval '2 days' WHERE onecli_identifier = $1`, [identifier])
    } finally {
      client.release()
    }
    assert.deepEqual((await reapOrphanOnecliAgents(pool, d.onecli, new Date())).reaped, [identifier], 'a grant insert that never landed must not leak the Agent forever')
  })
})

test('a decommissioned Session has no row, so an Agent still present is an orphan', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      // Decommissioning deletes the Agent first and its row second. This shape — no row, Agent
      // still there — is what a half-finished decommission (or a human re-creating one in the
      // OneCLI dashboard) leaves behind, and reclaiming it is exactly the reaper's job.
      await client.query('DELETE FROM broker.onecli_agents WHERE session_id = $1', [grant.sessionId])
    } finally {
      client.release()
    }
    d.onecli.setAgentCreatedAtForTest(grant.onecliIdentifier, new Date(Date.now() - ORPHAN_GRACE_MS * 10))

    const result = await reapOrphanOnecliAgents(pool, d.onecli, new Date())
    assert.deepEqual(result.reaped, [grant.onecliIdentifier])
  })
})

test('required: a failure to LIST is a hard error — an empty listing must never be read as "everything is an orphan"', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    d.onecli.unavailable = true
    await assert.rejects(() => reapOrphanOnecliAgents(pool, d.onecli, new Date()))
    d.onecli.unavailable = false
    assert.ok((await d.onecli.listAgents()).some((agent) => agent.identifier === grant.onecliIdentifier))
  })
})

test('each reap is audited without leaking credential material, and a failed delete does not stop the pass', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const first = `sagt-${'c'.repeat(40)}`
    const second = `sagt-${'d'.repeat(40)}`
    await seedOrphan(d.onecli, first, ORPHAN_GRACE_MS + 1000)
    await seedOrphan(d.onecli, second, ORPHAN_GRACE_MS + 1000)
    const realDelete = d.onecli.deleteAgent.bind(d.onecli)
    d.onecli.deleteAgent = async (identifier: string): Promise<void> => {
      if (identifier === first) throw new Error('onecli refused this delete')
      await realDelete(identifier)
    }

    const result = await reapOrphanOnecliAgents(pool, d.onecli, new Date())
    assert.deepEqual(result.reaped, [second], 'one stuck Agent must not block the rest of the pass')

    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ decision: string; detail: unknown }>(
        "SELECT decision, detail FROM broker.security_audit WHERE action_class = 'onecli_agent.reap' ORDER BY decision",
      )
      assert.deepEqual(rows.map((row) => row.decision), ['approved', 'denied'])
      for (const row of rows) assert.doesNotMatch(JSON.stringify(row.detail), /aoc_|bearer|token|secret/i)
    } finally {
      client.release()
    }
  })
})
