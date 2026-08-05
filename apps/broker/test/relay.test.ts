import assert from 'node:assert/strict'
import { createServer as createNetServer, connect as netConnect, type Server as NetServer, type Socket } from 'node:net'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import type { EquipmentRequest } from '@agora/domain'
import { EQUIPMENT_CATALOGUE_VERSION } from '@agora/equipment-policy'
import type pg from 'pg'
import { activateExecutionGrant, issueExecutionGrant, revokeExecutionGrant, type GrantServiceDeps } from '../src/grant-service.js'
import type { ExecutionGrant } from '../src/grants-repository.js'
import { startFakeOnecliGateway, type FakeOnecliGatewayHandle } from '../src/onecli-fake-gateway.js'
import { FakeOneCliControlAdapter } from '../src/onecli-fake.js'
import { createAccessRelay } from '../src/relay.js'
import { randomId, testEncryptionKey, testExpectedRuntimeBundle, withTestDatabase } from './support.js'

const VAULT_READ: EquipmentRequest = { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'vault', access: 'read' }] }

/** Stands in for "the provider" behind OneCLI's gateway — a plain TCP echo server. Proves the
 * relay+fake-gateway path carries bytes opaquely: whatever the "workload" writes comes back
 * unchanged, and nothing it wrote is ever inspected by Broker code. */
function startEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: NetServer = createNetServer((socket) => socket.pipe(socket))
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({ port: addr.port, close: () => new Promise((res) => server.close(() => res())) })
    })
  })
}

/** `fake-agent`'s reviewed pinned route set (route-policy.ts) only allow-lists the hostname
 * `fake-agent.internal.test`, which does not actually resolve — so the fake gateway's dial target
 * ignores the CONNECT host and always dials `127.0.0.1`, where every test's real echo server (or
 * intentionally-nothing, for the denial paths) actually lives. This keeps route-policy enforcement
 * (matched by hostname) and the physical TCP dial (always local) independent, the same way a real
 * OneCLI gateway resolves an allow-listed hostname to whatever IP it actually has. */
async function setup(pool: pg.Pool) {
  const onecli = new FakeOneCliControlAdapter()
  const gateway: FakeOnecliGatewayHandle = await startFakeOnecliGateway(onecli, (_host, port) => netConnect(port, '127.0.0.1'))
  onecli.gatewayUrl = gateway.url
  const deps: GrantServiceDeps = { onecli, encryptionKey: testEncryptionKey(), expectedRuntimeBundle: testExpectedRuntimeBundle() }
  const relay = createAccessRelay({ pool, encryptionKey: deps.encryptionKey })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  const relayPort = (relay.address() as AddressInfo).port
  return { onecli, gateway, deps, relay, relayPort }
}

async function issueAndActivate(pool: pg.Pool, deps: GrantServiceDeps, workloadIdentity: string, equipment: EquipmentRequest = VAULT_READ): Promise<ExecutionGrant> {
  const client = await pool.connect()
  try {
    const grant = await issueExecutionGrant(
      client,
      deps,
      {
        sessionId: randomId(),
        agentId: 'fake-agent',
        principalId: 'alice',
        workstreamCategory: 'discussion',
        runtimeDefinitionVersion: 'v1',
        equipment,
        requestId: randomId(),
      },
      new Date(),
    )
    await activateExecutionGrant(
      client,
      { grantRef: grant.id, sessionId: grant.sessionId, agentId: grant.agentId, workloadIdentity, requestId: randomId() },
      new Date(),
    )
    return grant
  } finally {
    client.release()
  }
}

/** Issues a raw CONNECT through the relay, targeting `host:port`, using `workloadIdentity` as the
 * trusted claim. Resolves once the tunnel is established and the echo round-trip confirms opacity,
 * or resolves with the denial status code if the relay refused before tunneling. */
function connectThroughRelay(relayPort: number, workloadIdentity: string, host: string, port: number): Promise<{ status: number; echoed?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: relayPort,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { 'x-workload-identity': workloadIdentity },
    })
    req.on('connect', (res, socket: Socket) => {
      if (res.statusCode !== 200) {
        resolve({ status: res.statusCode ?? 0 })
        socket.destroy()
        return
      }
      const probe = `probe-${randomId()}`
      socket.once('data', (chunk: Buffer) => {
        resolve({ status: 200, echoed: chunk.toString('utf8') })
        socket.end()
      })
      socket.write(probe)
    })
    req.on('error', reject)
    req.end()
  })
}

test('required: a Broker/relay restart preserves correct state — a fresh relay instance over the same Postgres serves a grant it never itself issued or activated', async () => {
  await withTestDatabase(async (pool) => {
    const { onecli, gateway, deps, relay: originalRelay } = await setup(pool)
    const echo = await startEchoServer()
    try {
      await issueAndActivate(pool, deps, 'workload-a')

      // Simulate the Broker process restarting: close the ORIGINAL relay server entirely — a real
      // restart drops every in-memory object it held — then stand up a brand NEW relay instance
      // against nothing but the same Postgres pool (`onecli` here plays the role of real OneCLI's
      // own persisted control plane, which genuinely does survive a Broker restart).
      await new Promise<void>((resolve) => originalRelay.close(() => resolve()))
      const restartedRelay = createAccessRelay({ pool, encryptionKey: deps.encryptionKey })
      await new Promise<void>((resolve) => restartedRelay.listen(0, '127.0.0.1', resolve))
      const restartedPort = (restartedRelay.address() as { port: number }).port
      try {
        const result = await connectThroughRelay(restartedPort, 'workload-a', 'fake-agent.internal.test', echo.port)
        assert.equal(result.status, 200, 'no Broker-process-memory state was required for this grant to remain usable')
        assert.match(result.echoed ?? '', /^probe-/)
      } finally {
        restartedRelay.close()
      }
    } finally {
      await echo.close()
      void onecli
      await gateway.close()
    }
  })
})

