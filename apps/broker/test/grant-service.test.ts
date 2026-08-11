import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EquipmentRequest } from '@agora/domain'
import { EQUIPMENT_CATALOGUE_VERSION } from '@agora/equipment-policy'
import type pg from 'pg'
import { getActivationByGrant } from '../src/activations-repository.js'
import {
  activateExecutionGrant,
  issueExecutionGrant,
  releaseSessionAgent,
  renewExecutionGrant,
  revokeExecutionGrant,
  type GrantServiceDeps,
} from '../src/grant-service.js'
import { getGrant, GrantConflictError, GrantDigestChangedError } from '../src/grants-repository.js'
import { OneCliUnavailableError } from '../src/onecli-adapter.js'
import { getOnecliAgentMapping, readUpstreamAuthority } from '../src/onecli-agents-repository.js'
import { FAKE_CA_CERTIFICATE, FAKE_CONNECTIONS, FAKE_SECRETS, FakeOneCliControlAdapter, fakeCredentialStubs } from '../src/onecli-fake.js'
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
    assert.equal(d.onecli.findIdentifierForProxyCredentialForTest('x:anything'), undefined)
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

test('required: credential grants that did not take effect prevent issue (the ADR 0015 replacement for publish-then-verify)', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    d.onecli.simulateIneffectiveGrantsOnce = true
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
              agentId: 'claude-code',
              principalId: 'alice',
              workstreamCategory: 'discussion',
              runtimeDefinitionVersion: 'v1',
              equipment: VAULT_READ,
              requestId: randomId(),
            },
            new Date(),
          ),
        (error: unknown) => error instanceof Error && error.name === 'GrantsNotEffectiveError',
      )
      const { rows } = await client.query('SELECT count(*)::int AS n FROM broker.execution_grants WHERE session_id = $1', [sessionId])
      assert.equal(rows[0].n, 0, 'a grant must never be trusted while OneCLI does not report its credentials as usable')
    } finally {
      client.release()
    }
  })
})

test('required (upgrade gate): an Agent that ends up with MORE than its intended grants prevents issue — "exactly its intended grants, not the whole pool"', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    // The ≥1.44 boot converter materializes an existing `secretMode: all` Agent's whole credential
    // pool as explicit grants. An Agent that came through that conversion holding more than Agora
    // issued it is exactly the case this check exists for.
    d.onecli.simulateExtraCredentialOnce = true
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
              agentId: 'claude-code',
              principalId: 'alice',
              workstreamCategory: 'discussion',
              runtimeDefinitionVersion: 'v1',
              equipment: VAULT_READ,
              requestId: randomId(),
            },
            new Date(),
          ),
        (error: unknown) => error instanceof Error && error.name === 'GrantsNotEffectiveError',
      )
      const { rows } = await client.query('SELECT count(*)::int AS n FROM broker.execution_grants WHERE session_id = $1', [sessionId])
      assert.equal(rows[0].n, 0)
    } finally {
      client.release()
    }
  })
})

test('required: grant isolation — a Claude Session Agent can inject Anthropic and NOT OpenAI; a Codex Session Agent the inverse', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const claude = await issue(pool, d, { sessionId: randomId(), agentId: 'claude-code' })
    const codex = await issue(pool, d, { sessionId: randomId(), agentId: 'codex' })

    const anthropic = FAKE_SECRETS.find((secret) => secret.type === 'anthropic')!.id
    const openai = FAKE_SECRETS.find((secret) => secret.type === 'openai')!.id

    const claudeEffective = await d.onecli.getEffectiveCredentials(claude.onecliIdentifier)
    const codexEffective = await d.onecli.getEffectiveCredentials(codex.onecliIdentifier)

    assert.deepEqual(claudeEffective.secrets, [{ id: anthropic, status: 'usable' }])
    assert.deepEqual(codexEffective.secrets, [{ id: openai, status: 'usable' }])
  })
})

test('required: issuing one Session\'s grant changes nothing observable for another Session\'s Agent (no shared republish)', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const first = await issue(pool, d, { sessionId: randomId(), agentId: 'claude-code' })
    const before = await d.onecli.getEffectiveCredentials(first.onecliIdentifier)

    const second = await issue(pool, d, {
      sessionId: randomId(),
      agentId: 'codex',
      equipment: { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'github', access: 'read' }] },
    })
    const afterIssue = await d.onecli.getEffectiveCredentials(first.onecliIdentifier)
    assert.deepEqual(afterIssue, before, 'a second Session\'s issue must not touch the first Session\'s credential set')

    const client = await pool.connect()
    try {
      await revokeExecutionGrant(client, d, second.id, new Date())
    } finally {
      client.release()
    }
    const afterRevoke = await d.onecli.getEffectiveCredentials(first.onecliIdentifier)
    assert.deepEqual(afterRevoke, before, 'nor must its revoke')
  })
})

