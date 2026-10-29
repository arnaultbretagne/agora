// The vault through the real gateway (docs/specs/credentials.md, "The vault"): agentgateway 1.6.0, its release
// binary checked against its sha256, run on the configuration infra-k8s deploys (fixtures/vault-gateway.yaml);
// tokens signed by Agora's GrantSigner; the bridge's outbound proxy, which adds the token to each CONNECT; an MCP
// client that dials the server `mcpServers` gives `session/new`; and a stand-in for the vault's MCP server, with
// its twelve tools and its prompt, which records every message and the Authorization it came with.
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, chmodSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer as createNetServer, type Socket } from 'node:net'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { connect as tlsConnect } from 'node:tls'
import { after, before, describe, it } from 'node:test'
import { startOutbound, type Outbound } from '@agora/harness-bridge/outbound'
import { GrantSigner, mcpServers, VAULT_READ_TOOLS, VAULT_WRITE_TOOLS, type McpServer } from '../src/index.ts'

const RELEASE = 'https://github.com/agentgateway/agentgateway/releases/download/v1.6.0/agentgateway-linux-amd64'
const SHA256 = '496ed27e6a96b55a9ad7cabe5c2be7172511f44a3cb113e533d22bf93a7f079d'
/** What the gateway holds for the vault: a stand-in for the Pocket-ID machine client's token. */
const GATEWAY_CREDENTIAL = 'pocket-id-agora-gateway-vault-stand-in'
/** What a sandbox could send itself: it must never reach the server. */
const SANDBOX_AUTHORIZATION = 'Bearer forged-by-the-sandbox'

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
    const response = await fetch(RELEASE)
    assert.equal(response.status, 200, `download ${RELEASE}`)
    const partial = `${file}.${randomUUID()}`
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(partial))
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
  readonly authorization: string | undefined
  readonly method: string
  /** The JSON-RPC method, and for a call the tool or the prompt it names. */
  readonly rpc: string | null
  readonly name: string | null
}

