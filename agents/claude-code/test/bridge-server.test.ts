import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import { WebSocket, createWebSocketStream } from 'ws'
import { harnessEnv, startBridgeServer } from '../src/bridge-server.js'
import { nativeTranscriptPath } from '../src/custody.js'

const stubAgentPath = fileURLToPath(new URL('./fixtures/stub-acp-agent.js', import.meta.url))

/**
 * `process.execPath`, never the bare name `'node'`: these tests deliberately spawn the stub Agent
 * with `childEnv: {}` (proving the bridge passes only what it is told), and an empty child
 * environment has no PATH, so `execvp` falls back to the system default `/bin:/usr/bin`. That
 * happens to contain a developer's node and does NOT contain a GitHub runner's, which keeps node in
 * the tool cache — so `spawn node` failed with ENOENT in CI while the same suite stayed green
 * locally. Spawning this very interpreter by absolute path removes the PATH dependency entirely
 * without weakening what the test asserts.
 */
const nodeBinary = process.execPath

async function scratchHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-server-test-'))
  return dir
}

async function connectClient(port: number): Promise<{ agentConnection: ReturnType<ReturnType<typeof acp.client>['connect']>; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const duplex = createWebSocketStream(ws)
  const { readable, writable } = Duplex.toWeb(duplex)
  const wire = acp.ndJsonStream(writable as WritableStream<Uint8Array>, readable as ReadableStream<Uint8Array>)
  const clientApp = acp.client({ name: 'agora-bridge-server-test' })
  const agentConnection = clientApp.connect(wire)
  return { agentConnection, close: () => ws.close() }
}

async function fetchText(port: number, path: string): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, body: await res.text(), headers: res.headers }
}

test('required: /healthz is reachable once the Agent process is up', async () => {
  const running = await startBridgeServer({ homeDir: await scratchHome(), agentCommand: [nodeBinary, stubAgentPath], childEnv: {} })
  try {
    const health = await fetchText(running.port, '/healthz')
    assert.equal(health.status, 200)
  } finally {
    await running.close()
  }
})

test('/custody is a clean 404 before any ACP session has ever opened on this Pod', async () => {
  const running = await startBridgeServer({ homeDir: await scratchHome(), agentCommand: [nodeBinary, stubAgentPath], childEnv: {} })
  try {
    const res = await fetchText(running.port, '/custody')
    assert.equal(res.status, 404)
  } finally {
    await running.close()
  }
})