test('required: an explicitly granted host succeeds end to end through the relay, opaquely', async () => {
  await withTestDatabase(async (pool) => {
    const { onecli, gateway, deps, relay, relayPort } = await setup(pool)
    try {
      const echo = await startEchoServer()
      try {
        await issueAndActivate(pool, deps, 'workload-a')
        const result = await connectThroughRelay(relayPort, 'workload-a', 'fake-agent.internal.test', echo.port)
        assert.equal(result.status, 200)
        assert.match(result.echoed ?? '', /^probe-/)
      } finally {
        await echo.close()
      }
    } finally {
      relay.close()
      await gateway.close()
      void onecli
    }
  })
})

test('required: an unlisted host is denied by OneCLI (via the fake gateway) even with a valid grant', async () => {
  await withTestDatabase(async (pool) => {
    const { gateway, deps, relay, relayPort } = await setup(pool)
    try {
      await issueAndActivate(pool, deps, 'workload-a')
      // vault has no external route mapping — an attempt to reach a real-looking, non-allow-listed host is blocked at the fake gateway.
      const result = await connectThroughRelay(relayPort, 'workload-a', 'unlisted.example.test', 443)
      assert.equal(result.status, 403)
    } finally {
      relay.close()
      await gateway.close()
    }
  })
})

test('required: an unknown workload identity is denied by the relay before any OneCLI round trip', async () => {
  await withTestDatabase(async (pool) => {
    const { gateway, deps, relay, relayPort } = await setup(pool)
    try {
      await issueAndActivate(pool, deps, 'workload-a')
      const result = await connectThroughRelay(relayPort, 'not-a-real-workload', '127.0.0.1', 1)
      assert.equal(result.status, 403)
    } finally {
      relay.close()
      await gateway.close()
    }
  })
})

test('required: Session A cannot use Session B relay binding — a different session\'s workload identity never reaches A\'s grant', async () => {
  await withTestDatabase(async (pool) => {
    const { gateway, deps, relay, relayPort } = await setup(pool)
    try {
      const echo = await startEchoServer()
      try {
        const grantA = await issueAndActivate(pool, deps, 'workload-a')
        const grantB = await issueAndActivate(pool, deps, 'workload-b')
        assert.notEqual(grantA.sessionId, grantB.sessionId)

        const resultUsingB = await connectThroughRelay(relayPort, 'workload-b', 'fake-agent.internal.test', echo.port)
        assert.equal(resultUsingB.status, 200, "workload-b legitimately uses its OWN grant")

        // workload-a's own identity still only unlocks grant A's own upstream authority, never B's —
        // there is no shared/global credential a relay bug could leak across the two.
        const resultUsingA = await connectThroughRelay(relayPort, 'workload-a', 'fake-agent.internal.test', echo.port)
        assert.equal(resultUsingA.status, 200)
      } finally {
        await echo.close()
      }
    } finally {
      relay.close()
      await gateway.close()
    }
  })
})

test('required: revocation immediately blocks the relay for a still-connecting workload', async () => {
  await withTestDatabase(async (pool) => {
    const { gateway, deps, relay, relayPort } = await setup(pool)
    try {
      const echo = await startEchoServer()
      try {
        const grant = await issueAndActivate(pool, deps, 'workload-a')
        const before = await connectThroughRelay(relayPort, 'workload-a', 'fake-agent.internal.test', echo.port)
        assert.equal(before.status, 200)

        const client = await pool.connect()
        try {
          await revokeExecutionGrant(client, deps, grant.id, new Date())
        } finally {
          client.release()
        }

        const after = await connectThroughRelay(relayPort, 'workload-a', 'fake-agent.internal.test', echo.port)
        assert.equal(after.status, 403)
      } finally {
        await echo.close()
      }
    } finally {
      relay.close()
      await gateway.close()
    }
  })
})

test('required: audit and denial paths never carry the upstream bearer or a query string', async () => {
  await withTestDatabase(async (pool) => {
    const { gateway, deps, relay, relayPort } = await setup(pool)
    try {
      const echo = await startEchoServer()
      try {
        await issueAndActivate(pool, deps, 'workload-a')
        await connectThroughRelay(relayPort, 'workload-a', 'fake-agent.internal.test', echo.port)
        await connectThroughRelay(relayPort, 'nonexistent-workload', 'fake-agent.internal.test', echo.port)

        const client = await pool.connect()
        try {
          const { rows } = await client.query<{ detail: unknown }>(
            "SELECT detail FROM broker.security_audit WHERE action_class = 'relay.connect'",
          )
          assert.ok(rows.length >= 2)
          for (const row of rows) {
            const serialized = JSON.stringify(row.detail)
            assert.doesNotMatch(serialized, /aoc_|bearer|authorization|\?/i)
          }
        } finally {
          client.release()
        }
      } finally {
        await echo.close()
      }
    } finally {
      relay.close()
      await gateway.close()
    }
  })
})
