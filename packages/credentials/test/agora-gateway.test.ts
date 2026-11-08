// Agora's MCP server through the real gateway (docs/specs/credentials.md, "Agora's MCP"; docs/specs/mcp.md):
// agentgateway 1.6.0, its release binary checked against its sha256, on fixtures/agora-gateway.yaml; tokens signed by
// Agora's GrantSigner; the bridge's outbound proxy, which adds the token to each CONNECT; MCP messages sent as a
// harness sends them to the server `mcpServers` names; and a stand-in for Agora's port 8082, which records every
// message and the caller the gateway named.
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer as createNetServer, type Socket } from 'node:net'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { connect as tlsConnect } from 'node:tls'
import { after, before, describe, it } from 'node:test'
import { startOutbound, type Outbound } from '@agora/harness-bridge/outbound'
import { AGORA_MCP_HOST, GrantSigner, mcpServers } from '../src/index.ts'
import { fetchRelease } from './release.ts'

const RELEASE = 'https://github.com/agentgateway/agentgateway/releases/download/v1.6.0/agentgateway-linux-amd64'
const SHA256 = '496ed27e6a96b55a9ad7cabe5c2be7172511f44a3cb113e533d22bf93a7f079d'

let openssl = true
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' })
} catch {
  openssl = false
}
const skip = platform() !== 'linux' || arch() !== 'x64' ? 'the gateway binary is linux-amd64' : !openssl ? 'openssl is needed to make the gateway CA' : false

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** The release binary, downloaded once into the temporary directory, and checked before every run. */
async function agentgateway(): Promise<string> {
  const dir = join(tmpdir(), 'agora-agentgateway-1.6.0')
  const file = join(dir, 'agentgateway')
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    const response = await fetchRelease(RELEASE)
    const partial = `${file}.${randomUUID()}`
    await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(partial))
    renameSync(partial, file)
  }
  assert.equal(await sha256(file), SHA256, 'agentgateway 1.6.0, as released')
  chmodSync(file, 0o755)
  return file
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

interface Seen {
  readonly method: string
  readonly path: string
  readonly execution: string | undefined
  readonly body: string
}

