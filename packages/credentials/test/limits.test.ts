// The accounts' limits (docs/specs/credentials.md, "Limits", C32 and C34–C37): each provider's answer read
// into windows, the grant Agora gives itself, the reads it keeps, and a real GET through a stand-in gateway.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { compileProfile, getThroughGateway, GrantSigner, LIMIT_ENDPOINTS, limitsHttp, ProfileRefused, SubscriptionLimits, type GatewayGet } from '../src/index.ts'

/** Answers as each provider did on 2026-10-07 (identifiers left out). */
const ANSWERS: Record<string, unknown> = {
  anthropic: {
    five_hour: { utilization: 7.0, resets_at: '2026-10-07T11:59:59.706843+00:00' },
    seven_day: { utilization: 19.0, resets_at: '2026-10-08T15:59:59.706867+00:00' },
    seven_day_oauth_apps: null,
    extra_usage: { is_enabled: false },
  },
  chatgpt: {
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 16000, reset_at: 1791378317 },
      secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_after_seconds: 600000, reset_at: 1791965117 },
    },
  },
  zai: {
    code: 200,
    data: {
      level: 'lite',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 0, remaining: 2000, percentage: 0 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 6, remaining: 9993, percentage: 1, nextResetTime: 1791750440984 },
        { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 2, percentage: 2 },
      ],
    },
  },
}