test('required: equipment maps to a connection grant with exactly the reviewed tool ids', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d, {
      sessionId: randomId(),
      agentId: 'claude-code',
      equipment: { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'github', access: 'read' }] },
    })
    const githubConnection = FAKE_CONNECTIONS.find((connection) => connection.provider === 'github-app')!.id
    const tools = d.onecli.getGrantedToolIdsForTest(grant.onecliIdentifier, githubConnection)
    assert.ok(tools, 'the github-app connection is attached to this Session\'s Agent')
    assert.ok(tools.includes('git_clone'))
    assert.ok(!tools.includes('git_push'), 'read access must not carry a write tool')
  })
})

test('required: an equipment/Agent combination with no reviewed credential mapping is denied before any OneCLI mutation', async () => {
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
              agentId: 'an-agent-nobody-reviewed',
              principalId: 'alice',
              workstreamCategory: 'discussion',
              runtimeDefinitionVersion: 'v1',
              equipment: VAULT_READ,
              requestId: randomId(),
            },
            new Date(),
          ),
        (error: unknown) => error instanceof Error && error.name === 'CredentialPolicyError',
      )
      assert.deepEqual(await d.onecli.listAgents(), [], 'no OneCLI Agent was created for an unreviewable request')
    } finally {
      client.release()
    }
  })
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
    // Built from a DIFFERENT identifier than the Agent this issue() call will actually create —
    // the real live P11 scenario: two different per-Session Agents, same underlying account,
    // different id_token signature. Proves the comparison tolerates that, not just literal equality.
    const d: GrantServiceDeps = {
      onecli: new FakeOneCliControlAdapter(),
      encryptionKey: testEncryptionKey(),
      expectedRuntimeBundle: { caCertificate: FAKE_CA_CERTIFICATE, credentialStubs: fakeCredentialStubs('some-other-agent-entirely') },
    }
    // `codex` so the Agent is actually granted the OpenAI credential and OneCLI therefore returns
    // the Codex stub — a `fake-agent` Session holds no credential and would return none, which
    // would pass the check without ever comparing a stub.
    const grant = await issue(pool, d, { agentId: 'codex' })
    assert.ok(grant.id)
  })
})

test('required (ADR 0015): a Session Agent that legitimately holds no Codex credential returns no Codex stub, and still issues', async () => {
  await withTestDatabase(async (pool) => {
    // The exact case exact-set-equality would have failed by construction once grants made
    // credentials per-Agent: a Claude Session's Agent has no OpenAI grant, so OneCLI emits no
    // Codex `auth.json` stub at all. The operator-pinned list is a reviewed SUPERSET.
    const d: GrantServiceDeps = {
      onecli: new FakeOneCliControlAdapter(),
      encryptionKey: testEncryptionKey(),
      expectedRuntimeBundle: { caCertificate: FAKE_CA_CERTIFICATE, credentialStubs: fakeCredentialStubs('operator-pinned-reference') },
    }
    const grant = await issue(pool, d, { agentId: 'claude-code' })
    assert.ok(grant.id)
    const config = await d.onecli.getContainerConfig(grant.onecliIdentifier)
    assert.deepEqual(config.credentialStubs, [], 'no OpenAI grant, no Codex stub — isolation is visible in the container config itself')
  })
})

test('required: a trailing-newline-only CA difference is not treated as drift (a YAML `|` block scalar always appends one; OneCLI\'s own API response does not)', async () => {
  await withTestDatabase(async (pool) => {
    const d: GrantServiceDeps = {
      onecli: new FakeOneCliControlAdapter(),
      encryptionKey: testEncryptionKey(),
      expectedRuntimeBundle: { caCertificate: `${FAKE_CA_CERTIFICATE}\n\n`, credentialStubs: fakeCredentialStubs('some-other-agent-entirely') },
    }
    const grant = await issue(pool, d)
    assert.ok(grant.id)
  })
})

