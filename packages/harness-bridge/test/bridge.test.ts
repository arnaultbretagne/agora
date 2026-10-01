// The image contract (docs/specs/executions.md), exercised against the real bridge and the mock agent.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridge, MAX_LINE_BYTES } from '../src/server.ts'
import { after, describe, it } from 'node:test'
import { mintBridgeToken } from '../src/token.ts'
import { pushBundle, type Bundle } from '../src/anchor.ts'
import { Collector, keys, mockBridge, type LabBridge } from '@agora/testkit'

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
  assert.equal(client.instance, target.bridge.instance)
  return client
}

async function initialize(client: Collector): Promise<void> {
  client.send({ jsonrpc: '2.0', id: 'agora-init', method: 'initialize', params: { protocolVersion: 1 } })
  assert.equal(((await client.response('agora-init')).result as { agentInfo: { name: string } }).agentInfo.name, 'agora-mock-agent')
}

async function newSession(client: Collector, target: LabBridge, id = 1): Promise<string> {
  client.send({ jsonrpc: '2.0', id, method: 'session/new', params: { cwd: target.workspace, mcpServers: [] } })
  const response = await client.response(id)
  return (response.result as { sessionId: string }).sessionId
}

async function say(client: Collector, id: number, sessionId: string, text: string): Promise<Record<string, unknown>> {
  client.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } })
  return client.response(id)
}

async function stdio(mode: string): Promise<LabBridge> {
  const home = mkdtempSync(join(tmpdir(), 'stdio-bridge-'))
  const bridge = await startBridge({
    port: 0, host: '127.0.0.1',
    adapterCommand: [process.execPath, fileURLToPath(new URL('./stdio-adapter.ts', import.meta.url)), mode, home],
    workspace: home, podName: 'sbx-test', publicKey, harness: 'mock', nativeDir: join(home, 'native'), log: () => {},
  })
  const target = { bridge, home, workspace: home, url: `127.0.0.1:${String(bridge.port())}` }
  running.push(target)
  return target
}