/** A stand-in for Agora's port 8082: it records each message, and answers a JSON-RPC result. */
async function agora(): Promise<{ address: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const server: Server = createHttpServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      const execution = req.headers['x-agora-execution']
      seen.push({ method: req.method ?? '', path: req.url ?? '', execution: typeof execution === 'string' ? execution : undefined, body })
      const id = (JSON.parse(body || '{}') as { id?: unknown }).id ?? null
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { address: `127.0.0.1:${String(port)}`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

describe('Agora’s MCP server through agentgateway 1.6.0', { skip }, () => {
  let gateway: ChildProcess
  let output = ''
  let server: Awaited<ReturnType<typeof agora>>
  let outbound: Outbound
  let signer: GrantSigner
  let ca = ''

  /**
   * A message as a harness in a sandbox sends it, to the server `mcpServers` names for `agora:read`: through the
   * bridge's proxy, which holds a token for `profiles` bound to `address`; TLS to the host, the gateway's CA trusted.
   */
  async function send(profiles: readonly string[], options: { address?: string; path?: string; headers?: Record<string, string> } = {}) {
    const label = `agora ${randomUUID()}`
    outbound.set(await signer.mint({ label, ttlSeconds: 600, profiles, address: options.address ?? '127.0.0.1' }))
    const url = new URL(mcpServers(['agora:read'])[0]!.url)
    const proxy = new URL(outbound.url)
    const authority = `${url.hostname}:443`
    const tunnel = await new Promise<Socket>((resolve, reject) => {
      const connect = httpRequest({ host: proxy.hostname, port: Number(proxy.port), method: 'CONNECT', path: authority, headers: { host: authority } })
      connect.once('connect', (response, socket) => {
        if (response.statusCode === 200) return resolve(socket)
        socket.destroy()
        reject(new Error(`CONNECT ${authority}: ${String(response.statusCode)}`))
      })
      connect.once('error', reject)
      connect.end()
    })
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: url.hostname,
          path: options.path ?? url.pathname,
          method: 'POST',
          headers: { host: url.host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', connection: 'close', ...options.headers },
          createConnection: () => tlsConnect({ socket: tunnel, servername: url.hostname, ca }),
        },
        (res: IncomingMessage) => {
          res.resume()
          res.once('end', () => resolve(res.statusCode ?? 0))
        },
      )
      req.once('error', reject)
      req.end(body)
    })
    return { label, status }
  }

  before(async () => {
    const binary = await agentgateway()
    const dir = mkdtempSync(join(tmpdir(), 'agora-gateway-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=Agora gateway CA (test)', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', join(dir, 'ca-key.pem'), '-out', join(dir, 'ca-cert.pem')], { stdio: 'ignore' })
    ca = readFileSync(join(dir, 'ca-cert.pem'), 'utf8')
    server = await agora()
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    writeFileSync(join(dir, 'grants-key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }))
    writeFileSync(join(dir, 'jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'agora-grants-1', alg: 'EdDSA', use: 'sig' }] }))
    const [connect, admin, readiness] = [await freePort(), await freePort(), await freePort()]
    const values: Record<string, string> = {
      ADMIN_PORT: String(admin),
      READINESS_PORT: String(readiness),
      CONNECT_PORT: String(connect),
      CA_CERT: join(dir, 'ca-cert.pem'),
      CA_KEY: join(dir, 'ca-key.pem'),
      JWKS: join(dir, 'jwks.json'),
      AGORA_MCP: server.address,
    }
    const config = readFileSync(new URL('./fixtures/agora-gateway.yaml', import.meta.url), 'utf8').replace(/\$\{([A-Z_]+)\}/g, (_, key: string) => values[key] ?? '')
    writeFileSync(join(dir, 'config.yaml'), config)
    gateway = spawn(binary, ['-f', join(dir, 'config.yaml')], { stdio: ['ignore', 'pipe', 'pipe'] })
    gateway.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    gateway.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const deadline = Date.now() + 30_000
    for (;;) {
      const ready = await fetch(`http://127.0.0.1:${String(readiness)}/healthz/ready`).then((r) => r.status === 200, () => false)
      if (ready) break
      if (Date.now() > deadline || gateway.exitCode !== null) throw new Error(`the gateway did not start:\n${output}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    signer = new GrantSigner({ proxy: `127.0.0.1:${String(connect)}`, keyFile: join(dir, 'grants-key.pem'), keyId: 'agora-grants-1', issuer: 'agora', audience: 'agora-gateway' })
    outbound = await startOutbound({ log: () => {} })
  })

  after(async () => {
    await outbound?.close()
    gateway?.kill()
    await server?.close()
  })

  it('M8 with agora:read: the message reaches Agora with x-agora-execution, the token’s own execution, over the one the sandbox sent', async () => {
    assert.equal(new URL(mcpServers(['agora:read'])[0]!.url).hostname, AGORA_MCP_HOST)
    const count = server.seen.length
    const plain = await send(['agora:read'])
    const forged = await send(['agora:read'], { headers: { 'x-agora-execution': `agora ${randomUUID()}` } })
    assert.deepEqual([plain.status, forged.status], [200, 200], output)
    const seen = server.seen.slice(count)
    assert.deepEqual(
      seen.map((s) => [s.method, s.path, s.execution]),
      [
        ['POST', '/mcp', plain.label],
        ['POST', '/mcp', forged.label],
      ],
    )
    assert.ok(seen.every((s) => s.body.includes('"tools/list"')))
  })

  it('M8 without agora:read — anthropic, internet —, from another address, or on another path: 403 at the gateway, nothing reaches Agora', async () => {
    const count = server.seen.length
    for (const [profiles, options] of [
      [['anthropic'], {}],
      [['internet'], {}],
      [['agora:read'], { address: '10.244.9.9' }],
      [['agora:read'], { path: '/api/workstreams' }],
    ] as const) {
      const { status } = await send(profiles, options)
      assert.equal(status, 403, `${profiles.join(',')} ${JSON.stringify(options)}`)
    }
    assert.equal(server.seen.length, count)
    // Control: agora:read from its own address, on /mcp.
    assert.equal((await send(['agora:read'])).status, 200)
    assert.equal(server.seen.length, count + 1)
  })
})
