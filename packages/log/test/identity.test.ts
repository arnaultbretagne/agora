// docs/specs/log.md, "Identity": who calls the real server (apps/server/src/main.ts) with IDENTITY `oidc` — an
// ID token an issuer signed, a service token — and what proves nobody. The issuer is a stand-in for Pocket-ID
// on the loopback: its discovery document and its keys, made here; no network.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { identity } from '../src/index.ts'
import { readList } from './lists.ts'
import { cluster, database, Server, until, type Db } from './support.ts'

const PERSON = 'person@example.org'
const SOMEONE = 'someone@example.org'
/** The cases' owner, as apps/server/scripts/live-cases.ts names it: no e-mail gives it. */
const CASES = 'c45e0000-0000-4000-8000-000000000000'
/** Agora's client at the issuer: the audience of its ID tokens. */
const AUDIENCE = '83e98a94-0000-4000-8000-00000000a6e1'
const KID = 'issuer-key-1'
const MAIN = new URL('../../../apps/server/src/main.ts', import.meta.url).pathname

const signing = await generateKeyPair('RS256', { extractable: true })
/** Another key, under the issuer's key id. */
const other = await generateKeyPair('RS256')
const published: JWK = { ...(await exportJWK(signing.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }

/** Pocket-ID's two documents, as v2.18.0 publishes them; `down`, both answer 503. */
class Issuer {
  url = ''
  down = false
  readonly reads = { discovery: 0, keys: 0 }
  private server: HttpServer | null = null

  static async start(): Promise<Issuer> {
    const issuer = new Issuer()
    issuer.server = createServer((req, res) => {
      if (issuer.down) return void res.writeHead(503).end()
      const json = (value: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (req.url === '/.well-known/openid-configuration') {
        issuer.reads.discovery++
        return json({ issuer: issuer.url, jwks_uri: `${issuer.url}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ['RS256'] })
      }
      if (req.url === '/.well-known/jwks.json') {
        issuer.reads.keys++
        return json({ keys: [published] })
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => issuer.server!.listen(0, '127.0.0.1', resolve))
    issuer.url = `http://127.0.0.1:${String((issuer.server.address() as AddressInfo).port)}`
    return issuer
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }
}

/** An ID token as Pocket-ID signs it for Agora's client; each field can be changed, `exp` left out. */
async function idToken(issuer: string, claims: { email?: string; aud?: string; iss?: string; exp?: number | null } = {}, key: CryptoKey = signing.privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jwt = new SignJWT({ email: claims.email ?? PERSON, groups: ['admin'] })
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer(claims.iss ?? issuer)
    .setAudience([claims.aud ?? AUDIENCE])
    .setSubject(randomUUID())
    .setIssuedAt(now - 60)
  if (claims.exp !== null) jwt.setExpirationTime(claims.exp ?? now + 3600)
  return jwt.sign(key)
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

/** One request: its status, its body parsed when it is JSON, its `WWW-Authenticate`. */
async function ask(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON: the text itself.
  }
  return { status: response.status, body: parsed, authenticate: response.headers.get('www-authenticate') }
}

/** A Workstream, created and given a question so that it is listed (docs/specs/log.md, "The list"). */
async function listed(base: string, headers: Record<string, string>, id = randomUUID()): Promise<string> {
  const ask_ = { title: 'Listed', text: '', options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { optionId: 'b', name: 'B', kind: 'reject_once' }] }
  assert.equal((await ask(base, 'POST', '/api/workstreams', headers, { id, owner: randomUUID() })).status, 200)
  assert.equal((await ask(base, 'POST', `/api/workstreams/${id}/commands`, headers, { id: randomUUID(), kind: 'Ask', target: {}, body: ask_ })).status, 200)
  return id
}

/** The ids of a caller's list, through its pages, or its refusal. */
async function page(base: string, headers: Record<string, string>): Promise<string[] | [number, unknown]> {
  const { status, body } = await ask(base, 'GET', '/api/workstreams/page', headers)
  return status === 200 ? (body as { rows: { id: string }[] }).rows.map((r) => r.id).sort() : [status, body]
}

/** Who owns each of these Workstreams in the log's database; one absent was never written. */
async function owners(db: Db, ids: readonly string[]): Promise<Record<string, string>> {
  const rows = (await db.admin.query('SELECT id::text, owner::text FROM workstreams WHERE id = ANY($1::uuid[])', [ids])).rows as { id: string; owner: string }[]
  return Object.fromEntries(rows.map((r) => [r.id, r.owner]))
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

interface Served {
  server: Server
  issuer: Issuer
  db: Db
  tokens: { operator: string; cases: string }
}

/**
 * The real server with IDENTITY `oidc`, the issuer's stand-in, and two service tokens in a folder as a mounted
 * Secret is: the operator's for the person's e-mail, the cases' for their owner.
 */
async function served(t: TestContext): Promise<Served> {
  const db = await database()
  const c = await cluster()
  const issuer = await Issuer.start()
  const dir = mkdtempSync(join(tmpdir(), 'agora-tokens-'))
  let server: Server | undefined
  t.after(async () => {
    await server?.stop()
    await issuer.close()
    await c.close()
    await db.drop()
    rmSync(dir, { recursive: true, force: true })
  })
  // A mounted Secret's own entry, beside its keys.
  mkdirSync(join(dir, '..data'))
  const tokens = { operator: randomBytes(32).toString('base64url'), cases: randomBytes(32).toString('base64url') }
  writeFileSync(join(dir, 'operator'), JSON.stringify({ token: tokens.operator, email: PERSON }))
  writeFileSync(join(dir, 'live-cases'), JSON.stringify({ token: tokens.cases, owner: CASES }))
  server = await Server.start({
    db,
    api: c.api,
    keys: c.keys,
    env: { IDENTITY: 'oidc', IDENTITY_ISSUER: issuer.url, IDENTITY_AUDIENCE: AUDIENCE, IDENTITY_TOKENS_DIR: dir },
  })
  return { server, issuer, db, tokens }
}

test("L173 the issuer's ID token for the person: their account, a Create theirs, their list only, its stream", async (t) => {
  const { server, issuer, db } = await served(t)
  const mine = bearer(await idToken(issuer.url))
  const theirs = bearer(await idToken(issuer.url, { email: SOMEONE }))
  assert.deepEqual(await ask(server.url, 'GET', '/api/account', mine), { status: 200, body: { email: PERSON }, authenticate: null })
  let own = ''
  let other = ''
  // The list's stream, opened with the token before either Workstream exists: their creation arrives live.
  const stream = await readList(server.url, 'after=0', {
    headers: mine,
    during: async () => {
      own = await listed(server.url, mine)
      other = await listed(server.url, theirs)
    },
    more: (live) => !live.some((r) => r.id === own),
  })
  assert.equal(stream.status, 200)
  assert.deepEqual(stream.snapshot, [])
  assert.ok(stream.live.some((r) => r.id === own))
  assert.ok(!stream.live.some((r) => r.id === other))
  // Each owned by its token's e-mail, whatever owner the body named.
  assert.deepEqual(await owners(db, [own, other]), { [own]: identity('owner', PERSON), [other]: identity('owner', SOMEONE) })
  await until("the person's list", async () => same(await page(server.url, mine), [own]))
  await until("someone else's list", async () => same(await page(server.url, theirs), [other]))
  t.diagnostic(`account ${PERSON}; stream: ${String(stream.snapshot.length)} snapshot rows, live ${stream.live.map((r) => (r.id === own ? 'own' : r.id)).join(', ')}; owners: own ${identity('owner', PERSON)}, other ${identity('owner', SOMEONE)}; lists: own only, other only; discovery read ${String(issuer.reads.discovery)}, keys ${String(issuer.reads.keys)}`)
})

test('L174 no valid proof: none, the header alone, expired, another audience, issuer or key, tampered, HS256, Basic, an unknown service token — 401, nothing listed or written', async (t) => {
  const { server, issuer, db } = await served(t)
  const now = Math.floor(Date.now() / 1000)
  const valid = await idToken(issuer.url)
  const [head, payload, signature] = valid.split('.') as [string, string, string]
  const tampered = [head, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), email: SOMEONE })).toString('base64url'), signature].join('.')
  // The issuer's public key taken as an HMAC secret: the classic confusion of algorithms.
  const hs256 = await new SignJWT({ email: PERSON })
    .setProtectedHeader({ alg: 'HS256', kid: KID })
    .setIssuer(issuer.url)
    .setAudience(AUDIENCE)
    .setExpirationTime(now + 3600)
    .sign(Buffer.from(JSON.stringify(published)))
  const proofs: [string, Record<string, string>][] = [
    ['no Authorization', {}],
    ['the header alone', { 'x-forwarded-email': PERSON }],
    ['the header and a token not signed', { 'x-forwarded-email': PERSON, authorization: `Bearer ${head}.${payload}.` }],
    ['expired 2 min ago', bearer(await idToken(issuer.url, { exp: now - 120 }))],
    ['no exp', bearer(await idToken(issuer.url, { exp: null }))],
    ['another audience', bearer(await idToken(issuer.url, { aud: 'another-client' }))],
    ['another issuer', bearer(await idToken(issuer.url, { iss: 'https://elsewhere.example.org' }))],
    ['another key, same key id', bearer(await idToken(issuer.url, {}, other.privateKey))],
    ['tampered', bearer(tampered)],
    ['HS256 with the public key', bearer(hs256)],
    ['Basic', { authorization: `Basic ${Buffer.from(`${PERSON}:x`).toString('base64')}` }],
    ['an unknown service token', bearer(randomBytes(32).toString('base64url'))],
  ]
  const refused = { status: 401, body: { reason: 'unauthenticated' }, authenticate: 'Bearer' }
  const tried: string[] = []
  for (const [name, headers] of proofs) {
    const id = randomUUID()
    tried.push(id)
    assert.deepEqual(await ask(server.url, 'GET', '/api/account', headers), refused, `${name}: account`)
    assert.deepEqual(await ask(server.url, 'GET', '/api/workstreams/page', headers), refused, `${name}: page`)
    assert.deepEqual(await ask(server.url, 'GET', '/api/workstreams/list?after=0', headers), refused, `${name}: list`)
    assert.deepEqual(await ask(server.url, 'POST', '/api/workstreams', headers, { id, owner: identity('owner', PERSON) }), refused, `${name}: Create`)
    assert.deepEqual(await ask(server.url, 'POST', `/api/workstreams/${id}/commands`, headers, { id: randomUUID(), kind: 'Ask', target: {}, body: { title: 'x', text: '', options: [] } }), refused, `${name}: command`)
  }
  assert.deepEqual(await owners(db, tried), {})
  // The controls: a valid token, and one 10 s past its exp, within the leeway, are taken; their Creates written.
  const control = randomUUID()
  const late = randomUUID()
  assert.equal((await ask(server.url, 'POST', '/api/workstreams', bearer(valid), { id: control })).status, 200)
  assert.equal((await ask(server.url, 'POST', '/api/workstreams', bearer(await idToken(issuer.url, { exp: now - 10 })), { id: late })).status, 200)
  assert.deepEqual(await owners(db, [...tried, control, late]), { [control]: identity('owner', PERSON), [late]: identity('owner', PERSON) })
  assert.deepEqual(await page(server.url, bearer(valid)), [])
  t.diagnostic(`${String(proofs.length)} proofs × account, page, list, Create, command: 401 {"reason":"unauthenticated"}, WWW-Authenticate Bearer; written: none of ${String(tried.length)}; controls: valid and 10 s late written, owner ${identity('owner', PERSON)}`)
})

test('L175 no proof on every route of port 8080: 401; /healthz answered', async (t) => {
  const { server, tokens } = await served(t)
  const ws = randomUUID()
  const routes: [string, string, unknown?][] = [
    ['GET', '/'],
    ['GET', `/w/${ws}`],
    ['GET', '/assets/index.js'],
    ['GET', '/api/config'],
    ['GET', '/api/pools'],
    ['GET', '/api/executions'],
    ['GET', '/api/events'],
    ['GET', '/api/account'],
    ['GET', '/api/search?pattern=x'],
    ['GET', '/api/log-json.js'],
    ['GET', '/api/anchors'],
    ['GET', `/api/files/${'0'.repeat(64)}`],
    ['GET', `/api/workstreams/${ws}/thread?after=0`],
    ['GET', `/api/workstreams/${ws}/row`],
    ['GET', `/api/workstreams/${ws}/entries`],
    ['GET', '/test/'],
    ['POST', '/api/test/restart', { mode: 'kill' }],
  ]
  for (const [method, path, body] of routes)
    assert.deepEqual(await ask(server.url, method, path, {}, body), { status: 401, body: { reason: 'unauthenticated' }, authenticate: 'Bearer' }, `${method} ${path}`)
  assert.deepEqual(await ask(server.url, 'GET', '/healthz'), { status: 200, body: 'ok\n', authenticate: null })
  // The controls: the same port, with a proof.
  const operator = bearer(tokens.operator)
  assert.equal((await ask(server.url, 'GET', '/api/config', operator)).status, 200)
  assert.equal((await ask(server.url, 'GET', '/api/pools', operator)).status, 200)
  assert.equal((await ask(server.url, 'GET', '/api/log-json.js', operator)).status, 200)
  // The refused restart would have ended the process 300 ms after its answer.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.equal(server.child.exitCode, null)
  assert.equal((await ask(server.url, 'GET', '/healthz')).status, 200)
  t.diagnostic(`${String(routes.length)} routes without a proof: 401 each, the kill restart included (the server still running); /healthz 200 "ok"; with the operator token /api/config, /api/pools, /api/log-json.js 200`)
})

test("L176 service tokens: the operator's stands for the person's e-mail, the cases' for their owner", async (t) => {
  const { server, issuer, db, tokens } = await served(t)
  const operator = bearer(tokens.operator)
  const cases = bearer(tokens.cases)
  const person = bearer(await idToken(issuer.url))
  assert.deepEqual(await ask(server.url, 'GET', '/api/account', operator), { status: 200, body: { email: PERSON }, authenticate: null })
  assert.deepEqual(await ask(server.url, 'GET', '/api/account', cases), { status: 200, body: { email: null }, authenticate: null })
  const byToken = await listed(server.url, operator)
  const byPerson = await listed(server.url, person)
  const byCases = await listed(server.url, cases)
  assert.deepEqual(await owners(db, [byToken, byPerson, byCases]), { [byToken]: identity('owner', PERSON), [byPerson]: identity('owner', PERSON), [byCases]: CASES })
  // The operator's token and the person's ID token read the same list; the cases' theirs alone.
  const theirs = [byToken, byPerson].sort()
  await until('the operator list', async () => same(await page(server.url, operator), theirs))
  await until("the person's list", async () => same(await page(server.url, person), theirs))
  await until("the cases' list", async () => same(await page(server.url, cases), [byCases]))
  t.diagnostic(`operator: account ${PERSON}, its Create owned by ${identity('owner', PERSON)}, list = the person's (2 rows); cases: account null, its Create owned by ${CASES} whatever the body said, list its 1 row`)
})

test('L177 the issuer out of reach: a valid ID token 503, nothing written; a service token still taken; the issuer back, the token taken', async (t) => {
  const { server, issuer, db, tokens } = await served(t)
  const mine = bearer(await idToken(issuer.url))
  issuer.down = true
  const id = randomUUID()
  assert.deepEqual(await ask(server.url, 'GET', '/api/account', mine), { status: 503, body: { reason: 'identity_unavailable' }, authenticate: null })
  assert.deepEqual(await ask(server.url, 'POST', '/api/workstreams', mine, { id }), { status: 503, body: { reason: 'identity_unavailable' }, authenticate: null })
  assert.deepEqual(await owners(db, [id]), {})
  assert.deepEqual(await ask(server.url, 'GET', '/api/account', bearer(tokens.operator)), { status: 200, body: { email: PERSON }, authenticate: null })
  issuer.down = false
  assert.deepEqual(await ask(server.url, 'GET', '/api/account', mine), { status: 200, body: { email: PERSON }, authenticate: null })
  assert.equal((await ask(server.url, 'POST', '/api/workstreams', mine, { id })).status, 200)
  assert.deepEqual(await owners(db, [id]), { [id]: identity('owner', PERSON) })
  assert.ok(issuer.reads.discovery >= 1 && issuer.reads.keys >= 1)
  t.diagnostic(`issuer down: account and Create 503 {"reason":"identity_unavailable"}, not written; operator token 200; issuer back: account 200, Create 200 owned by ${identity('owner', PERSON)}; discovery read ${String(issuer.reads.discovery)}, keys ${String(issuer.reads.keys)}`)
})

test('L178 a configuration that does not fit: the server does not start, saying why, a token never shown', async (t) => {
  const db = await database()
  const c = await cluster()
  const dir = mkdtempSync(join(tmpdir(), 'agora-tokens-'))
  t.after(async () => {
    await c.close()
    await db.drop()
    rmSync(dir, { recursive: true, force: true })
  })
  const secret = randomBytes(32).toString('base64url')
  const folder = (files: Record<string, string>) => {
    const at = mkdtempSync(join(dir, 'case-'))
    for (const [name, content] of Object.entries(files)) writeFileSync(join(at, name), content)
    return at
  }
  const oidc = { IDENTITY: 'oidc', IDENTITY_ISSUER: 'https://id.example.org', IDENTITY_AUDIENCE: AUDIENCE }
  const cases: [string, Record<string, string>, RegExp][] = [
    ['IDENTITY left out', { IDENTITY: '' }, /IDENTITY must be none or oidc/],
    ['IDENTITY another word', { IDENTITY: 'proxy' }, /IDENTITY must be none or oidc/],
    ['oidc without an issuer', { IDENTITY: 'oidc', IDENTITY_AUDIENCE: AUDIENCE }, /IDENTITY_ISSUER is required with IDENTITY=oidc/],
    ['oidc without an audience', { IDENTITY: 'oidc', IDENTITY_ISSUER: 'https://id.example.org' }, /IDENTITY_AUDIENCE is required with IDENTITY=oidc/],
    ['none with an issuer', { IDENTITY: 'none', IDENTITY_ISSUER: 'https://id.example.org' }, /IDENTITY_ISSUER: only with IDENTITY=oidc/],
    ['a token file not JSON', { ...oidc, IDENTITY_TOKENS_DIR: folder({ broken: `{"token":"${secret}"` }) }, /service token broken: not a JSON object/],
    ['a token too short', { ...oidc, IDENTITY_TOKENS_DIR: folder({ short: JSON.stringify({ token: 'short', email: PERSON }) }) }, /service token short: a token of at least 32 printable characters is required/],
    ['neither email nor owner', { ...oidc, IDENTITY_TOKENS_DIR: folder({ nobody: JSON.stringify({ token: secret }) }) }, /service token nobody: either email or owner is required/],
    ['two files, one token', { ...oidc, IDENTITY_TOKENS_DIR: folder({ a: JSON.stringify({ token: secret, email: PERSON }), b: JSON.stringify({ token: secret, owner: CASES }) }) }, /service token b: the same token as a/],
  ]
  const seen: string[] = []
  for (const [name, env, reason] of cases) {
    const error = await Server.start({ db, api: c.api, keys: c.keys, env }).then(
      async (s) => {
        await s.stop()
        return null
      },
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    assert.ok(error !== null, `${name}: started`)
    assert.match(error, reason, name)
    assert.doesNotMatch(error, /server ready on/, `${name}: listened`)
    assert.ok(!error.includes(secret), `${name}: the token shown`)
    seen.push(`${name}: ${reason.source}`)
  }
  // A preview's identity is `none`: IDENTITY oidc refused before its database is reached; `none` not.
  const preview = async (value: string) => {
    const child = spawn(process.execPath, [MAIN], {
      env: { PATH: String(process.env.PATH), HOME: String(process.env.HOME), PREVIEW: 'true', IDENTITY: value, PREVIEW_DATABASE_URL: 'postgresql://agora:agora@127.0.0.1:1/agora', PORT: '0', ANCHOR_PORT: '0', MCP_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    return { code, output }
  }
  const refused = await preview('oidc')
  assert.equal(refused.code, 1)
  assert.match(refused.output, /PREVIEW excludes IDENTITY/)
  const taken = await preview('none')
  assert.doesNotMatch(taken.output, /PREVIEW excludes/)
  t.diagnostic(`${seen.join('; ')}; each exit before listening, the secret never in the output; PREVIEW with IDENTITY oidc: exit ${String(refused.code)}, "PREVIEW excludes IDENTITY"; with none: no exclusion (exit ${String(taken.code)} on the unreachable database)`)
})
