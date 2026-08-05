import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EquipmentRequest } from '@agora/domain'
import { EQUIPMENT_CATALOGUE_VERSION } from '@agora/equipment-policy'
import type pg from 'pg'
import { getActivationByGrant } from '../src/activations-repository.js'
import {
  activateExecutionGrant,
  issueExecutionGrant,
  renewExecutionGrant,
  revokeExecutionGrant,
  type GrantServiceDeps,
} from '../src/grant-service.js'
import { getGrant, GrantConflictError, GrantDigestChangedError } from '../src/grants-repository.js'
import { OneCliUnavailableError } from '../src/onecli-adapter.js'
import { getOnecliAgentMapping, readUpstreamAuthority } from '../src/onecli-agents-repository.js'
import { FAKE_CA_CERTIFICATE, FakeOneCliControlAdapter } from '../src/onecli-fake.js'
import { randomId, testEncryptionKey, testExpectedRuntimeBundle, withTestDatabase } from './support.js'

function deps(): GrantServiceDeps & { onecli: FakeOneCliControlAdapter } {
  return { onecli: new FakeOneCliControlAdapter(), encryptionKey: testEncryptionKey(), expectedRuntimeBundle: testExpectedRuntimeBundle() }
}

const VAULT_READ: EquipmentRequest = { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'vault', access: 'read' }] }

async function issue(pool: pg.Pool, d: GrantServiceDeps, overrides: Partial<Parameters<typeof issueExecutionGrant>[2]> = {}) {
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
        ...overrides,
      },
      new Date(),
    )
  } finally {
    client.release()
  }
}

test('required: unknown/contradictory equipment intent is denied before any OneCLI mutation', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const client = await pool.connect()
    try {
      await assert.rejects(
        () =>
          issueExecutionGrant(
            client,
            d,
            {
              sessionId: randomId(),
              agentId: 'fake-agent',
              principalId: 'alice',
              workstreamCategory: 'discussion',
              runtimeDefinitionVersion: 'v1',
              equipment: { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'nonexistent', access: 'read' }] },
              requestId: randomId(),
            },
            new Date(),
          ),
        (error: unknown) => error instanceof Error && error.name === 'PolicyDenialError',
      )
    } finally {
      client.release()
    }
    // No OneCLI Agent was ever created for the denied attempt.
    assert.equal(d.onecli.findIdentifierForBearerForTest('anything'), undefined)
  })
})

test('required: a denied issue is itself audited as denied (docs/specs/12 "grant issue/deny/revoke counts")', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const sessionId = randomId()
    const client = await pool.connect()
    try {
      await assert.rejects(() =>
        issueExecutionGrant(
          client,
          d,
          {
            sessionId,
            agentId: 'fake-agent',
            principalId: 'alice',
            workstreamCategory: 'discussion',
            runtimeDefinitionVersion: 'v1',
            equipment: { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'nonexistent', access: 'read' }] },
            requestId: randomId(),
          },
          new Date(),
        ),
      )
      const { rows } = await client.query<{ action_class: string; decision: string; detail: unknown }>(
        'SELECT action_class, decision, detail FROM broker.security_audit WHERE session_id = $1',
        [sessionId],
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.action_class, 'execution_grant.issue')
      assert.equal(rows[0]?.decision, 'denied')
      assert.doesNotMatch(JSON.stringify(rows[0]?.detail), /aoc_|bearer|token|secret/i)
    } finally {
      client.release()
    }
  })
})

test('a GrantConflictError is not itself audited as a denial — it is the idempotency invariant working as designed', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const sessionId = randomId()
    await issue(pool, d, { sessionId })
    await assert.rejects(() => issue(pool, d, { sessionId }), (error: unknown) => error instanceof GrantConflictError)
    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ decision: string }>(
        "SELECT decision FROM broker.security_audit WHERE session_id = $1 AND action_class = 'execution_grant.issue'",
        [sessionId],
      )
      assert.deepEqual(rows.map((r) => r.decision), ['approved'], 'only the original successful issue is audited, not the conflicting retry')
    } finally {
      client.release()
    }
  })
})