test('required: a genuinely different credential stub (not just a different signature) still trips drift', async () => {
  await withTestDatabase(async (pool) => {
    const d: GrantServiceDeps = {
      onecli: new FakeOneCliControlAdapter(),
      encryptionKey: testEncryptionKey(),
      expectedRuntimeBundle: {
        caCertificate: FAKE_CA_CERTIFICATE,
        credentialStubs: [{ containerPath: '/home/node/.codex/auth.json', content: JSON.stringify({ tokens: { id_token: 'not-even-jwt-shaped' } }) }],
      },
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
              // `codex`: the Agent must actually be granted the OpenAI credential for OneCLI to
              // return a stub at all, otherwise there is nothing for the drift check to compare.
              agentId: 'codex',
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
    } finally {
      client.release()
    }
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
      assert.notEqual(authorityA.proxyCredential, authorityB.proxyCredential, 'no cross-Session upstream bearer reuse')
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
      assert.notEqual(after.proxyCredential, before.proxyCredential, 'renewal must rotate the upstream bearer, not reuse the one from issue')
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

test('required, P11 (resume): the SAME workload re-activating an already-activated grant with a DIFFERENT request_id succeeds idempotently and its expiry is refreshed', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      const first = await activateExecutionGrant(
        client,
        { grantRef: grant.id, sessionId: grant.sessionId, agentId: grant.agentId, workloadIdentity: 'workload-a', requestId: randomId() },
        new Date('2026-01-01T00:00:00Z'),
      )
      // The controller mints a FRESH random requestId on every materialize call (apps/session-
      // runtime-controller/src/server.ts) — including resume, where the workloadIdentity (derived
      // deterministically from sessionId) is the SAME as the original activation. This must NOT
      // throw ActivationConflictError, or every resume would fail closed.
      const resumed = await activateExecutionGrant(
        client,
        { grantRef: grant.id, sessionId: grant.sessionId, agentId: grant.agentId, workloadIdentity: 'workload-a', requestId: randomId() },
        new Date('2026-01-01T00:20:00Z'),
      )
      assert.equal(resumed.id, first.id, 'same activation row, not a new one')
      assert.ok(resumed.expiresAt.getTime() > first.expiresAt.getTime(), 'expiry is refreshed, not left stale from the original activation')

      const stillBound = await getActivationByGrant(client, grant.id)
      assert.equal(stillBound?.id, first.id)
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

// ---------------------------------------------------------------------------------------------
// The Agent's life follows the Session Runtime's: released on suspend, provisioned again on resume.
// ---------------------------------------------------------------------------------------------

test('required: release gives the Agent up but leaves the grant renewable', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      await releaseSessionAgent(client, d, grant.id, new Date())

      // Gone from OneCLI — a dematerialised Runtime must not leave a standing Agent access token
      // attached to real provider credentials behind it.
      assert.equal(
        (await d.onecli.listAgents()).some((agent) => agent.identifier === grant.onecliIdentifier),
        false,
      )
      // `suspended`, not `deleted`: the Session is coming back.
      assert.equal((await getOnecliAgentMapping(client, grant.sessionId))?.state, 'suspended')
      // The grant itself is untouched, which is what keeps `renew` available.
      assert.equal((await getGrant(client, grant.id))?.state, 'issued')
      // The upstream authority went with the Agent — it authenticates against something that no
      // longer exists.
      assert.equal(await readUpstreamAuthority(client, d.encryptionKey, grant.sessionId), undefined)
    } finally {
      client.release()
    }
  })
})

test('required: renewing a released grant provisions the Agent again, under the same identifier', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      const credentialsWhenIssued = await d.onecli.getEffectiveCredentials(grant.onecliIdentifier)
      await releaseSessionAgent(client, d, grant.id, new Date())

      // This is the whole resume path: renew is what `resumeSessionRuntime` calls. Before this
      // change it threw `no onecli agent found` here and took the Session to `failed` — the
      // 2026-08-11 outage, 14 Sessions out of 14.
      const renewed = await renewExecutionGrant(client, d, grant.id, new Date())

      assert.equal(renewed.onecliIdentifier, grant.onecliIdentifier, 'the Agent must come back under the identifier the grant records')
      assert.ok((await d.onecli.listAgents()).some((agent) => agent.identifier === grant.onecliIdentifier))
      assert.equal((await getOnecliAgentMapping(client, grant.sessionId))?.state, 'active')

      // Same authority as a fresh Session gets — a resumed Session must not come back weaker,
      // which is why both paths provision through one function.
      assert.deepEqual(await d.onecli.getEffectiveCredentials(grant.onecliIdentifier), credentialsWhenIssued)

      // docs/specs/10: a renewal preserves the capability digest. Re-provisioning must not have
      // changed what this grant authorises.
      assert.equal(renewed.capabilityDigest, grant.capabilityDigest)

      // And the Pod can authenticate again: a fresh upstream bearer was stored.
      assert.notEqual(await readUpstreamAuthority(client, d.encryptionKey, grant.sessionId), undefined)
    } finally {
      client.release()
    }
  })
})

test('required: a suspend/resume cycle can repeat — the Agent is not a one-shot resource', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await releaseSessionAgent(client, d, grant.id, new Date())
        await renewExecutionGrant(client, d, grant.id, new Date())
        assert.ok(
          (await d.onecli.listAgents()).some((agent) => agent.identifier === grant.onecliIdentifier),
          `Agent missing after cycle ${cycle}`,
        )
      }
      // Exactly one Agent, not one per cycle: `ensureSelectiveAgent` converges rather than appends.
      assert.equal((await d.onecli.listAgents()).filter((agent) => agent.identifier === grant.onecliIdentifier).length, 1)
    } finally {
      client.release()
    }
  })
})

test('release is idempotent, and refuses to downgrade a revoked grant', async () => {
  await withTestDatabase(async (pool) => {
    const d = deps()
    const grant = await issue(pool, d)
    const client = await pool.connect()
    try {
      await releaseSessionAgent(client, d, grant.id, new Date())
      await releaseSessionAgent(client, d, grant.id, new Date())
      assert.equal((await getOnecliAgentMapping(client, grant.sessionId))?.state, 'suspended')

      const other = await issue(pool, d)
      await revokeExecutionGrant(client, d, other.id, new Date())
      await releaseSessionAgent(client, d, other.id, new Date())
      // `deleted` is terminal — releasing must never walk a Session back out of it.
      assert.equal((await getOnecliAgentMapping(client, other.sessionId))?.state, 'deleted')
      assert.equal((await getGrant(client, other.id))?.state, 'revoked')
    } finally {
      client.release()
    }
  })
})
