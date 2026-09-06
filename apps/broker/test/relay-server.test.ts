import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { connect as connectTcp } from 'node:net'
import { test } from 'node:test'
import { EncryptedPrivateStore } from '../src/private-store.js'
import { createRelay } from '../src/relay/server.js'
import { TunnelRegistry } from '../src/relay/tunnels.js'
import type { K8sObject, K8sPodLookup } from '../src/relay/k8s-pod-lookup.js'
import type { AgentGrants, ConnectionGrantInput, ContainerConfig, EffectiveCredentials, OneCliAgent, OneCliClient, OneCliConnection, OneCliSecret } from '../src/onecli/client.js'

const VALID_BEARER = 'aoc_valid-bearer-token'

/** A fake OneCLI gateway: 200s a CONNECT with the right Basic credential and echoes tunneled bytes back (findings §3.2 — a real request through the tunnel, not just the CONNECT status line); 403s anything else. */
function startFakeGateway(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let buffered = ''
      const onData = (chunk: Buffer): void => {
        buffered += chunk.toString('utf8')
        const headerEnd = buffered.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        socket.removeListener('data', onData)
        const expectedAuth = `Basic ${Buffer.from(`x:${VALID_BEARER}`).toString('base64')}`
        if (buffered.includes(`Proxy-Authorization: ${expectedAuth}`)) {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          socket.on('data', (echoChunk: Buffer) => socket.write(echoChunk)) // echo — proves real bytes flow both ways
        } else {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.end()
        }
      }
      socket.on('data', onData)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

class FakePodLookup implements K8sPodLookup {
  constructor(private readonly pods: Record<string, K8sObject>) {}
  async findByPodIP(ip: string): Promise<K8sObject | undefined> {
    return this.pods[ip]
  }
}

function pod(workstreamId: string, incarnation: string): K8sObject {
  return { metadata: { labels: { 'agora.dev/workstream': workstreamId, 'agora.dev/incarnation': incarnation } } }
}

class FakeOneCliClient implements OneCliClient {
  constructor(private readonly effective: EffectiveCredentials) {}
  async listAgents(): Promise<readonly OneCliAgent[]> {
    return []
  }
  async createAgent(): Promise<{ id: string; name: string; identifier: string; createdAt: string }> {
    throw new Error('not exercised')
  }
  async deleteAgent(): Promise<void> {}
  async getAgentGrants(): Promise<AgentGrants> {
    throw new Error('not exercised')
  }
  async getEffectiveCredentials(): Promise<EffectiveCredentials> {
    return this.effective
  }
  async setAgentSecretGrant(): Promise<AgentGrants> {
    throw new Error('not exercised')
  }
  async removeAgentSecretGrant(): Promise<void> {}
  async setAgentConnectionGrant(_agentId: string, _connectionId: string, _grant: ConnectionGrantInput): Promise<AgentGrants> {
    throw new Error('not exercised')
  }
  async removeAgentConnectionGrant(): Promise<void> {}
  async listSecrets(): Promise<readonly OneCliSecret[]> {
    return []
  }
  async listConnections(): Promise<readonly OneCliConnection[]> {
    return []
  }
  async getContainerConfig(): Promise<ContainerConfig> {
    throw new Error('not exercised')
  }
}

const egressHosts = { hostsFor: () => [] }

async function readOneChunk(socket: import('node:net').Socket): Promise<string> {
  return new Promise((resolve) => socket.once('data', (c: Buffer) => resolve(c.toString('utf8'))))
}

test('relay: an allowed host completes the CONNECT and pipes real bytes both ways through the authenticated hop', async () => {
  const gateway = await startFakeGateway()
  const privateStore = new EncryptedPrivateStore('test-key')
  privateStore.put('inc-1', VALID_BEARER)
  const tunnels = new TunnelRegistry()
  const relay = createRelay({
    podLookup: new FakePodLookup({ '127.0.0.1': pod('w1', 'inc-1') }),
    client: new FakeOneCliClient({ agentId: 'a1', mode: 'selective', secrets: [{ kind: 'secret', id: 's1', host: 'api.anthropic.com', status: 'usable' }], connections: [] }),
    privateStore,
    egressHosts,
    tunnels,
    gatewayHost: '127.0.0.1',
    gatewayPort: gateway.port,
    boundAgentFor: async () => 'a1',
  })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  const relayPort = (relay.address() as { port: number }).port
  try {
    const client = connectTcp(relayPort, '127.0.0.1')
    await new Promise<void>((resolve) => client.on('connect', resolve))
    client.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n')
    const status = await readOneChunk(client)
    assert.match(status, /^HTTP\/1\.1 200/)
    client.write('hello upstream')
    const echoed = await readOneChunk(client)
    assert.equal(echoed, 'hello upstream', 'a real request went through the tunnel and came back — not just a 200 on the CONNECT line')
    assert.equal(tunnels.openCountFor('inc-1'), 1)
    client.destroy()
  } finally {
    relay.close()
    gateway.server.close()
  }
})

test('relay: a host no usable credential projects to is refused with 403 before any upstream socket opens', async () => {
  const gateway = await startFakeGateway()
  const privateStore = new EncryptedPrivateStore('test-key')
  privateStore.put('inc-1', VALID_BEARER)
  const relay = createRelay({
    podLookup: new FakePodLookup({ '127.0.0.1': pod('w1', 'inc-1') }),
    client: new FakeOneCliClient({ agentId: 'a1', mode: 'selective', secrets: [], connections: [] }),
    privateStore,
    egressHosts,
    tunnels: new TunnelRegistry(),
    gatewayHost: '127.0.0.1',
    gatewayPort: gateway.port,
    boundAgentFor: async () => 'a1',
  })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  const relayPort = (relay.address() as { port: number }).port
  try {
    const client = connectTcp(relayPort, '127.0.0.1')
    await new Promise<void>((resolve) => client.on('connect', resolve))
    client.write('CONNECT evil.example.com:443 HTTP/1.1\r\nHost: evil.example.com:443\r\n\r\n')
    const status = await readOneChunk(client)
    assert.match(status, /^HTTP\/1\.1 403/)
  } finally {
    relay.close()
    gateway.server.close()
  }
})

test('relay: an unrecognized source IP (no matching Pod) is refused with 407', async () => {
  const gateway = await startFakeGateway()
  const relay = createRelay({
    podLookup: new FakePodLookup({}),
    client: new FakeOneCliClient({ agentId: 'a1', mode: 'selective', secrets: [], connections: [] }),
    privateStore: new EncryptedPrivateStore('test-key'),
    egressHosts,
    tunnels: new TunnelRegistry(),
    gatewayHost: '127.0.0.1',
    gatewayPort: gateway.port,
    boundAgentFor: async () => 'a1',
  })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  const relayPort = (relay.address() as { port: number }).port
  try {
    const client = connectTcp(relayPort, '127.0.0.1')
    await new Promise<void>((resolve) => client.on('connect', resolve))
    client.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n')
    const status = await readOneChunk(client)
    assert.match(status, /^HTTP\/1\.1 407/)
  } finally {
    relay.close()
    gateway.server.close()
  }
})

test('a Bearer-authenticated CONNECT to the fake gateway is rejected (regression: the real gateway silently downgrades to unauthenticated on Bearer, findings §3.2 — Basic is the only correct scheme)', async () => {
  const gateway = await startFakeGateway()
  try {
    const client = connectTcp(gateway.port, '127.0.0.1')
    await new Promise<void>((resolve) => client.on('connect', resolve))
    client.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nProxy-Authorization: Bearer ${VALID_BEARER}\r\n\r\n`)
    const status = await readOneChunk(client)
    assert.match(status, /^HTTP\/1\.1 403/)
    client.destroy()
  } finally {
    gateway.server.close()
  }
})

test('terminating an incarnation\'s tunnels actually closes the open socket (REVOKE, findings §3.2: audit rows are not enforcement)', async () => {
  const gateway = await startFakeGateway()
  const privateStore = new EncryptedPrivateStore('test-key')
  privateStore.put('inc-1', VALID_BEARER)
  const tunnels = new TunnelRegistry()
  const relay = createRelay({
    podLookup: new FakePodLookup({ '127.0.0.1': pod('w1', 'inc-1') }),
    client: new FakeOneCliClient({ agentId: 'a1', mode: 'selective', secrets: [{ kind: 'secret', id: 's1', host: 'api.anthropic.com', status: 'usable' }], connections: [] }),
    privateStore,
    egressHosts,
    tunnels,
    gatewayHost: '127.0.0.1',
    gatewayPort: gateway.port,
    boundAgentFor: async () => 'a1',
  })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  const relayPort = (relay.address() as { port: number }).port
  try {
    const client = connectTcp(relayPort, '127.0.0.1')
    await new Promise<void>((resolve) => client.on('connect', resolve))
    client.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n')
    await readOneChunk(client)
    assert.equal(tunnels.openCountFor('inc-1'), 1)
    const closed = new Promise<void>((resolve) => client.on('close', resolve))
    tunnels.terminateAll('inc-1')
    await closed
    assert.equal(tunnels.openCountFor('inc-1'), 0)
  } finally {
    relay.close()
    gateway.server.close()
  }
})