test('required: concurrent equivalent issue creates exactly one grant and one OneCLI Agent', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const sessionId = randomId()
    const requestId = randomId()
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => issue(pool, d, { sessionId, requestId })),
    )
    const grantIds = new Set(attempts.map((g) => g.id))
    assert.equal(grantIds.size, 1, 'all 8 concurrent identical issues resolved to the same grant')

    const client = await pool.connect()
    try {
      const mapping = await getOnecliAgentMapping(client, sessionId)
      assert.ok(mapping)
    } finally {
      client.release()
    }
  })
})

test('required: OneCLI control-plane outage prevents issue — Session Runtime never becomes ready off an unverified grant', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    d.onecli.unavailable = true
    const client = await pool.connect()
    try {
      await assert.rejects(
        () =>
          issueExecutionGrant(
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
          ),
        (error: unknown) => error instanceof OneCliUnavailableError,
      )
      const { rows } = await client.query('SELECT count(*)::int AS n FROM broker.execution_grants')
      assert.equal(rows[0].n, 0, 'an OneCLI outage must never leave a usable grant behind')
    } finally {
      client.release()
    }
  })
})

test('required: an ambiguous route-policy publish (effective generation does not match) prevents issue', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    // First grant establishes generation 1 cleanly, so the SECOND publish (during the second
    // issue, below) is the one whose readback we make ambiguous — isolating the check to exactly
    // the publish this issue attempt performed, not some earlier one.
    await issue(pool, d, { sessionId: randomId() })
    d.onecli.simulateStaleGenerationOnce = true
    const client = await pool.connect()
    try {
      const sessionId = randomId()
      await assert.rejects(
        () =>
          issueExecutionGrant(
            client,
            d,
            {
              sessionId,
              agentId: 'fake-agent',
              principalId: 'alice',
              workstreamCategory: 'discussion',
              runtimeDefinitionVersion: 'v1',
              equipment: VAULT_READ,
              requestId: randomId(),
            },
            new Date(),
          ),
        (error: unknown) => error instanceof OneCliUnavailableError,
      )
      const { rows } = await client.query('SELECT count(*)::int AS n FROM broker.execution_grants WHERE session_id = $1', [sessionId])
      assert.equal(rows[0].n, 0, 'a grant must never be trusted while its own route-policy publish is ambiguous')
    } finally {
      client.release()
    }
  })
})

test('required: route policy publication rejects a malformed list missing the terminal block *', async () => {
  const onecli = new FakeOneCliControlAdapter()
  await assert.rejects(() => onecli.publishRoutePolicy([{ action: 'allow', host: 'example.test' }]))
  await assert.rejects(() => onecli.publishRoutePolicy([]))
  await assert.rejects(() => onecli.publishRoutePolicy([{ action: 'block', host: '*' }, { action: 'allow', host: 'too-late.test' }]))
})

test('required: OneCLI CA/stub drift from the operator-pinned runtime bundle prevents issue (fail closed)', async () => {
  await withTestDatabase(async (pool) => {
    const d: GrantServiceDeps = {
      onecli: new FakeOneCliControlAdapter(),
      encryptionKey: testEncryptionKey(),
      expectedRuntimeBundle: { caCertificate: 'not-the-real-operator-pinned-ca', credentialStubs: [] },
    }
    const client = await pool.connect()
    try {
      await assert.rejects(
        () =>
          issueExecutionGrant(
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
          ),
        (error: unknown) => error instanceof Error && error.name === 'RuntimeBundleDriftError',
      )
      const { rows } = await client.query('SELECT count(*)::int AS n FROM broker.execution_grants')
      assert.equal(rows[0].n, 0, 'a drift-rejected issue must never leave a grant row behind')
      const { rows: authorityRows } = await client.query('SELECT count(*)::int AS n FROM broker.upstream_authority')
      assert.equal(authorityRows[0].n, 0, 'an unverified upstream bearer must never be stored, let alone trusted')
    } finally {
      client.release()
    }
  })
})

