// The image contract (docs/specs/executions.md), exercised against the real bridge and the mock agent.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { mintBridgeToken } from '../src/token.ts'
import { pushBundle, type Bundle } from '../src/anchor.ts'
import { Collector, keys, mockBridge, type LabBridge } from '@agora/testkit'

const { privateKey, publicKey } = keys()
const running: LabBridge[] = []
after(async () => {
  for (const lab of running) await lab.bridge.close()
})

async function lab(podName = 'sbx-test', options: { ringLines?: number } = {}): Promise<LabBridge> {
  const started = await mockBridge(publicKey, podName, options)
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

async function say(client: Collector, id: number, sessionId: string, text: string): Promise<Record<string, unknown>> {
  client.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } })
  return client.response(id)
}

describe('bridge', () => {
  it('is ready only once initialize answered, and keeps that answer for itself', async () => {
    const target = await lab()
    assert.equal((await fetch(`http://${target.url}/healthz`)).status, 200)
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
    assert.deepEqual((await say(second, 2, sessionId, 'hello')).result, { stopReason: 'end_turn' })
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
    assert.deepEqual((await back.response(7)).result, { stopReason: 'end_turn' })
  })

  it('says so when the lines asked for are already gone', async () => {
    const target = await lab('sbx-test', { ringLines: 5 })
    const client = await connect(target)
    const sessionId = await newSession(client, target)
    await say(client, 3, sessionId, '/big 20')
    client.close()
    const back = await connect(target, '?after=0')
    assert.equal((back.messages[0]!.hello as { gap: boolean }).gap, true)
  })

  it('at the end of the Pod: closes the relay, stops the adapter, hands back the native files en bloc', async () => {
    const target = await lab()
    const client = await connect(target)
    const first = await newSession(client, target)
    await say(client, 2, first, 'mirabelle')
    const second = await newSession(client, target, 3)
    await say(client, 4, second, 'quetsche')

    const bundle = await target.bridge.terminate()
    await client.until(() => client.closed)
    assert.ok(client.messages.some((m) => 'terminating' in m))
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
    const sessionId = await newSession(client, source)
    await say(client, 2, sessionId, 'mirabelle')
    const bundle = await source.bridge.terminate()

    const target = await lab('sbx-target')
    const forged = { ...bundle, files: [{ ...bundle.files[0]!, path: '../../evasion.jsonl' }] }
    assert.equal((await fetch(`http://${target.url}/anchor`, { method: 'PUT', body: JSON.stringify(forged), headers: auth('sbx-target') })).status, 409)
    const placed = await fetch(`http://${target.url}/anchor`, { method: 'PUT', body: JSON.stringify(bundle), headers: auth('sbx-target') })
    assert.equal(placed.status, 200)

    const resumed = await connect(target, '', 'sbx-target')
    resumed.send({ jsonrpc: '2.0', id: 1, method: 'session/resume', params: { sessionId, cwd: target.workspace } })
    assert.deepEqual((await resumed.response(1)).result, {})
    await say(resumed, 2, sessionId, '/recall')
    assert.ok(resumed.acp().some((message) => JSON.stringify(message).includes('mirabelle')))
  })

  it('stays up when the adapter dies, and still hands back the files at the end', async () => {
    const target = await lab()
    const client = await connect(target)
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
