// The previews through the real gateway and their real gate (docs/specs/credentials.md, "Previews"): agentgateway
// 1.6.0 and oauth2-proxy 7.15.5 — the gates' version in infra-k8s —, their release binaries checked against their
// sha256. The gateway on fixtures/previews-gateway.yaml, its credential a client-credentials token shaped as
// Pocket-ID 2.18.0 issues one; the gateway gate configured as the spec asks, the browser gate as infra-k8s's
// template configures it; a stand-in issuer for both; an app behind them that records what it receives; tokens
// from Agora's GrantSigner and the bridge's outbound proxy on the sandbox's side.
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readlinkSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
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
import { GrantSigner } from '../src/index.ts'

const BINARIES = {
  agentgateway: { url: 'https://github.com/agentgateway/agentgateway/releases/download/v1.6.0/agentgateway-linux-amd64', sha256: '496ed27e6a96b55a9ad7cabe5c2be7172511f44a3cb113e533d22bf93a7f079d', member: null },
  'oauth2-proxy': {
    url: 'https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v7.15.5/oauth2-proxy-v7.15.5.linux-amd64.tar.gz',
    sha256: 'f63f94bf72c5f46ab002a0a275aa8b3cf19b4d828aed08a13978cb9a62c3a1fd',
    member: 'oauth2-proxy-v7.15.5.linux-amd64/oauth2-proxy',
  },
} as const
/** The Pocket-ID clients: the gateway's own for the previews, the previews' browser client, another one. */
const GATEWAY_CLIENT = '6f1c2b0e-8d3a-4c57-9e21-3b7a5d9c4f10'
const BROWSER_CLIENT = 'preview'
const OTHER_CLIENT = '285e5889-e9b4-40cf-b1e8-a6f430f42c35'
const HOST = 'pr-42-demo.preview.bretagne.dev'
/** The constant the gate sends to the app in place of the Authorization it received. */
const BASIC_AUTH_PASSWORD = 'none'

let tools = true
for (const [tool, flag] of [['openssl', 'version'], ['tar', '--version']] as const) {
  try {
    execFileSync(tool, [flag], { stdio: 'ignore' })
  } catch {
    tools = false
  }
}
const skip = platform() !== 'linux' || arch() !== 'x64' ? 'the binaries are linux-amd64' : !tools ? 'openssl and tar are needed' : false

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** A release binary, downloaded once into the temporary directory, checked before every run. */
async function binary(name: keyof typeof BINARIES): Promise<string> {
  const { url, sha256: expected, member } = BINARIES[name]
  const dir = join(tmpdir(), `agora-${name}-${expected.slice(0, 12)}`)
  const download = join(dir, member === null ? name : 'release.tar.gz')
  if (!existsSync(download)) {
    mkdirSync(dir, { recursive: true })
    const response = await fetch(url)
    assert.equal(response.status, 200, `download ${url}`)
    const partial = `${download}.${randomUUID()}`
    await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(partial))
    renameSync(partial, download)
  }
  assert.equal(await sha256(download), expected, `${name}, as released`)
  if (member === null) {
    chmodSync(download, 0o755)
    return download
  }
  execFileSync('tar', ['-xzf', download, '-C', dir, member])
  return join(dir, member)
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function listening(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(what: string, probe: () => Promise<T | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(100)
  }
}