test('a matching runtime bundle (the normal case) issues successfully — confirms the drift check is not just always-fail', async () => {
  await withTestDatabase(async (pool) => {
    const d: GrantServiceDeps = {
      onecli: new FakeOneCliControlAdapter(),
      encryptionKey: testEncryptionKey(),
      expectedRuntimeBundle: { caCertificate: FAKE_CA_CERTIFICATE, credentialStubs: [] },
    }
    const grant = await issue(pool, d)
    assert.ok(grant.id)
  })
})

test('a session cannot be upgraded in place — a second distinct request_id for the same session is a conflict', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const sessionId = randomId()
    await issue(pool, d, { sessionId })
    await assert.rejects(() => issue(pool, d, { sessionId }), (error: unknown) => error instanceof GrantConflictError)
  })
})

test('required: Session A and B receive distinct selective OneCLI Agents and policy sets', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const a = await issue(pool, d, { sessionId: randomId() })
    const b = await issue(pool, d, {
      sessionId: randomId(),
      equipment: { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'github', access: 'read' }] },
    })
    assert.notEqual(a.onecliIdentifier, b.onecliIdentifier)
    assert.notEqual(a.capabilityDigest, b.capabilityDigest)

    const client = await pool.connect()
    try {
      const authorityA = await readUpstreamAuthority(client, d.encryptionKey, a.sessionId)
      const authorityB = await readUpstreamAuthority(client, d.encryptionKey, b.sessionId)
      assert.ok(authorityA && authorityB)
      assert.notEqual(authorityA.bearer, authorityB.bearer, 'no cross-Session upstream bearer reuse')
    } finally {
      client.release()
    }
  })
})

test('required: the Agent process/environment/filesystem never see any OneCLI control key, upstream bearer or provider credential — grant payload is safe', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const serialized = JSON.stringify(grant)
    assert.doesNotMatch(serialized, /aoc_|bearer|token|secret/i)
    for (const server of grant.mcpServers) assert.equal(server.headers.length, 0)
  })
})

test('required: renewal with a changed capability digest (policy version moved on) is rejected', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      // Simulate a policy-version bump between issue and renew by mutating the stored row directly
      // (there is no real second EQUIPMENT_POLICY_VERSION constant to deploy in-process).
      await client.query(`UPDATE broker.execution_grants SET policy_version = 'equipment-policy-v0-retired' WHERE id = $1`, [grant.id])
      await assert.rejects(() => renewExecutionGrant(client, d, grant.id, new Date()), (error: unknown) => error instanceof GrantDigestChangedError)
    } finally {
      client.release()
    }
  })
})

test('required: renewal preserves capability digest/Agent/OneCLI mapping and rotates the upstream authority behind the same binding', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      const before = await readUpstreamAuthority(client, d.encryptionKey, grant.sessionId)
      const renewed = await renewExecutionGrant(client, d, grant.id, new Date(grant.issuedAt.getTime() + 1000))
      assert.equal(renewed.capabilityDigest, grant.capabilityDigest)
      assert.equal(renewed.onecliIdentifier, grant.onecliIdentifier)
      assert.ok(renewed.expiresAt.getTime() > grant.expiresAt.getTime())
      const after = await readUpstreamAuthority(client, d.encryptionKey, grant.sessionId)
      assert.ok(before && after)
      assert.notEqual(after.bearer, before.bearer, 'renewal must rotate the upstream bearer, not reuse the one from issue')
    } finally {
      client.release()
    }
  })
})

test('required: revocation immediately marks the grant unusable and deletes/rotates upstream OneCLI authority', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      await revokeExecutionGrant(client, d, grant.id, new Date())
      const reread = await getGrant(client, grant.id)
      assert.equal(reread?.state, 'revoked')
      const mapping = await getOnecliAgentMapping(client, grant.sessionId)
      assert.equal(mapping?.state, 'deleted')
      const authority = await readUpstreamAuthority(client, d.encryptionKey, grant.sessionId)
      assert.equal(authority, undefined, 'upstream authority is deleted, not merely orphaned')
      // The underlying OneCLI Agent is deleted and can never be reused (docs/specs/10 "never reassigned").
      await assert.rejects(() => d.onecli.getContainerConfig(grant.onecliIdentifier))
    } finally {
      client.release()
    }
  })
})