function signer(): GrantSigner {
  const dir = mkdtempSync(join(tmpdir(), 'limits-'))
  const keyFile = join(dir, 'grants.pem')
  writeFileSync(keyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  return new GrantSigner({ proxy: 'gateway.test:3000', keyFile, keyId: 'test', issuer: 'agora', audience: 'agora-gateway' })
}

const payload = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>

describe('each provider', () => {
  it('C36 Claude: the 5-hour and the week, in percent, with their resets', () => {
    assert.deepEqual(LIMIT_ENDPOINTS.anthropic!.read(ANSWERS.anthropic), {
      windows: [
        { kind: 'five_hour', usedPercent: 7, resetsAt: '2026-10-07T11:59:59.706Z' },
        { kind: 'weekly', usedPercent: 19, resetsAt: '2026-10-08T15:59:59.706Z' },
      ],
      plan: null,
    })
  })

  it('C36 ChatGPT: the windows told apart by their length, and the plan', () => {
    assert.deepEqual(LIMIT_ENDPOINTS.chatgpt!.read(ANSWERS.chatgpt), {
      windows: [
        { kind: 'five_hour', usedPercent: 12, resetsAt: new Date(1791378317 * 1000).toISOString() },
        { kind: 'weekly', usedPercent: 3, resetsAt: new Date(1791965117 * 1000).toISOString() },
      ],
      plan: 'plus',
    })
  })

  it('C36 z.ai: unit 3 the 5-hour window, not started yet; unit 6 the week; the MCP limit left out', () => {
    assert.deepEqual(LIMIT_ENDPOINTS.zai!.read(ANSWERS.zai), {
      windows: [
        { kind: 'five_hour', usedPercent: 0, resetsAt: null },
        { kind: 'weekly', usedPercent: 1, resetsAt: new Date(1791750440984).toISOString() },
      ],
      plan: 'lite',
    })
  })

  it('C36 an answer of another shape gives no window', () => {
    for (const endpoint of Object.values(LIMIT_ENDPOINTS)) assert.deepEqual(endpoint.read({ error: 'nope' }).windows, [])
  })
})

describe('the grant Agora gives itself', () => {
  it('C32 limits: a GET on each usage endpoint, exactly, bound to the server', async () => {
    const credentials = await signer().mint({ label: 'limits', ttlSeconds: 300, profiles: ['limits'], address: '10.244.0.9' })
    const claims = payload(credentials.token)
    assert.equal(claims.ip, '10.244.0.9')
    const grants = claims.grants as { host: string; path: string; methods: string[] }[]
    assert.deepEqual(grants.map((g) => [g.host, g.methods]), [['api.anthropic.com', ['GET']], ['chatgpt.com', ['GET']], ['api.z.ai', ['GET']]])
    // The gateway's rule, replayed: host, path with the query, method.
    const allowed = (host: string, path: string, method = 'GET') => grants.some((g) => g.host === host && new RegExp(g.path).test(path) && g.methods.includes(method))
    assert.ok(allowed('api.anthropic.com', '/api/oauth/usage'))
    assert.ok(allowed('chatgpt.com', '/backend-api/wham/usage'))
    assert.ok(allowed('api.z.ai', '/api/monitor/usage/quota/limit'))
    assert.ok(!allowed('api.anthropic.com', '/api/oauth/usage?x=1'))
    assert.ok(!allowed('api.anthropic.com', '/v1/messages'))
    assert.ok(!allowed('chatgpt.com', '/backend-api/wham/usage/other'))
    assert.ok(!allowed('api.anthropic.com', '/api/oauth/usage', 'POST'))
    assert.ok(!allowed('api.z.ai', '/api/monitor/usage/quota/limit', 'DELETE'))
  })

  it('the catalogue does not know it: never an execution\'s', () => {
    assert.throws(() => compileProfile('limits'), ProfileRefused)
  })
})

/** A SubscriptionLimits whose gateway is `answer`, on a clock the test moves. */
function limitsWith(answer: (input: GatewayGet) => Promise<{ status: number; body: string }>, profiles = ['anthropic', 'chatgpt', 'zai', 'github:o/r:read']) {
  const clock = { now: Date.parse('2026-10-07T10:00:00Z') }
  const calls: GatewayGet[] = []
  const limits = new SubscriptionLimits({
    signer: signer(),
    address: '10.244.0.9',
    profiles: async () => profiles,
    now: () => clock.now,
    get: async (input) => {
      calls.push(input)
      return answer(input)
    },
  })
  return { limits, calls, clock }
}

const byHost = (input: GatewayGet) => Object.entries(LIMIT_ENDPOINTS).find(([, e]) => e.host === input.host)![0]

describe('the reads', () => {
  it('C34 each base profile with an endpoint, once per 5 minutes, one read at a time', async () => {
    const { limits, calls, clock } = limitsWith(async (input) => ({ status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }))
    const [first] = await Promise.all([limits.read(), limits.read()])
    assert.deepEqual(Object.keys(first).sort(), ['anthropic', 'chatgpt', 'zai'], 'a repository has no limits')
    assert.equal(calls.length, 3)
    assert.equal(calls[0]!.proxy, 'gateway.test:3000')
    assert.equal(payload(calls[0]!.token).sub, 'agora limits')
    assert.deepEqual(first.anthropic!.windows.map((w) => w.usedPercent), [7, 19])
    assert.deepEqual([first.anthropic!.stale, first.anthropic!.error, first.anthropic!.checkedAt], [false, null, '2026-10-07T10:00:00.000Z'])
    clock.now += 4 * 60_000
    await limits.read()
    assert.equal(calls.length, 3, 'within 5 minutes: the same')
    clock.now += 60_000
    await limits.read()
    assert.equal(calls.length, 6, 'after: read again')
  })

  it('C35 a failed read keeps the windows before it, stale, with why', async () => {
    let failing = false
    const { limits, clock } = limitsWith(async (input) => (failing && byHost(input) === 'chatgpt' ? { status: 403, body: '{}' } : { status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }))
    await limits.read()
    failing = true
    clock.now += 5 * 60_000
    const after = await limits.read()
    assert.deepEqual([after.chatgpt!.stale, after.chatgpt!.error, after.chatgpt!.checkedAt], [true, 'chatgpt.com answered 403', '2026-10-07T10:00:00.000Z'])
    assert.deepEqual(after.chatgpt!.windows.map((w) => w.usedPercent), [12, 3])
    assert.equal(after.anthropic!.stale, false)
  })

  it('C35 never read: no window, and why', async () => {
    const { limits } = limitsWith(async () => {
      throw new Error('the gateway refused the tunnel: 403')
    })
    const read = await limits.read()
    assert.deepEqual(read.zai, { windows: [], plan: null, checkedAt: null, stale: true, error: 'the gateway refused the tunnel: 403' })
  })

  it('C35 a window whose reset has passed holds nothing, until the next read', async () => {
    const { limits, clock } = limitsWith(async (input) => ({ status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }))
    await limits.read()
    clock.now = Date.parse('2026-10-07T12:01:00Z')
    const read = await limits.read()
    assert.deepEqual(read.anthropic!.windows[0], { kind: 'five_hour', usedPercent: 0, resetsAt: null })
    assert.equal(read.anthropic!.windows[1]!.usedPercent, 19)
  })
})

describe('GET /api/limits', () => {
  it('C34 the limits by profile; nothing when the server cannot read them; GET only', async () => {
    const { limits } = limitsWith(async (input) => ({ status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }), ['anthropic'])
    const server = createHttpServer((req, res) => {
      void limitsHttp(req.url === '/off/api/limits' ? undefined : limits, Object.assign(req, { url: req.url?.replace('/off', '') }), res).then((handled) => handled || res.writeHead(404).end())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const call = async (method: string, path: string) => {
      const answer = await fetch(`http://127.0.0.1:${String(port)}${path}`, { method })
      return { status: answer.status, body: (await answer.json()) as Record<string, unknown> }
    }
    try {
      const on = await call('GET', '/api/limits')
      assert.equal(on.status, 200)
      assert.deepEqual(Object.keys(on.body.limits as object), ['anthropic'])
      assert.deepEqual(await call('GET', '/off/api/limits'), { status: 200, body: { limits: {} } })
      assert.equal((await call('POST', '/api/limits')).status, 405)
    } finally {
      server.close()
    }
  })
})

let openssl = true
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' })
} catch {
  openssl = false
}

describe('through a gateway', { skip: !openssl && 'openssl is needed to make the test certificate' }, () => {
  it('C37 CONNECT with the grant, TLS to the host, the placeholder and the endpoint\'s headers; a refused tunnel is an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'limits-tls-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=api.anthropic.com', '-addext', 'subjectAltName=DNS:api.anthropic.com', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf8')
    const seen: Record<string, unknown>[] = []
    const upstream = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
      seen.push({ path: req.url, authorization: req.headers.authorization, beta: req.headers['anthropic-beta'] })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ANSWERS.anthropic))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const tunnels: string[] = []
    const sockets: { destroy(): void }[] = []
    const gateway = createHttpServer()
    gateway.on('connect', (req, client) => {
      sockets.push(client)
      tunnels.push(`${String(req.url)} ${String(req.headers['proxy-authorization'])}`)
      if (req.headers['proxy-authorization'] !== 'Bearer grant') return client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      const out = connect((upstream.address() as AddressInfo).port, '127.0.0.1', () => {
        sockets.push(out)
        client.write('HTTP/1.1 200 Connection established\r\n\r\n')
        out.pipe(client)
        client.pipe(out)
      })
    })
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    const proxy = `127.0.0.1:${String((gateway.address() as AddressInfo).port)}`
    const endpoint = LIMIT_ENDPOINTS.anthropic!
    try {
      const answer = await getThroughGateway({ proxy, token: 'grant', host: endpoint.host, path: endpoint.path, headers: endpoint.headers, timeoutMs: 5000, ca: cert })
      assert.equal(answer.status, 200)
      assert.deepEqual(JSON.parse(answer.body), ANSWERS.anthropic)
      assert.deepEqual(tunnels, ['api.anthropic.com:443 Bearer grant'])
      assert.deepEqual(seen, [{ path: '/api/oauth/usage', authorization: 'Bearer agora-placeholder', beta: 'oauth-2025-04-20' }])
      await assert.rejects(getThroughGateway({ proxy, token: 'other', host: endpoint.host, path: endpoint.path, headers: {}, timeoutMs: 5000, ca: cert }), /refused the tunnel: 403/)
    } finally {
      for (const socket of sockets) socket.destroy()
      gateway.close()
      upstream.closeAllConnections()
      upstream.close()
    }
  })
})
