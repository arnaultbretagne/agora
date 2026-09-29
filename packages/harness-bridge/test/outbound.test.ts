// The way out (docs/specs/credentials.md): the adapter goes through the bridge's outbound proxy, which
// holds no credential until Agora hands it one, then forwards each CONNECT with it.
import assert from 'node:assert/strict'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { after, describe, it } from 'node:test'
import { mintBridgeToken } from '../src/token.ts'
import { startOutbound } from '../src/outbound.ts'
import { Collector, keys, mockBridge, type LabBridge } from '@agora/testkit'

const { privateKey, publicKey } = keys()
const cleanups: (() => Promise<void> | void)[] = []
after(async () => {
  for (const cleanup of cleanups) await cleanup()
})

function auth(podName = 'sbx-test'): Record<string, string> {
  return { authorization: `Bearer ${mintBridgeToken(privateKey, podName)}` }
}

/** A stand-in for the credential proxy: keeps each CONNECT head, then answers with `reply`. */
async function upstreamProxy(reply: (socket: Socket, head: string) => void): Promise<{ address: string; heads: string[] }> {
  const heads: string[] = []
  const server: Server = createServer((socket) => {
    let buffered = ''
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('latin1')
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onData)
      const head = buffered.slice(0, end)
      heads.push(head)
      reply(socket, head)
    }
    socket.on('data', onData)
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { address: `127.0.0.1:${String((server.address() as { port: number }).port)}`, heads }
}

async function lab(): Promise<LabBridge> {
  const started = await mockBridge(publicKey)
  cleanups.push(() => started.bridge.close())
  return started
}

async function ask(target: LabBridge, text: string): Promise<string> {
  const client = new Collector(`ws://${target.url}/acp`, auth())
  await client.opened()
  client.send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: target.workspace, mcpServers: [] } })
  const sessionId = ((await client.response(1)).result as { sessionId: string }).sessionId
  client.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } })
  await client.response(2)
  client.socket.close()
  return client
    .acp()
    .map((m) => (m.params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined)?.update)
    .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
    .map((u) => u?.content?.text ?? '')
    .join('')
}

async function putCredentials(target: LabBridge, body: unknown, headers = auth()): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://${target.url}/credentials`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('outbound proxy', () => {
  it('refuses to open anything before a credential is attached', async () => {
    const target = await lab()
    assert.match(await ask(target, '/fetch https://api.example.test/v1/models'), /CONNECT api\.example\.test:443 refused by the proxy: 503/)
    const info = (await (await fetch(`http://${target.url}/info`, { headers: auth() })).json()) as { outbound: { proxy: unknown; refused: number } }
    assert.equal(info.outbound.proxy, null)
    assert.equal(info.outbound.refused, 1)
  })

  it('takes a credential only with Agora’s token and a well-formed body, and never shows the token', async () => {
    const target = await lab()
    assert.equal((await putCredentials(target, { proxy: 'vault:14322', token: 'secret' }, {})).status, 401)
    assert.equal((await putCredentials(target, { proxy: 'vault', token: 'secret' })).status, 400)
    assert.equal((await putCredentials(target, { proxy: 'vault:14322', token: '' })).status, 400)
    const accepted = await putCredentials(target, { proxy: 'vault:14322', token: 'secret', expiresAt: '2030-01-01T00:00:00Z' })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.proxy, 'vault:14322')
    const info = await (await fetch(`http://${target.url}/info`, { headers: auth() })).text()
    assert.ok(info.includes('vault:14322') && info.includes('2030-01-01T00:00:00Z'))
    assert.ok(!info.includes('secret'), 'the token never leaves the bridge')
  })

  it('forwards the adapter’s CONNECT with the token, and hands back the proxy’s answer', async () => {
    const target = await lab()
    const vault = await upstreamProxy((socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'))
    assert.equal((await putCredentials(target, { proxy: vault.address, token: 'session-token' })).status, 200)
    assert.match(await ask(target, '/fetch https://api.example.test/v1/models'), /refused by the proxy: 403/)
    assert.equal(vault.heads.length, 1)
    assert.match(vault.heads[0] ?? '', /^CONNECT api\.example\.test:443 HTTP\/1\.1\r\n/)
    assert.match(vault.heads[0] ?? '', /\r\nProxy-Authorization: Bearer session-token(\r\n|$)/)
    const info = (await (await fetch(`http://${target.url}/info`, { headers: auth() })).json()) as { outbound: { tunnels: number; targets: Record<string, { count: number; lastStatus: number }> } }
    assert.equal(info.outbound.tunnels, 1)
    assert.deepEqual(info.outbound.targets['api.example.test:443'], { count: 1, lastStatus: 403 })
  })

  it('once the proxy says 200, carries bytes both ways untouched; a new credential applies to the next tunnel', async () => {
    const vault = await upstreamProxy((socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.pipe(socket)
    })
    const outbound = await startOutbound({ log: () => {} })
    cleanups.push(() => outbound.close())
    const port = Number(new URL(outbound.url).port)

    async function tunnel(payload: string): Promise<string> {
      const socket = connect(port, '127.0.0.1')
      socket.write('CONNECT api.example.test:443 HTTP/1.1\r\nHost: api.example.test:443\r\n\r\n')
      let received = ''
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1')
        if (received.endsWith('\r\n\r\n') && received.startsWith('HTTP/1.1 200')) socket.write(payload)
      })
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (received.endsWith(payload)) {
            clearInterval(check)
            resolve()
          }
        }, 10)
      })
      socket.destroy()
      return received
    }

    outbound.set({ proxy: vault.address, token: 'premier', expiresAt: null })
    assert.match(await tunnel('ping-1'), /^HTTP\/1\.1 200 Connection Established\r\n\r\nping-1$/)
    outbound.set({ proxy: vault.address, token: 'second', expiresAt: null })
    await tunnel('ping-2')
    assert.match(vault.heads[0] ?? '', /Bearer premier/)
    assert.match(vault.heads[1] ?? '', /Bearer second/)
  })

  it('answers 502 when the credential proxy cannot be reached', async () => {
    const target = await lab()
    assert.equal((await putCredentials(target, { proxy: '127.0.0.1:1', token: 'token' })).status, 200)
    assert.match(await ask(target, '/fetch https://api.example.test/'), /refused by the proxy: 502/)
  })
})