test('required: a WS connection whose Agent process cannot start fails closed, never hangs', async () => {
  // The Agent process is now spawned lazily, per connection (see bridge-server.ts's own doc
  // comment for why) — `startBridgeServer` itself always succeeds; a broken `agentCommand` only
  // ever surfaces when a real connection tries to use it, and must close cleanly, not hang.
  const homeDir = await scratchHome()
  const running = await startBridgeServer({ homeDir, agentCommand: ['/no/such/binary'], childEnv: {} })
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${running.port}/`)
    // The WS handshake itself completes fine (it's the server's connection handler, spawning the
    // Agent process afterwards, that fails) — so 'open' firing is expected here. What must hold is
    // that the connection is then force-closed rather than left open with a dead child.
    const closeEvent = await new Promise<{ code: number }>((resolve, reject) => {
      ws.once('close', (code) => resolve({ code }))
      ws.once('error', () => {
        /* a raw socket error is an acceptable alternate signal here; 'close' still follows */
      })
      setTimeout(() => reject(new Error('connection never closed for a broken agentCommand')), 5000)
    })
    assert.ok(closeEvent.code)
  } finally {
    await running.close()
  }
})

test('required: a real WS session/new round-trips through the bridge to the Agent process and back', async () => {
  const running = await startBridgeServer({ homeDir: await scratchHome(), agentCommand: [nodeBinary, stubAgentPath], childEnv: {} })
  const client = await connectClient(running.port)
  try {
    const init = await client.agentConnection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    assert.equal(init.protocolVersion, acp.PROTOCOL_VERSION)
    const session = await client.agentConnection.agent.request(acp.methods.agent.session.new, { cwd: '/home/node/work', mcpServers: [] })
    assert.ok(session.sessionId)
  } finally {
    client.close()
    await running.close()
  }
})

test('required: /custody becomes available after session/new, keyed to the real ACP sessionId observed over the wire', async () => {
  const homeDir = await scratchHome()
  const running = await startBridgeServer({ homeDir, agentCommand: [nodeBinary, stubAgentPath], childEnv: {} })
  const client = await connectClient(running.port)
  try {
    await client.agentConnection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const session = await client.agentConnection.agent.request(acp.methods.agent.session.new, { cwd: '/home/node/work', mcpServers: [] })

    // The stub Agent (unlike real Claude Code) never writes a transcript file itself — seed one at
    // exactly the path a real harness would have written, under the sessionId the bridge's own
    // session-id tap observed from the real WS traffic. This tests the bridge's wiring end to end;
    // custody.test.ts already proves the file-format/content logic in isolation.
    const path = nativeTranscriptPath(homeDir, session.sessionId)
    await mkdir(join(homeDir, '.claude/projects/-home-node-work'), { recursive: true })
    const content = `${JSON.stringify({ type: 'summary', sessionId: session.sessionId })}\n`
    await writeFile(path, content)

    const res = await fetchText(running.port, '/custody')
    assert.equal(res.status, 200)
    assert.equal(res.body, content)
    assert.equal(res.headers.get('x-agora-native-session-id'), session.sessionId)
    assert.equal(res.headers.get('x-agora-sha256'), createHash('sha256').update(content).digest('hex'))
  } finally {
    client.close()
    await running.close()
  }
})

test('required: restore-before-ready seeds the transcript and binds /custody before any WS connection exists', async () => {
  const homeDir = await scratchHome()
  const sessionId = randomUUID()
  const content = `${JSON.stringify({ type: 'summary', sessionId })}\n`
  const bytes = Buffer.from(content)

  const restoreServer = createHttpServer((req, res) => {
    if (req.headers.authorization !== 'Bearer restore-cred-1') {
      res.writeHead(403).end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'x-agora-format-id': 'claude-code-transcript-v1',
      'x-agora-format-version': '1',
      'x-agora-sha256': createHash('sha256').update(bytes).digest('hex'),
    })
    res.end(bytes)
  })
  await new Promise<void>((resolve) => restoreServer.listen(0, '127.0.0.1', resolve))
  const restorePort = (restoreServer.address() as AddressInfo).port

  const running = await startBridgeServer({
    homeDir,
    agentCommand: [nodeBinary, stubAgentPath],
    childEnv: {},
    restore: { url: `http://127.0.0.1:${restorePort}/`, credential: 'restore-cred-1' },
  })
  try {
    const res = await fetchText(running.port, '/custody')
    assert.equal(res.status, 200, 'custody must be servable from restored state alone, before any WS connection')
    assert.equal(res.body, content)
    assert.equal(res.headers.get('x-agora-native-session-id'), sessionId)
  } finally {
    await running.close()
    await new Promise<void>((resolve) => restoreServer.close(() => resolve()))
  }
})

test('required: a checksum mismatch on the restore stream fails the whole startup, never opens for readiness', async () => {
  const homeDir = await scratchHome()
  const content = Buffer.from(`${JSON.stringify({ type: 'summary', sessionId: randomUUID() })}\n`)
  const restoreServer = createHttpServer((_req, res) => {
    res.writeHead(200, { 'x-agora-sha256': 'not-the-real-checksum' })
    res.end(content)
  })
  await new Promise<void>((resolve) => restoreServer.listen(0, '127.0.0.1', resolve))
  const restorePort = (restoreServer.address() as AddressInfo).port

  try {
    await assert.rejects(() =>
      startBridgeServer({
        homeDir,
        agentCommand: [nodeBinary, stubAgentPath],
        childEnv: {},
        restore: { url: `http://127.0.0.1:${restorePort}/`, credential: 'x' },
      }),
    )
  } finally {
    await new Promise<void>((resolve) => restoreServer.close(() => resolve()))
  }
})

test('required: the one-time custody restore credential never reaches the harness', () => {
  const scrubbed = harnessEnv({
    PATH: '/usr/bin',
    AGORA_WORKSPACE_ROOT: '/home/node/work',
    AGORA_CUSTODY_RESTORE_URL: 'https://controller/custody/stream',
    AGORA_CUSTODY_RESTORE_CREDENTIAL: 'one-time-bearer-value',
  })
  assert.equal(scrubbed['AGORA_CUSTODY_RESTORE_CREDENTIAL'], undefined, 'a bearer the harness never needs must not be in its environment')
  assert.equal(scrubbed['AGORA_CUSTODY_RESTORE_URL'], undefined)
  assert.equal(scrubbed['AGORA_WORKSPACE_ROOT'], '/home/node/work', 'everything the harness does need survives')
  assert.equal(scrubbed['PATH'], '/usr/bin')
})