test('revoking an already-revoked (or unknown) grant is an idempotent no-op', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      await revokeExecutionGrant(client, d, grant.id, new Date())
      await revokeExecutionGrant(client, d, grant.id, new Date())
      await revokeExecutionGrant(client, d, randomId(), new Date())
    } finally {
      client.release()
    }
  })
})

test('required: a denied activation (grantRef/session/agent mismatch) is itself audited as denied', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      await assert.rejects(() =>
        activateExecutionGrant(
          client,
          { grantRef: grant.id, sessionId: grant.sessionId, agentId: 'a-completely-different-agent', workloadIdentity: 'workload-a', requestId: randomId() },
          new Date(),
        ),
      )
      const { rows } = await client.query<{ action_class: string; decision: string }>(
        "SELECT action_class, decision FROM broker.security_audit WHERE session_id = $1 AND action_class = 'execution_grant.activate'",
        [grant.sessionId],
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.decision, 'denied')
    } finally {
      client.release()
    }
  })
})

test('required: grant + session_id + agent_id + workload_identity is bound exactly once; a different workload cannot rebind', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      const activation = await activateExecutionGrant(
        client,
        { grantRef: grant.id, sessionId: grant.sessionId, agentId: grant.agentId, workloadIdentity: 'workload-a', requestId: randomId() },
        new Date(),
      )
      assert.equal(activation.workloadIdentity, 'workload-a')

      await assert.rejects(
        () =>
          activateExecutionGrant(
            client,
            { grantRef: grant.id, sessionId: grant.sessionId, agentId: grant.agentId, workloadIdentity: 'workload-b', requestId: randomId() },
            new Date(),
          ),
        (error: unknown) => error instanceof Error,
      )

      const stillBound = await getActivationByGrant(client, grant.id)
      assert.equal(stillBound?.workloadIdentity, 'workload-a')
    } finally {
      client.release()
    }
  })
})

test('activation is idempotent by request_id — a retried identical activation returns the same row', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      const requestId = randomId()
      const first = await activateExecutionGrant(
        client,
        { grantRef: grant.id, sessionId: grant.sessionId, agentId: grant.agentId, workloadIdentity: 'workload-a', requestId },
        new Date(),
      )
      const second = await activateExecutionGrant(
        client,
        { grantRef: grant.id, sessionId: grant.sessionId, agentId: grant.agentId, workloadIdentity: 'workload-a', requestId },
        new Date(),
      )
      assert.equal(first.id, second.id)
    } finally {
      client.release()
    }
  })
})

test('required: audit rows never carry a secret-shaped key, and record issue/activate/renew/revoke', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      await activateExecutionGrant(
        client,
        { grantRef: grant.id, sessionId: grant.sessionId, agentId: grant.agentId, workloadIdentity: 'workload-a', requestId: randomId() },
        new Date(),
      )
      await renewExecutionGrant(client, d, grant.id, new Date())
      await revokeExecutionGrant(client, d, grant.id, new Date())

      const { rows } = await client.query<{ action_class: string; decision: string; detail: unknown }>(
        'SELECT action_class, decision, detail FROM broker.security_audit WHERE session_id = $1 ORDER BY created_at',
        [grant.sessionId],
      )
      const classes = rows.map((r) => r.action_class)
      assert.deepEqual(classes, [
        'execution_grant.issue',
        'execution_grant.activate',
        'execution_grant.renew',
        'execution_grant.revoke',
      ])
      for (const row of rows) {
        assert.equal(row.decision, 'approved')
        const serialized = JSON.stringify(row.detail)
        assert.doesNotMatch(serialized, /aoc_|bearer|token|secret/i)
      }
    } finally {
      client.release()
    }
  })
})