/** A stand-in for Pocket-ID: its discovery and its keys; it signs the tokens the test needs, RS256. */
async function issuer(): Promise<{ url: string; mint(claims: Record<string, unknown>): string; close(): Promise<void> }> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = 'pocket-id-test'
  let url = ''
  const server = createHttpServer((req, res) => {
    const json = (body: unknown) => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (req.url === '/.well-known/openid-configuration') {
      return json({
        issuer: url,
        authorization_endpoint: `${url}/authorize`,
        token_endpoint: `${url}/api/oidc/token`,
        userinfo_endpoint: `${url}/api/oidc/userinfo`,
        jwks_uri: `${url}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      })
    }
    if (req.url === '/.well-known/jwks.json') return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] })
    res.writeHead(404).end()
  })
  url = `http://127.0.0.1:${String(await listening(server))}`
  const mint = (claims: Record<string, unknown>): string => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const data = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode({ iss: url, iat: now, nbf: now, exp: now + 900, jti: randomUUID(), ...claims })}`
    return `${data}.${sign('sha256', Buffer.from(data), privateKey as KeyObject).toString('base64url')}`
  }
  return { url, mint, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** The preview's app: records each request; `/slow` answers in two parts, 3 s apart. */
async function app(): Promise<{ address: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('first part\n')
        setTimeout(() => res.end('second part\n'), 3000)
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`app: ${req.method ?? ''} ${req.url ?? ''}`)
    })
  })
  return { address: `127.0.0.1:${String(await listening(server))}`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

/** An oauth2-proxy started with these flags, ready once its health answers. */
async function oauth2Proxy(binary: string, flags: Record<string, string | string[]>): Promise<{ address: string; output: () => string; process: ChildProcess }> {
  const port = await freePort()
  const args = [`--http-address=127.0.0.1:${String(port)}`, ...Object.entries(flags).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `--${k}=${x}`))]
  let output = ''
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  await until(`oauth2-proxy on ${String(port)}:\n${output}`, async () => {
    if (child.exitCode !== null) throw new Error(`oauth2-proxy exited:\n${output}`)
    return fetch(`http://127.0.0.1:${String(port)}/ping`).then((r) => r.status === 200 || false, () => false)
  })
  return { address: `127.0.0.1:${String(port)}`, output: () => output, process: child }
}

/** A plain request to a gate, as Traefik would send it. */
async function direct(address: string, headers: Record<string, string>, path = '/'): Promise<{ status: number; location: string | undefined; body: string }> {
  const response = await fetch(`http://${address}${path}`, { headers: { host: HOST, ...headers }, redirect: 'manual' })
  return { status: response.status, location: response.headers.get('location') ?? undefined, body: await response.text() }
}

describe('the previews through agentgateway 1.6.0 and their oauth2-proxy 7.15.5 gate', { skip }, () => {
  const procs: ChildProcess[] = []
  let output = ''
  let idp: Awaited<ReturnType<typeof issuer>>
  let preview: Awaited<ReturnType<typeof app>>
  let gatewayGate: Awaited<ReturnType<typeof oauth2Proxy>>
  let browserGate: Awaited<ReturnType<typeof oauth2Proxy>>
  let outbound: Outbound
  let signer: GrantSigner
  let ca = ''
  let dir = ''
  let credentialFile = ''
  let gatewayToken = ''
  let identities = ''

  /** A request from a sandbox whose bridge holds a token for these profiles, bound to `address`. */
  async function sandbox(profiles: readonly string[], address = '127.0.0.1') {
    outbound.set(await signer.mint({ label: `agora previews-${randomUUID()}`, ttlSeconds: 600, profiles, address }))
    return (host: string, method = 'GET', path = '/', body?: string, onFirst?: () => Promise<void>) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const proxy = new URL(outbound.url)
        const connect = httpRequest({ host: proxy.hostname, port: Number(proxy.port), method: 'CONNECT', path: `${host}:443`, headers: { host: `${host}:443` } })
        connect.once('connect', (response, socket: Socket) => {
          if (response.statusCode !== 200) {
            socket.destroy()
            return resolve({ status: response.statusCode ?? 0, body: '' })
          }
          const req = httpsRequest(
            {
              host,
              path,
              method,
              // What a sandbox could send itself: never the app's.
              headers: { host, authorization: 'Bearer forged-by-the-sandbox', 'x-forwarded-user': 'forged-user', connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
              createConnection: () => tlsConnect({ socket, servername: host, ca }),
            },
            (res: IncomingMessage) => {
              let text = ''
              let first = true
              res.setEncoding('utf8')
              res.on('data', (chunk: string) => {
                text += chunk
                if (first && onFirst) void onFirst()
                first = false
              })
              res.once('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
              res.once('error', reject)
            },
          )
          req.once('error', reject)
          req.end(body)
        })
        connect.once('error', reject)
        connect.end()
      })
  }

  /** The gateway gate's allowed identities, rewritten as the kubelet updates a ConfigMap: a new directory, the link swapped, the old one removed. */
  function writeIdentities(lines: string[]): void {
    const version = join(dir, 'identities', `..${randomUUID()}`)
    mkdirSync(version, { recursive: true })
    writeFileSync(join(version, 'gateway-identities'), lines.map((l) => `${l}\n`).join(''))
    const data = join(dir, 'identities', '..data')
    const next = join(dir, 'identities', `..data_tmp`)
    const previous = existsSync(data) ? readlinkSync(data) : null
    symlinkSync(version.split('/').pop()!, next)
    renameSync(next, data)
    if (previous !== null) rmSync(join(dir, 'identities', previous), { recursive: true, force: true })
    const file = join(dir, 'identities', 'gateway-identities')
    try {
      lstatSync(file)
    } catch {
      symlinkSync('..data/gateway-identities', file)
    }
  }

  before(async () => {
    const [gatewayBinary, proxyBinary] = [await binary('agentgateway'), await binary('oauth2-proxy')]
    dir = mkdtempSync(join(tmpdir(), 'previews-gateway-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=Agora gateway CA (test)', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', join(dir, 'ca-key.pem'), '-out', join(dir, 'ca-cert.pem')], { stdio: 'ignore' })
    ca = readFileSync(join(dir, 'ca-cert.pem'), 'utf8')
    idp = await issuer()
    preview = await app()

    // The gateway gate: the spec's configuration.
    writeIdentities([`client-${GATEWAY_CLIENT}`])
    identities = join(dir, 'identities', 'gateway-identities')
    const cookieSecret = randomBytes(16).toString('hex')
    gatewayGate = await oauth2Proxy(proxyBinary, {
      provider: 'oidc',
      'oidc-issuer-url': idp.url,
      'client-id': GATEWAY_CLIENT,
      'client-secret': 'unused',
      'cookie-secret': cookieSecret,
      'redirect-url': `https://${HOST}/oidc/callback`,
      'proxy-prefix': '/oidc',
      upstream: `http://${preview.address}`,
      'skip-jwt-bearer-tokens': 'true',
      'bearer-token-login-fallback': 'false',
      'oidc-email-claim': 'sub',
      'authenticated-emails-file': identities,
      'pass-basic-auth': 'true',
      'basic-auth-password': BASIC_AUTH_PASSWORD,
      'reverse-proxy': 'true',
      'api-route': '^/',
    })
    // The browser gate: infra-k8s's template (infrastructure/configs/previews/resourceset.yaml), unchanged.
    browserGate = await oauth2Proxy(proxyBinary, {
      provider: 'oidc',
      'oidc-issuer-url': idp.url,
      'client-id': BROWSER_CLIENT,
      'client-secret': 'browser-secret',
      'cookie-secret': cookieSecret,
      'redirect-url': `https://${HOST}/oidc/callback`,
      'proxy-prefix': '/oidc',
      upstream: `http://${preview.address}`,
      scope: 'openid email profile groups',
      'oidc-groups-claim': 'groups',
      'allowed-group': 'admin',
      'email-domain': '*',
      'cookie-secure': 'true',
      'cookie-domain': HOST,
      'whitelist-domain': HOST,
      'reverse-proxy': 'true',
      'skip-provider-button': 'true',
      'insecure-oidc-allow-unverified-email': 'true',
    })
    procs.push(gatewayGate.process, browserGate.process)

    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    writeFileSync(join(dir, 'grants-key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }))
    writeFileSync(join(dir, 'jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'agora-grants-1', alg: 'EdDSA', use: 'sig' }] }))
    // The gateway's credential: a client-credentials token of its own Pocket-ID client.
    gatewayToken = idp.mint({ sub: `client-${GATEWAY_CLIENT}`, aud: GATEWAY_CLIENT })
    credentialFile = join(dir, 'access_token')
    writeFileSync(credentialFile, gatewayToken)
    const [connect, admin, readiness] = [await freePort(), await freePort(), await freePort()]
    const values: Record<string, string> = {
      ADMIN_PORT: String(admin),
      READINESS_PORT: String(readiness),
      CONNECT_PORT: String(connect),
      CA_CERT: join(dir, 'ca-cert.pem'),
      CA_KEY: join(dir, 'ca-key.pem'),
      JWKS: join(dir, 'jwks.json'),
      GATE: gatewayGate.address,
      GATEWAY_TOKEN: credentialFile,
    }
    writeFileSync(join(dir, 'config.yaml'), readFileSync(new URL('./fixtures/previews-gateway.yaml', import.meta.url), 'utf8').replace(/\$\{([A-Z_]+)\}/g, (_, key: string) => values[key] ?? ''))
    const gateway = spawn(gatewayBinary, ['-f', join(dir, 'config.yaml')], { stdio: ['ignore', 'pipe', 'pipe'] })
    procs.push(gateway)
    gateway.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    gateway.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    await until(`the gateway:\n${output}`, async () => {
      if (gateway.exitCode !== null) throw new Error(`the gateway exited:\n${output}`)
      return fetch(`http://127.0.0.1:${String(readiness)}/healthz/ready`).then((r) => r.status === 200 || false, () => false)
    })
    signer = new GrantSigner({ proxy: `127.0.0.1:${String(connect)}`, keyFile: join(dir, 'grants-key.pem'), keyId: 'agora-grants-1', issuer: 'agora', audience: 'agora-gateway' })
    outbound = await startOutbound({ log: () => {} })
  })

  after(async () => {
    await outbound?.close()
    for (const p of procs) p.kill()
    await preview?.close()
    await idp?.close()
  })

  it('C56 previews: a GET and a POST on a preview reach its app through the gateway and the gateway gate; the app never receives the gateway’s token', async () => {
    const request = await sandbox(['anthropic', 'github:octo/app:read', 'internet', 'previews'])
    const count = preview.seen.length
    const get = await request(HOST, 'GET', '/items?page=2')
    assert.deepEqual(get, { status: 200, body: 'app: GET /items?page=2' }, output + gatewayGate.output())
    const post = await request(HOST, 'POST', '/items', '{"name":"x"}')
    assert.deepEqual(post, { status: 200, body: 'app: POST /items' })
    const seen = preview.seen.slice(count)
    assert.equal(seen.length, 2)
    assert.equal(seen[1]!.body, '{"name":"x"}')
    for (const s of seen) {
      // The identity the gate asserts, and in Authorization the gate's own Basic, with the constant password.
      assert.equal(s.headers['x-forwarded-user'], `client-${GATEWAY_CLIENT}`)
      assert.equal(s.headers['x-forwarded-email'], `client-${GATEWAY_CLIENT}`)
      assert.equal(s.headers.authorization, `Basic ${Buffer.from(`client-${GATEWAY_CLIENT}:${BASIC_AUTH_PASSWORD}`).toString('base64')}`)
      assert.equal(s.headers['x-agora-gate'], 'gateway')
      // Never the gateway's token, nor what the sandbox sent.
      assert.ok(!JSON.stringify(s.headers).includes(gatewayToken), 'the gateway’s token')
      assert.ok(!JSON.stringify(s.headers).includes('forged'), 'what the sandbox sent')
    }
  })

  it('C57 neighbours of the previews, the previews without the profile, or from another address: 403 from the gateway, nothing reaches the app', async () => {
    const count = preview.seen.length
    const previews = await sandbox(['previews'])
    for (const host of ['a.b.preview.bretagne.dev', 'pr-42-demo.x.preview.bretagne.dev', 'x.preview.bretagne.dev', 'x.bretagne.dev', 'preview.bretagne.dev.evil.com', 'pr-42-demo.preview.bretagne.dev.evil.com']) {
      assert.equal((await previews(host)).status, 403, host)
    }
    for (const [profiles, address] of [[['anthropic'], '127.0.0.1'], [['internet', 'github:octo/app:read'], '127.0.0.1'], [['previews'], '10.244.9.9']] as const) {
      assert.equal((await (await sandbox(profiles, address))(HOST)).status, 403, `${profiles.join(',')} from ${address}`)
    }
    assert.equal(preview.seen.length, count)
    // Control: previews from its own address.
    assert.equal((await (await sandbox(['previews']))(HOST)).status, 200)
    assert.equal(preview.seen.length, count + 1)
  })

  it('C58 the gateway gate takes the gateway’s client alone: another client, a user’s token for the same client, an expired one refused; the browser gate takes none', async () => {
    const count = preview.seen.length
    assert.equal((await direct(gatewayGate.address, { authorization: `Bearer ${gatewayToken}` })).status, 200)
    const refused: [string, string][] = [
      ['another client', idp.mint({ sub: `client-${OTHER_CLIENT}`, aud: OTHER_CLIENT })],
      ['another client claiming the gateway’s audience', idp.mint({ sub: `client-${OTHER_CLIENT}`, aud: GATEWAY_CLIENT })],
      ['an admin’s token for the gateway’s client (a device code)', idp.mint({ sub: randomUUID(), aud: GATEWAY_CLIENT, email: 'admin@bretagne.dev', groups: ['admin'] })],
      ['the gateway’s client, expired', idp.mint({ sub: `client-${GATEWAY_CLIENT}`, aud: GATEWAY_CLIENT, iat: 1, nbf: 1, exp: 2 })],
      ['not a token', 'forged-by-the-sandbox'],
    ]
    for (const [what, token] of refused) {
      const answer = await direct(gatewayGate.address, { authorization: `Bearer ${token}` })
      assert.ok([401, 403].includes(answer.status), `${what}: ${String(answer.status)}`)
    }
    assert.ok([401, 403].includes((await direct(gatewayGate.address, {})).status), 'no token')
    // The browser gate, unchanged: the gateway's token is not a session; it is sent to sign in.
    const browser = await direct(browserGate.address, { authorization: `Bearer ${gatewayToken}` })
    assert.equal(browser.status, 302, browser.body)
    assert.match(browser.location ?? '', new RegExp(`^${idp.url}/authorize\\?`))
    assert.equal((await direct(browserGate.address, {})).status, 302)
    // Only the first request reached the app.
    assert.equal(preview.seen.length, count + 1)
  })

  it('C59 revoked: once the gateway gate’s identities no longer name the client, every token of it is refused; named again, taken', async (t) => {
    const fresh = idp.mint({ sub: `client-${GATEWAY_CLIENT}`, aud: GATEWAY_CLIENT })
    writeIdentities([])
    const started = Date.now()
    await until('the revocation', async () => (await direct(gatewayGate.address, { authorization: `Bearer ${gatewayToken}` })).status === 403 || false, 10_000)
    const took = Date.now() - started
    assert.equal((await direct(gatewayGate.address, { authorization: `Bearer ${fresh}` })).status, 403)
    assert.equal((await (await sandbox(['previews']))(HOST)).status, 403)
    writeIdentities([`client-${GATEWAY_CLIENT}`])
    await until('named again', async () => (await direct(gatewayGate.address, { authorization: `Bearer ${fresh}` })).status === 200 || false, 10_000)
    assert.ok(took < 10_000, `revoked after ${String(took)} ms`)
    t.diagnostic(`the gate refused the client ${String(took)} ms after its identities were swapped`)
  })

  it('C60 the gateway’s credential replaced while a response is open: the response ends whole, the next request carries the new one', async (t) => {
    const request = await sandbox(['previews'])
    const invalid = idp.mint({ sub: `client-${OTHER_CLIENT}`, aud: OTHER_CLIENT })
    // Replaced once the first part has arrived; the app sends the second 3 s later.
    const slow = await request(HOST, 'GET', '/slow', undefined, async () => writeFileSync(credentialFile, invalid))
    assert.deepEqual(slow, { status: 200, body: 'first part\nsecond part\n' })
    // The gateway reads the file again: the next request carries the new value, which the gate refuses.
    const replaced = Date.now()
    await until('the new credential in use', async () => (await request(HOST)).status === 403 || false, 15_000)
    t.diagnostic(`the gateway sent the new credential ${String(Date.now() - replaced)} ms after the response that saw it replaced`)
    writeFileSync(credentialFile, gatewayToken)
    await until('the credential restored', async () => (await request(HOST)).status === 200 || false, 15_000)
  })
})