describe('bridge', () => {
  it('is ready while the adapter runs, sends no ACP and carries the instance only in the upgrade header', async () => {
    const target = await lab()
    assert.equal((await fetch(`http://${target.url}/healthz`)).status, 200)
    const info = (await (await fetch(`http://${target.url}/info`, { headers: auth() })).json()) as Record<string, unknown>
    assert.equal(info.instance, target.bridge.instance)
    for (const removed of ['initialize', 'initializeError', 'lastSeq', 'firstRetainedSeq']) assert.ok(!(removed in info))
    const client = await connect(target)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(client.raw, [], 'nothing is sent before Agora writes ACP')
    await initialize(client) // the mock rejects any second initialize, including one sent by the bridge
    assert.deepEqual(client.binary, [false])
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

  it('relays raw lines for a full turn and never lets two clients share the adapter', async () => {
    const target = await lab()
    const first = await connect(target)
    await initialize(first)
    const sessionId = await newSession(first, target)
    const second = await connect(target)
    await first.until(() => first.closed)
    assert.equal(first.closed?.code, 4000)
    assert.deepEqual((await say(second, 2, sessionId, 'hello')).result, { stopReason: 'end_turn' })
    assert.ok(second.raw.every((line) => JSON.parse(line).jsonrpc === '2.0'))
    assert.ok(second.binary.every((binary) => !binary))
    assert.ok(second.messages.every((m) => !('seq' in m) && !('acp' in m) && !('hello' in m)))
  })

  it('E27: leaves disconnected output in the pipe, then delivers it in order without replay', async () => {
    const target = await lab()
    const client = await connect(target)
    await initialize(client)
    const sessionId = await newSession(client, target)
    client.send({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '/sleep 2' }] } })
    client.close()
    await client.until(() => client.closed)
    await new Promise((resolve) => setTimeout(resolve, 2300))
    const back = await connect(target)
    assert.deepEqual((await back.response(7)).result, { stopReason: 'end_turn' })
    const chunks = back.acp().filter((m) => m.method === 'session/update').map((m) => JSON.stringify(m))
    assert.equal(chunks.length, 3)
    assert.match(chunks[0]!, /second 1/)
    assert.match(chunks[1]!, /second 2/)
    assert.match(chunks[2]!, /Slept 2/)
    back.close()
    await back.until(() => back.closed)
    const again = await connect(target, '?after=0')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(again.raw, [], 'already delivered lines are never replayed')
  })

  it('preserves split UTF-8, whitespace, unknown metadata and large JSON numbers byte for byte', async () => {
    const target = await stdio('split')
    const client = await connect(target)
    await client.until(() => client.raw.length === 2)
    assert.deepEqual(client.raw, ['  {"jsonrpc":"2.0","id":9007199254740993,"_meta":{"text":"été ☃"}}  ', 'second'])
    assert.deepEqual(client.binary, [false, false])
  })

  it('E27: blocks a disconnected writer, then delivers more than the former ring could retain in order', async () => {
    const target = await stdio('stream')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(existsSync(join(target.home, 'done')), false, 'the writer must block while Agora is away')
    const client = await connect(target)
    await client.until(() => client.raw.length === 20_000, 30_000)
    for (const [i, line] of client.raw.entries()) assert.equal(line, `${String(i)} ${'x'.repeat(1024)}`)
    await client.until(() => existsSync(join(target.home, 'done')))
  })

  it('pauses incoming messages when stdin is blocked and resumes them in order on drain', async () => {
    const target = await stdio('stdin')
    const client = await connect(target)
    const lines = Array.from({ length: 256 }, (_, i) => `${String(i)} ${'x'.repeat(64 * 1024)}`)
    for (const line of lines) client.socket.send(line)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok(client.socket.bufferedAmount > 0, 'pressure must reach the sending socket rather than accumulate in the bridge')
    assert.deepEqual(client.raw, [])
    writeFileSync(join(target.home, 'read'), 'read')
    await client.until(() => client.raw.length === lines.length, 20_000)
    assert.deepEqual(client.raw, lines)
  })

  it('stops the adapter when a line exceeds 16 MiB, even across many pipe reads', async () => {
    const target = await stdio('oversized')
    const client = await connect(target)
    await client.until(() => client.closed)
    assert.equal(client.closed?.code, 1011)
    assert.equal((await fetch(`http://${target.url}/healthz`)).status, 503)
    assert.deepEqual(client.raw, [])
  })

  it('stops the adapter when a client message exceeds the same ceiling', async () => {
    const target = await lab()
    const client = await connect(target)
    client.socket.send('x'.repeat(MAX_LINE_BYTES + 1))
    await client.until(() => client.closed)
    assert.equal(client.closed?.code, 1009)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await fetch(`http://${target.url}/healthz`)).status, 503)
  })

  it('at the end of the Pod: closes the relay, stops the adapter, hands back the native files en bloc', async () => {
    const target = await lab()
    const client = await connect(target)
    await initialize(client)
    const first = await newSession(client, target)
    await say(client, 2, first, 'mirabelle')
    const second = await newSession(client, target, 3)
    await say(client, 4, second, 'quetsche')

    const bundle = await target.bridge.terminate()
    await client.until(() => client.closed)
    assert.ok(client.messages.every((m) => !('terminating' in m)))
    assert.equal(client.closed?.reason, 'Pod ending')
    assert.equal(client.closed?.code, 1001)
    assert.equal((await fetch(`http://${target.url}/healthz`)).status, 503)
    const refused = new Collector(`ws://${target.url}/acp`, auth())
    await assert.rejects(refused.opened(), /HTTP 503/)
    const info = (await (await fetch(`http://${target.url}/info`, { headers: auth() })).json()) as { adapter: { alive: boolean } }
    assert.equal(info.adapter.alive, false)

    assert.equal(bundle.stable, true)
    assert.deepEqual(bundle.files.map((file) => file.path).sort(), [`${first}.jsonl`, `${second}.jsonl`].sort())
    const text = bundle.files.map((file) => Buffer.from(file.content, 'base64').toString('utf8')).join('')
    assert.match(text, /mirabelle/)
    assert.match(text, /quetsche/)
  })

  it('pushes that bundle with the projected token read at push time', async () => {
    const received: { token: string | undefined; bundle: Bundle }[] = []
    const receiver = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.push({ token: req.headers.authorization, bundle: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Bundle })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"accepted":true}')
      })
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    const tokenFile = join(mkdtempSync(join(tmpdir(), 'token-')), 'token')
    writeFileSync(tokenFile, 'projected-token\n')
    const bundle: Bundle = { format: 'agora-anchor/1', harness: 'mock', files: [], stable: true }
    assert.equal(await pushBundle(`http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/anchors`, tokenFile, bundle), true)
    receiver.close()
    assert.equal(received[0]?.token, 'Bearer projected-token')
    assert.deepEqual(received[0]?.bundle, bundle)
  })

  it('restores a bundle into another sandbox, which then remembers', async () => {
    const source = await lab('sbx-source')
    const client = await connect(source, '', 'sbx-source')
    await initialize(client)
    const sessionId = await newSession(client, source)
    await say(client, 2, sessionId, 'mirabelle')
    const bundle = await source.bridge.terminate()

    const target = await lab('sbx-target')
    const forged = { ...bundle, files: [{ ...bundle.files[0]!, path: '../../evasion.jsonl' }] }
    assert.equal((await fetch(`http://${target.url}/anchor`, { method: 'PUT', body: JSON.stringify(forged), headers: auth('sbx-target') })).status, 409)
    const placed = await fetch(`http://${target.url}/anchor`, { method: 'PUT', body: JSON.stringify(bundle), headers: auth('sbx-target') })
    assert.equal(placed.status, 200)

    const resumed = await connect(target, '', 'sbx-target')
    await initialize(resumed)
    resumed.send({ jsonrpc: '2.0', id: 1, method: 'session/resume', params: { sessionId, cwd: target.workspace } })
    assert.deepEqual((await resumed.response(1)).result, {})
    await say(resumed, 2, sessionId, '/recall')
    assert.ok(resumed.acp().some((message) => JSON.stringify(message).includes('mirabelle')))
  })

  it('stays up when the adapter dies, and still hands back the files at the end', async () => {
    const target = await lab()
    const client = await connect(target)
    await initialize(client)
    const sessionId = await newSession(client, target)
    await say(client, 2, sessionId, 'before the fall')
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '/crash' }] } })
    await client.until(() => client.closed)
    assert.equal(client.closed?.code, 1011)
    assert.equal((await fetch(`http://${target.url}/healthz`)).status, 503)
    const bundle = await target.bridge.terminate()
    assert.match(Buffer.from(bundle.files[0]!.content, 'base64').toString('utf8'), /before the fall/)
  })
})