/** A stand-in for obsidian-mcp 0.4.0: Streamable HTTP with sessions, its tools and its prompt; answers in JSON. */
async function vaultServer(): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const tools = [...VAULT_READ_TOOLS, ...VAULT_WRITE_TOOLS].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }))
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; method?: string; params?: { name?: string; protocolVersion?: string } }) : null
      seen.push({ authorization: req.headers.authorization, method: req.method ?? '', rpc: body?.method ?? null, name: body?.params?.name ?? null })
      if (req.method === 'DELETE') return void res.writeHead(200).end()
      if (req.method !== 'POST' || body === null) return void res.writeHead(405).end()
      if (body.id === undefined) return void res.writeHead(202).end()
      const answer = (result: unknown, headers: Record<string, string> = {}) =>
        void res.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      switch (body.method) {
        case 'initialize':
          return answer(
            { protocolVersion: body.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'vault-mcp', version: '0.2.0' } },
            { 'mcp-session-id': randomUUID() },
          )
        case 'ping':
          return answer({})
        case 'tools/list':
          return answer({ tools })
        case 'tools/call':
          return answer({ content: [{ type: 'text', text: `vault: ${String(body.params?.name)} done` }] })
        case 'prompts/list':
          return answer({ prompts: [{ name: 'clip-to-vault', description: 'Clip a page into the vault' }] })
        case 'prompts/get':
          return answer({ messages: [{ role: 'user', content: { type: 'text', text: 'Clip this page with clip_url.' } }] })
        default:
          return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${String(port)}/mcp`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

interface RpcAnswer {
  readonly status: number
  readonly result?: Record<string, unknown>
  readonly error?: { code: number; message: string }
  readonly session?: string
}

/**
 * An MCP client as a harness runs one in its sandbox: it dials the server `mcpServers` names, with its headers,
 * through the bridge's outbound proxy (HTTPS_PROXY), which adds the token; TLS to the server's host, the
 * gateway's CA trusted. One tunnel per message.
 */
class McpClient {
  private session: string | undefined
  private id = 0
  private readonly server: McpServer
  private readonly proxy: string
  private readonly ca: string

  constructor(server: McpServer, proxy: string, ca: string) {
    this.server = server
    this.proxy = proxy
    this.ca = ca
  }

  async send(method: string, params: Record<string, unknown> = {}, notification = false): Promise<RpcAnswer> {
    const url = new URL(this.server.url)
    const proxy = new URL(this.proxy)
    const authority = `${url.hostname}:${url.port || '443'}`
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
    const id = notification ? undefined : ++this.id
    const body = JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })
    const headers: Record<string, string> = {
      host: url.host,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: SANDBOX_AUTHORIZATION,
      connection: 'close',
      ...Object.fromEntries(this.server.headers.map((h) => [h.name, h.value])),
      ...(this.session === undefined ? {} : { 'mcp-session-id': this.session }),
    }
    return new Promise<RpcAnswer>((resolve, reject) => {
      const req = httpsRequest(
        { host: url.hostname, path: url.pathname + url.search, method: 'POST', headers, createConnection: () => tlsConnect({ socket: tunnel, servername: url.hostname, ca: this.ca }) },
        (res: IncomingMessage) => {
          const session = typeof res.headers['mcp-session-id'] === 'string' ? res.headers['mcp-session-id'] : undefined
          if (session !== undefined) this.session = session
          let text = ''
          const done = (message: { result?: Record<string, unknown>; error?: { code: number; message: string } } | null) => {
            res.destroy()
            resolve({ status: res.statusCode ?? 0, ...(message ?? {}), ...(session === undefined ? {} : { session }) })
          }
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            text += chunk
            // An answer in a stream: the event carrying this request's id.
            if (!String(res.headers['content-type']).includes('text/event-stream')) return
            for (const line of text.split('\n')) {
              if (!line.startsWith('data:')) continue
              const message = JSON.parse(line.slice(5)) as { id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } }
              if (message.id === id) return done(message)
            }
          })
          res.once('end', () => {
            // A JSON body, whatever the status: a refusal in the protocol is a JSON-RPC error too.
            done(id !== undefined && String(res.headers['content-type']).includes('application/json') ? JSON.parse(text) : null)
          })
          res.once('error', () => done(null))
        },
      )
      req.once('error', reject)
      req.end(body)
    })
  }

  async initialize(): Promise<RpcAnswer> {
    const answer = await this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harness', version: '1' } })
    if (answer.status === 200) await this.send('notifications/initialized', {}, true)
    return answer
  }
}

describe('the vault through agentgateway 1.6.0', { skip }, () => {
  let gateway: ChildProcess
  let output = ''
  let vault: Awaited<ReturnType<typeof vaultServer>>
  let outbound: Outbound
  let signer: GrantSigner
  let ca = ''
  let proxy = ''

  /** A client in a sandbox whose bridge holds a token for these profiles, bound to `address`. */
  async function sandbox(profiles: readonly string[], address = '127.0.0.1'): Promise<McpClient> {
    const credentials = await signer.mint({ label: `agora vault-${randomUUID()}`, ttlSeconds: 600, profiles, address })
    outbound.set(credentials)
    // The entry `session/new` gets for a vault profile; a client without one is pointed at the same server.
    const [server] = mcpServers(profiles.some((p) => p.startsWith('vault:')) ? profiles : ['vault:read'])
    return new McpClient(server!, outbound.url, ca)
  }

  const calls = (rpc: string, name?: string) => vault.seen.filter((s) => s.rpc === rpc && (name === undefined || s.name === name)).length

  before(async () => {
    const binary = await agentgateway()
    const dir = mkdtempSync(join(tmpdir(), 'vault-gateway-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=Agora gateway CA (test)', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', join(dir, 'ca-key.pem'), '-out', join(dir, 'ca-cert.pem')], { stdio: 'ignore' })
    ca = readFileSync(join(dir, 'ca-cert.pem'), 'utf8')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    writeFileSync(join(dir, 'grants-key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }))
    writeFileSync(join(dir, 'jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'agora-grants-1', alg: 'EdDSA', use: 'sig' }] }))
    writeFileSync(join(dir, 'access_token'), GATEWAY_CREDENTIAL)
    vault = await vaultServer()
    const [connect, admin, readiness] = [await freePort(), await freePort(), await freePort()]
    const values: Record<string, string> = {
      ADMIN_PORT: String(admin),
      READINESS_PORT: String(readiness),
      CONNECT_PORT: String(connect),
      CA_CERT: join(dir, 'ca-cert.pem'),
      CA_KEY: join(dir, 'ca-key.pem'),
      JWKS: join(dir, 'jwks.json'),
      VAULT_MCP: vault.url,
      VAULT_TOKEN: join(dir, 'access_token'),
    }
    const config = readFileSync(new URL('./fixtures/vault-gateway.yaml', import.meta.url), 'utf8').replace(/\$\{([A-Z_]+)\}/g, (_, key: string) => values[key] ?? '')
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
    proxy = `127.0.0.1:${String(connect)}`
    signer = new GrantSigner({ proxy, keyFile: join(dir, 'grants-key.pem'), keyId: 'agora-grants-1', issuer: 'agora', audience: 'agora-gateway' })
    outbound = await startOutbound({ log: () => {} })
  })

  after(async () => {
    await outbound?.close()
    gateway?.kill()
    await vault?.close()
  })

  it('C44 vault:read: initialize, the six read tools listed, read_note read; create_note and the prompt refused by the gateway, never seen by the server', async () => {
    const client = await sandbox(['anthropic', 'vault:read'])
    const init = await client.initialize()
    assert.equal(init.status, 200, output)
    assert.equal((init.result?.serverInfo as { name?: string } | undefined)?.name, 'vault-mcp')
    const list = await client.send('tools/list')
    assert.deepEqual(((list.result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort(), [...VAULT_READ_TOOLS].sort())
    const read = await client.send('tools/call', { name: 'read_note', arguments: { path: 'Inbox/note.md' } })
    assert.deepEqual(read.result?.content, [{ type: 'text', text: 'vault: read_note done' }])
    assert.equal(calls('tools/call', 'read_note'), 1)
    const write = await client.send('tools/call', { name: 'create_note', arguments: { path: 'Inbox/new.md', content: 'x' } })
    assert.equal(write.status, 400, JSON.stringify(write))
    assert.equal(write.error?.code, -32602, JSON.stringify(write))
    assert.match(write.error?.message ?? '', /Unknown tool: create_note/)
    assert.equal(calls('tools/call', 'create_note'), 0)
    const prompts = await client.send('prompts/list')
    assert.deepEqual(prompts.result?.prompts, [])
    const prompt = await client.send('prompts/get', { name: 'clip-to-vault' })
    assert.deepEqual([prompt.status, prompt.error], [400, { code: -32602, message: 'Unknown prompt: clip-to-vault' }])
    assert.equal(calls('prompts/get'), 0)
  })

  it('C44 vault:write: twelve tools listed, create_note then delete_note reach the server, and the prompt', async () => {
    const client = await sandbox(['anthropic', 'vault:write'])
    assert.equal((await client.initialize()).status, 200, output)
    const list = await client.send('tools/list')
    assert.deepEqual(((list.result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort(), [...VAULT_READ_TOOLS, ...VAULT_WRITE_TOOLS].sort())
    for (const name of ['create_note', 'delete_note']) {
      const answer = await client.send('tools/call', { name, arguments: { path: 'Inbox/new.md' } })
      assert.deepEqual(answer.result?.content, [{ type: 'text', text: `vault: ${name} done` }], name)
      assert.equal(calls('tools/call', name), 1, name)
    }
    const prompt = await client.send('prompts/get', { name: 'clip-to-vault' })
    assert.ok(Array.isArray(prompt.result?.messages), JSON.stringify(prompt))
    assert.equal(calls('prompts/get', 'clip-to-vault'), 1)
  })

  it('C45 internet alone, anthropic alone, vault:write from another address: 403 from the gateway, nothing reaches the server', async () => {
    const before = vault.seen.length
    for (const [profiles, address] of [[['internet'], '127.0.0.1'], [['anthropic'], '127.0.0.1'], [['vault:write'], '10.244.9.9']] as const) {
      const answer = await (await sandbox(profiles, address)).initialize()
      assert.equal(answer.status, 403, `${profiles.join(',')} from ${address}`)
    }
    assert.equal(vault.seen.length, before)
    // Control: the same initialize with vault:write from its own address reaches the server.
    assert.equal((await (await sandbox(['vault:write'])).initialize()).status, 200)
    assert.ok(vault.seen.length > before)
  })

  it('C46 vault:read and vault:write in one token, in either order: the prompt and create_note let through', async () => {
    for (const order of [['vault:read', 'vault:write'], ['vault:write', 'vault:read']]) {
      const client = await sandbox(order)
      assert.equal((await client.initialize()).status, 200, output)
      const prompt = await client.send('prompts/get', { name: 'clip-to-vault' })
      assert.ok(Array.isArray(prompt.result?.messages), `${order.join(',')}: ${JSON.stringify(prompt)}`)
      const write = await client.send('tools/call', { name: 'create_note', arguments: { path: 'Inbox/new.md' } })
      assert.deepEqual(write.result?.content, [{ type: 'text', text: 'vault: create_note done' }], order.join(','))
    }
  })

  it('C44 over every exchange above, the server only ever received the gateway’s credential: never the token, never what the sandbox sent', () => {
    assert.ok(vault.seen.length > 0)
    assert.deepEqual([...new Set(vault.seen.map((s) => s.authorization))], [`Bearer ${GATEWAY_CREDENTIAL}`])
  })
})
