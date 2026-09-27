// The image contract (sandbox-image.md), exercised against the real bridge and the mock agent.
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { mintBridgeToken } from '../src/shared/token.ts'
import { Collector, keys, mockBridge, type LabBridge } from './helpers.ts'

const { privateKey, publicKey } = keys()
const running: LabBridge[] = []
after(async () => {
  for (const lab of running) await lab.bridge.close()
})

async function lab(podName = 'sbx-test'): Promise<LabBridge> {
  const started = await mockBridge(publicKey, podName)
  running.push(started)
  return started
}

function auth(podName = 'sbx-test'): Record<string, string> {
  return { authorization: `Bearer ${mintBridgeToken(privateKey, podName)}` }
}

async function connect(target: LabBridge, query = '', podName = 'sbx-test'): Promise<Collector> {
  const client = new Collector(`ws://${target.url}/acp${query}`, auth(podName))
  await client.opened()
  await client.until(() => client.messages.find((m) => 'hello' in m))
  return client
}

async function newSession(client: Collector, target: LabBridge, id = 1): Promise<string> {
  client.send({ jsonrpc: '2.0', id, method: 'session/new', params: { cwd: target.workspace, mcpServers: [] } })
  const response = await client.response(id)
  return (response.result as { sessionId: string }).sessionId
}

describe('bridge', () => {
  it('is ready only once initialize answered, and keeps that answer for itself', async () => {
    const target = await lab()
    const health = await fetch(`http://${target.url}/healthz`)
    assert.equal(health.status, 200)
    const info = (await (await fetch(`http://${target.url}/info`, { headers: auth() })).json()) as Record<string, unknown>
    assert.equal((info.initialize as { agentInfo: { name: string } }).agentInfo.name, 'agora-mock-agent')
    assert.equal(info.lastSeq, 0, 'the initialize answer is not relayed')
  })

  it('refuses a missing, expired, foreign or forged token', async () => {
    const target = await lab()
    const other = keys()
    const cases: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${mintBridgeToken(privateKey, 'sbx-test', { now: Date.now() - 120_000 })}` },
      { authorization: `Bearer ${mintBridgeToken(privateKey, 'sbx-autre')}` },
      { authorization: `Bearer ${mintBridgeToken(other.privateKey, 'sbx-test')}` },
    ]
    for (const headers of cases) {
      assert.equal((await fetch(`http://${target.url}/info`, { headers })).status, 401)
      const client = new Collector(`ws://${target.url}/acp`, headers)
      await assert.rejects(client.opened(), /HTTP 401/)
    }
  })

  it('numbers every line, relays a full turn, and never lets two clients share the adapter', async () => {
    const target = await lab()
    const first = await connect(target)
    const sessionId = await newSession(first, target)
    const second = await connect(target)
    await first.until(() => first.closed)
    assert.equal(first.closed?.code, 4000)

    second.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'bonjour' }] } })
    const done = await second.response(2)
    assert.deepEqual(done.result, { stopReason: 'end_turn' })
    const seqs = second.messages.filter((m) => typeof m.seq === 'number').map((m) => m.seq as number)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
    assert.equal(new Set(seqs).size, seqs.length)
  })

  it('keeps what the adapter says while nobody listens, and replays it after the given position', async () => {
    const target = await lab()
    const client = await connect(target)
    const sessionId = await newSession(client, target)
    const before = Math.max(...client.messages.filter((m) => typeof m.seq === 'number').map((m) => m.seq as number))
    client.send({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '/sleep 2' }] } })
    client.close()
    await new Promise((resolve) => setTimeout(resolve, 2600))

    const back = await connect(target, `?after=${String(before)}`)
    const hello = back.messages[0]!.hello as { gap: boolean; replayFrom: number }
    assert.equal(hello.gap, false)
    assert.equal(hello.replayFrom, before + 1)
    const done = await back.response(7)
    assert.deepEqual(done.result, { stopReason: 'end_turn' })
  })

  it('says so when the lines asked for are already gone', async () => {
    const { startBridge } = await import('../src/bridge/server.ts')
    const { mockLayout } = await import('../src/shared/transcript.ts')
    const { MOCK_AGENT } = await import('./helpers.ts')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = mkdtempSync(join(tmpdir(), 'bridge-'))
    const workspace = join(home, 'work')
    const bridge = await startBridge({
      port: 0,
      host: '127.0.0.1',
      adapterCommand: ['env', `HOME=${home}`, process.execPath, MOCK_AGENT],
      workspace,
      podName: 'sbx-test',
      publicKey,
      layout: mockLayout(home, workspace),
      ringLines: 5,
      log: () => {},
    })
    running.push({ bridge, home, workspace, url: `127.0.0.1:${String(bridge.port())}` })
    const target = running.at(-1)!
    const client = await connect(target)
    const sessionId = await newSession(client, target)
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '/big 20' }] } })
    await client.response(3)
    client.close()
    const back = await connect(target, '?after=0')
    assert.equal((back.messages[0]!.hello as { gap: boolean }).gap, true)
  })

  it('captures the native transcript and restores it into another sandbox, which then remembers', async () => {
    const source = await lab('sbx-source')
    const client = await connect(source, '', 'sbx-source')
    const sessionId = await newSession(client, source)
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'mirabelle' }] } })
    await client.response(2)

    assert.equal((await fetch(`http://${source.url}/anchor?sessionId=inconnue`, { headers: auth('sbx-source') })).status, 404)
    const capture = await fetch(`http://${source.url}/anchor?sessionId=${sessionId}`, { headers: auth('sbx-source') })
    assert.equal(capture.status, 200)
    assert.equal(capture.headers.get('x-anchor-session'), sessionId)
    const bytes = new Uint8Array(await capture.arrayBuffer())

    const target = await lab('sbx-cible')
    const placed = await fetch(`http://${target.url}/anchor`, { method: 'PUT', body: bytes, headers: auth('sbx-cible') })
    assert.equal(placed.status, 200)
    assert.equal(((await placed.json()) as { sessionId: string }).sessionId, sessionId)

    const resumed = await connect(target, '', 'sbx-cible')
    resumed.send({ jsonrpc: '2.0', id: 1, method: 'session/resume', params: { sessionId, cwd: target.workspace } })
    assert.deepEqual((await resumed.response(1)).result, {})
    resumed.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '/recall' }] } })
    await resumed.response(2)
    assert.ok(resumed.acp().some((m) => JSON.stringify(m).includes('mirabelle')))
  })

  it('stays up when the adapter dies, so the anchor can still be taken', async () => {
    const target = await lab()
    const client = await connect(target)
    const sessionId = await newSession(client, target)
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'avant la chute' }] } })
    await client.response(2)
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '/crash' }] } })
    await client.until(() => client.closed)
    assert.equal(client.closed?.code, 1011)

    assert.equal((await fetch(`http://${target.url}/healthz`)).status, 503)
    const info = (await (await fetch(`http://${target.url}/info`, { headers: auth() })).json()) as { adapter: { alive: boolean; exitCode: number } }
    assert.deepEqual(info.adapter, { alive: false, exitCode: 3, signal: null })
    const capture = await fetch(`http://${target.url}/anchor?sessionId=${sessionId}`, { headers: auth() })
    assert.equal(capture.status, 200)
    assert.match(await capture.text(), /avant la chute/)
  })
})
