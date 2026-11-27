// The accounts' limits (docs/specs/credentials.md, "Limits", C32, C34–C37, C84, C85 and C87): each provider's answer
// read into windows, the grant Agora gives itself, the reads it keeps, Google's two requests, and a real GET and POST
// through a stand-in gateway.
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
import { compileProfile, getThroughGateway, GrantSigner, LIMIT_ENDPOINTS, LIMITS_NOT_READ, LIMITS_WITHOUT_POOL, limitsHttp, ProfileRefused, SubscriptionLimits, type GatewayGet } from '../src/index.ts'

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

/**
 * Xiaomi's documented answer, verbatim: "Query Token Plan Credits", mimo.mi.com/docs/en-US/api/asset/credits-get,
 * as read on 2026-11-27. Its period's times are UTC, written without a zone.
 */
const XIAOMI = {
  object: 'token_plan',
  plan_code: 'pro',
  period: { start_at: '2026-09-21 23:59:59', end_at: '2027-09-21 23:59:59' },
  quota: { total_credits: 10000000, used_credits: 1500000, remaining_credits: 8500000 },
  auto_renew: false,
  claw_enabled: false,
}
ANSWERS.xiaomi = XIAOMI

/**
 * Google's quota summary (`POST daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`), as a Google AI
 * Pro account's was captured on 2026-10-20, sanitized, by token-monitor (github.com/Javis603/token-monitor, commit
 * 6d13b00, tests/fixtures/antigravityQuotaSummaryArgon.json, `daily`): the fields of agy 1.5.13's quota_summary.proto.
 * Its 5-hour buckets, untouched, reset 5 hours after the capture, its untouched weeks 7 days after: Google's way of
 * saying no window has started.
 */
const GOOGLE_SUMMARY = {
  groups: [
    {
      buckets: [
        { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-10-25T04:15:26Z', description: 'You have used some of your weekly limit, it will fully refresh in 4 days, 16 hours.', remainingFraction: 0.99242824 },
        { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-10-20T16:40:42Z', remainingFraction: 1 },
      ],
      displayName: 'Gemini Models',
      description: 'Models within this group: Gemini Flash, Gemini Pro',
    },
    {
      buckets: [
        { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-10-27T11:40:42Z', remainingFraction: 1 },
        { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-10-20T16:40:42Z', remainingFraction: 1 },
      ],
      displayName: 'Claude and GPT models',
      description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
    },
    {
      buckets: [{ bucketId: 'gemini-argon-wtu-weekly', displayName: 'Gemini 4 Argon Weekly Limit', window: 'weekly', resetTime: '2026-10-27T11:40:42Z', remainingFraction: 1 }],
      displayName: 'Gemini 4 Argon',
      description: 'For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.',
    },
  ],
  description: 'Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens.',
}

/** What `loadCodeAssist` answers that the quota needs: the account's project (CVERInc/clikae #159, measured 2026-09-27). */
const GOOGLE_ASSIST = { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'example-project-12345' }

/** The same summary with the Gemini 5-hour window three quarters spent, and the week's 5-hour bucket of the other group disabled. */
const GOOGLE_SPENT = {
  groups: [
    { displayName: 'Gemini Models', buckets: [{ ...GOOGLE_SUMMARY.groups[0]!.buckets[0]! }, { bucketId: 'gemini-5h', window: '5h', resetTime: '2026-10-20T13:02:07Z', remainingFraction: 0.25 }] },
    { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-5h', window: '5h', disabled: true, remainingFraction: 0, resetTime: '2026-10-20T13:02:07Z' }] },
  ],
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

  it('C36 Gemini: the Gemini group\'s 5-hour and weekly buckets, what remainingFraction leaves used; an untouched window without a reset', () => {
    assert.deepEqual(LIMIT_ENDPOINTS.antigravity!.read(GOOGLE_SUMMARY), {
      windows: [
        { kind: 'five_hour', usedPercent: 0, resetsAt: null },
        { kind: 'weekly', usedPercent: 0.76, resetsAt: '2026-10-25T04:15:26.000Z' },
      ],
      plan: null,
    })
    assert.deepEqual(LIMIT_ENDPOINTS.antigravity!.read(GOOGLE_SPENT).windows, [
      { kind: 'five_hour', usedPercent: 75, resetsAt: '2026-10-20T13:02:07.000Z' },
      { kind: 'weekly', usedPercent: 0.76, resetsAt: '2026-10-25T04:15:26.000Z' },
    ])
    const disabled = { groups: [{ buckets: [{ ...GOOGLE_SPENT.groups[0]!.buckets[1]!, disabled: true }, { bucketId: 'gemini-weekly', resetTime: '2026-10-25T04:15:26Z' }] }] }
    assert.deepEqual(LIMIT_ENDPOINTS.antigravity!.read(disabled).windows, [], 'a disabled bucket, and one without its fraction: no window')
  })

  it('C88 Gemini, in the other shapes Google\'s answer is read in: wrapped, the deprecated buckets, the window named otherwise, the oneof written by protobuf-es', () => {
    const gemini = (buckets: unknown[]) => ({ groups: [{ displayName: 'Gemini Models', buckets }] })
    const read = (body: unknown) => LIMIT_ENDPOINTS.antigravity!.read(body).windows
    const spent = [
      { kind: 'five_hour', usedPercent: 75, resetsAt: '2026-10-20T13:02:07.000Z' },
      { kind: 'weekly', usedPercent: 0.76, resetsAt: '2026-10-25T04:15:26.000Z' },
    ]
    // In `response` or `summary`, as CodexBar's and token-monitor's readers take it.
    assert.deepEqual(read({ response: GOOGLE_SPENT }), spent)
    assert.deepEqual(read({ summary: GOOGLE_SPENT }), spent)
    // The deprecated top-level buckets of quota_summary.proto, Gemini's by their id.
    assert.deepEqual(read({ buckets: [...GOOGLE_SPENT.groups[0]!.buckets, { bucketId: '3p-5h', window: '5h', remainingFraction: 0 }] }), spent)
    // In the Gemini group, the window from `window`, else the id, else the name: other ids (CodexBar's and token-monitor's
    // readers), none at all, names alone ("Weekly", "Five-Hour": pingdotgg/t3code #21020).
    assert.deepEqual(read(gemini([{ bucketId: 'gemini-pro-quota', window: 'session', remainingFraction: 0.25, resetTime: '2026-10-20T13:02:07Z' }, { bucketId: 'gemini_weekly', remainingFraction: 0.5, resetTime: '2026-10-25T04:15:26Z' }])), [
      { kind: 'five_hour', usedPercent: 75, resetsAt: '2026-10-20T13:02:07.000Z' },
      { kind: 'weekly', usedPercent: 50, resetsAt: '2026-10-25T04:15:26.000Z' },
    ])
    assert.deepEqual(read(gemini([{ displayName: 'Five-Hour', remainingFraction: 0.9, resetTime: '2026-10-20T13:02:07Z' }, { displayName: 'Weekly', remainingFraction: 0.8, resetTime: '2026-10-25T04:15:26Z' }])).map((w) => [w.kind, w.usedPercent]), [['five_hour', 10], ['weekly', 20]])
    assert.deepEqual(read(gemini([{ displayName: 'Five Hour Limit Remaining', remainingFraction: 1 }, { bucketId: 'gemini-5h limit', remainingFraction: 0.5 }])).map((w) => [w.kind, w.usedPercent]), [['five_hour', 50]], 'two buckets of one window: the more spent')
    // The oneof as protobuf-es writes it.
    assert.deepEqual(read(gemini([{ bucketId: 'gemini-weekly', remaining: { remainingFraction: 0.5 } }, { bucketId: 'gemini-5h', remaining: { case: 'remainingFraction', value: 0.25 } }])).map((w) => w.usedPercent), [75, 50])
    // Not Gemini's, not a window, or no fraction: nothing.
    for (const body of [
      { groups: [GOOGLE_SUMMARY.groups[1], GOOGLE_SUMMARY.groups[2]] },
      gemini([{ bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 0.5 }, { bucketId: 'gemini-daily', window: 'daily', remainingFraction: 0.5 }, { bucketId: 'gemini-session-history', remainingFraction: 0.5 }]),
      gemini([{ bucketId: 'gemini-weekly', remainingAmount: 40 }, { bucketId: 'gemini-5h', remaining: { case: 'remainingAmount', value: 0.5 } }]),
      { groups: [{ displayName: 'All Models', buckets: [{ bucketId: 'gemini-pro', remainingFraction: 1 }] }] },
    ]) assert.deepEqual(read(body), [], JSON.stringify(body))
  })

  it('C85 Xiaomi MiMo: the billing period alone, the credits used of its total, until its end in UTC, and the plan', () => {
    assert.deepEqual(LIMIT_ENDPOINTS.xiaomi!.read(XIAOMI), { windows: [{ kind: 'period', usedPercent: 15, resetsAt: '2027-09-21T23:59:59.000Z' }], plan: 'pro' })
    // A month of a Lite plan, part spent: used over total, unrounded.
    const lite = { ...XIAOMI, plan_code: 'lite', period: { start_at: '2026-11-11 21:05:27', end_at: '2026-12-11 23:59:59' }, quota: { total_credits: 4100000000, used_credits: 1400000000, remaining_credits: 2700000000 } }
    assert.deepEqual(LIMIT_ENDPOINTS.xiaomi!.read(lite), { windows: [{ kind: 'period', usedPercent: (1400000000 / 4100000000) * 100, resetsAt: '2026-12-11T23:59:59.000Z' }], plan: 'lite' })
    assert.deepEqual(LIMIT_ENDPOINTS.xiaomi!.read({ ...XIAOMI, quota: { total_credits: 0, used_credits: 0, remaining_credits: 0 } }), { windows: [], plan: null }, 'no credit: no window')
    assert.deepEqual(LIMIT_ENDPOINTS.xiaomi!.read({ ...XIAOMI, quota: { total_credits: 100, used_credits: 130, remaining_credits: 0 } }).windows[0]!.usedPercent, 100, 'overspent: 100 %')
    assert.deepEqual(LIMIT_ENDPOINTS.xiaomi!.read({ ...XIAOMI, period: { start_at: '2026-09-21 23:59:59', end_at: 'next year' } }).windows, [{ kind: 'period', usedPercent: 15, resetsAt: null }], 'an end it cannot read: no reset')
    assert.deepEqual(LIMIT_ENDPOINTS.xiaomi!.read({ ...XIAOMI, object: 'error' }).windows, [], 'not a token plan: no window')
  })

  it('C36 an answer of another shape gives no window', () => {
    for (const endpoint of Object.values(LIMIT_ENDPOINTS)) assert.deepEqual(endpoint.read({ error: 'nope' }).windows, [])
  })
})

describe('the grant Agora gives itself', () => {
  it('C32 limits: each usage endpoint\'s exact path, with its method alone, bound to the server', async () => {
    const credentials = await signer().mint({ label: 'limits', ttlSeconds: 300, profiles: ['limits'], address: '10.244.0.9' })
    const claims = payload(credentials.token)
    assert.equal(claims.ip, '10.244.0.9')
    const grants = claims.grants as { host: string; path: string; methods: string[] }[]
    assert.deepEqual(grants.map((g) => [g.host, g.methods]), [
      ['api.anthropic.com', ['GET']],
      ['chatgpt.com', ['GET']],
      ['token-plan-ams.xiaomimimo.com', ['GET']],
      ['api.z.ai', ['GET']],
      ['daily-cloudcode-pa.googleapis.com', ['POST']],
      ['daily-cloudcode-pa.googleapis.com', ['POST']],
    ])
    // The gateway's rule, replayed: host, path with the query, method.
    const allowed = (host: string, path: string, method = 'GET') => grants.some((g) => g.host === host && new RegExp(g.path).test(path) && g.methods.includes(method))
    assert.ok(allowed('api.anthropic.com', '/api/oauth/usage'))
    assert.ok(allowed('chatgpt.com', '/backend-api/wham/usage'))
    assert.ok(allowed('api.z.ai', '/api/monitor/usage/quota/limit'))
    assert.ok(allowed('token-plan-ams.xiaomimimo.com', '/v1/platform/token_plan'))
    assert.ok(allowed('daily-cloudcode-pa.googleapis.com', '/v1internal:loadCodeAssist', 'POST'))
    assert.ok(allowed('daily-cloudcode-pa.googleapis.com', '/v1internal:retrieveUserQuotaSummary', 'POST'))
    assert.ok(!allowed('daily-cloudcode-pa.googleapis.com', '/v1internal:retrieveUserQuotaSummary'))
    assert.ok(!allowed('daily-cloudcode-pa.googleapis.com', '/v1internal:streamGenerateContent?alt=sse', 'POST'))
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
    assert.deepEqual(Object.keys(first).sort(), ['anthropic', 'chatgpt', 'xiaomi'], 'a repository has no limits, z.ai is not read; xiaomi, no pool\'s, beside them (C87)')
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

  it('C34 z.ai, declared by a pool as in production, is not read: never asked, not in the answer, its reader kept', async () => {
    assert.deepEqual([...LIMITS_NOT_READ], ['zai'])
    assert.ok(Object.hasOwn(LIMIT_ENDPOINTS, 'zai'), 'its endpoint stays, to be read again')
    // Every gateway answer is a good one, z.ai's too: had it been asked, it would have read.
    const { limits, calls, clock } = limitsWith(async (input) => ({ status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }), ['anthropic', 'chatgpt', 'zai'])
    const read = await limits.read()
    assert.deepEqual(Object.keys(read).sort(), ['anthropic', 'chatgpt', 'xiaomi'])
    assert.deepEqual(calls.map((c) => c.host).sort(), ['api.anthropic.com', 'chatgpt.com', 'token-plan-ams.xiaomimimo.com'], 'the others asked, z.ai never')
    clock.now += 5 * 60_000
    assert.equal((await limits.read()).zai, undefined, 'nor at the next read')
    assert.ok(calls.every((c) => c.host !== 'api.z.ai'))
    assert.equal(calls.length, 6)
  })

  it('C87 xiaomi is read though no pool draws from it; the other accounts only as the pools declare them', async () => {
    assert.deepEqual(LIMITS_WITHOUT_POOL, ['xiaomi'])
    const answer = async (input: GatewayGet) => ({ status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) })
    // Pools on `chatgpt` and a repository's profile: no pool declares xiaomi, nor Claude.
    const { limits, calls } = limitsWith(answer, ['chatgpt', 'github:o/r:read'])
    const read = await limits.read()
    assert.deepEqual(Object.keys(read), ['chatgpt', 'xiaomi'])
    assert.deepEqual(calls.map((c) => [c.host, c.path]).sort(), [['chatgpt.com', '/backend-api/wham/usage'], ['token-plan-ams.xiaomimimo.com', '/v1/platform/token_plan']], 'Claude never asked: no pool declares it')
    const asked = calls.find((c) => c.host === 'token-plan-ams.xiaomimimo.com')!
    assert.deepEqual([payload(asked.token).sub, asked.headers], ['agora limits', {}], 'under the limits grant, no header of its own')
    assert.deepEqual(read.xiaomi, { windows: [{ kind: 'period', usedPercent: 15, resetsAt: '2027-09-21T23:59:59.000Z' }], plan: 'pro', checkedAt: '2026-10-07T10:00:00.000Z', stale: false, error: null })
    // The control: a pool declaring Claude has it read; a pool declaring xiaomi too reads it once.
    const both = limitsWith(answer, ['anthropic', 'xiaomi'])
    assert.deepEqual(Object.keys(await both.limits.read()), ['anthropic', 'xiaomi'])
    assert.equal(both.calls.length, 2)
    // No pool at all: xiaomi still; z.ai, not read, never, even beside it.
    const none = limitsWith(answer, [])
    assert.deepEqual(Object.keys(await none.limits.read()), ['xiaomi'])
    assert.deepEqual(none.calls.map((c) => c.host), ['token-plan-ams.xiaomimimo.com'])
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
    assert.deepEqual(read.chatgpt, { windows: [], plan: null, checkedAt: null, stale: true, error: 'the gateway refused the tunnel: 403' })
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

describe('Google\'s two requests', () => {
  const google = (assist: { status: number; body: unknown }, summary: unknown = GOOGLE_SUMMARY) => {
    // Google's requests alone: xiaomi, read beside it whatever the pools declare (C87), is answered and left out.
    const calls: GatewayGet[] = []
    const { limits } = limitsWith(async (input) => {
      if (input.host !== 'daily-cloudcode-pa.googleapis.com') return { status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }
      calls.push(input)
      if (input.path === '/v1internal:loadCodeAssist') return { status: assist.status, body: JSON.stringify(assist.body) }
      return { status: 200, body: JSON.stringify(summary) }
    }, ['antigravity'])
    return { limits, calls }
  }

  it('C84 loadCodeAssist, then the quota summary for the project it names, both POSTs as Antigravity; without a project, no summary asked', async () => {
    const { limits, calls } = google({ status: 200, body: GOOGLE_ASSIST })
    const read = await limits.read()
    assert.deepEqual(
      calls.map((c) => [c.host, c.method, c.path, c.body === undefined ? undefined : JSON.parse(c.body), c.headers['user-agent']]),
      [
        ['daily-cloudcode-pa.googleapis.com', 'POST', '/v1internal:loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY', platform: 'LINUX_AMD64', pluginType: 'GEMINI' } }, 'antigravity/1.5.13 linux/amd64'],
        ['daily-cloudcode-pa.googleapis.com', 'POST', '/v1internal:retrieveUserQuotaSummary', { project: 'example-project-12345' }, 'antigravity/1.5.13 linux/amd64'],
      ],
    )
    assert.equal(payload(calls[0]!.token).sub, 'agora limits')
    assert.deepEqual([read.antigravity!.stale, read.antigravity!.error, read.antigravity!.windows.map((w) => w.usedPercent)], [false, null, [0, 0.76]])

    const object = google({ status: 200, body: { cloudaicompanionProject: { id: 'project-as-object' } } })
    await object.limits.read()
    assert.deepEqual(object.calls.map((c) => c.body === undefined ? undefined : JSON.parse(c.body)).at(-1), { project: 'project-as-object' }, 'the project as an object')

    const none = google({ status: 200, body: { currentTier: { id: 'free-tier' } } })
    const unnamed = await none.limits.read()
    assert.deepEqual(none.calls.map((c) => c.path), ['/v1internal:loadCodeAssist'])
    assert.deepEqual(unnamed.antigravity, { windows: [], plan: null, checkedAt: null, stale: true, error: 'loadCodeAssist named no project: currentTier "free-tier", paidTier none, no project, fields {currentTier}' })

    const refused = google({ status: 403, body: { error: { code: 403 } } })
    const denied = await refused.limits.read()
    assert.deepEqual(refused.calls.map((c) => c.path), ['/v1internal:loadCodeAssist'])
    assert.equal(denied.antigravity!.error, 'daily-cloudcode-pa.googleapis.com answered 403 to /v1internal:loadCodeAssist')
  })

  it('C89 a summary with no Gemini window: the error names what loadCodeAssist and the summary held, never a value of the account\'s', async () => {
    // The shared consumer project's summary, the Claude and GPT models' week alone (pingdotgg/t3code #21020), for a
    // free tier; a bucket's name carrying an email, the project and a token, which the error withholds.
    const assist = { currentTier: { id: 'free-tier', name: 'Antigravity' }, paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' }, cloudaicompanionProject: 'aicode-consumers', gcpManaged: false }
    const summary = {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-11-30T10:00:00Z', remainingFraction: 0.5, description: 'it will fully refresh in 3 days' },
            { bucketId: '3p-5h', displayName: 'person@example.com', window: '5h', disabled: true },
          ],
        },
        { displayName: 'aicode-consumers', buckets: [{ bucketId: 'ya29.a0AfB_secret', window: 'weekly', remainingAmount: 40 }] },
      ],
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
    }
    const { limits } = google({ status: 200, body: assist }, summary)
    const read = await limits.read()
    assert.deepEqual([read.antigravity!.windows, read.antigravity!.stale], [[], true])
    assert.equal(
      read.antigravity!.error,
      'daily-cloudcode-pa.googleapis.com gave no window: loadCodeAssist currentTier "free-tier", paidTier "g1-pro-tier", Google\'s shared consumer project, fields {currentTier, paidTier, cloudaicompanionProject, gcpManaged}; ' +
        'summary fields {groups, description}; groups "Claude and GPT models" [' +
        '"3p-weekly" (window "weekly", remainingFraction 0.5, displayName "Weekly Limit Remaining", fields {bucketId, displayName, window, resetTime, remainingFraction, description}); ' +
        '"3p-5h" (window "5h", remainingFraction none, disabled true, displayName withheld, fields {bucketId, displayName, window, disabled})] | ' +
        'withheld [withheld (window "weekly", remainingFraction none, fields {bucketId, window, remainingAmount})]',
    )
    for (const secret of ['person@example.com', 'aicode-consumers', 'ya29', 'Google AI Pro', 'refresh in']) assert.ok(!read.antigravity!.error!.includes(secret), secret)

    // The account's own project, in a bucket's id: withheld too. The placeholder a wrong OAuth client gets — All Models,
    // one bucket per model, no window (steipete/CodexBar #4293) — named as such.
    const own = google({ status: 200, body: { currentTier: { id: 'standard-tier' }, cloudaicompanionProject: { id: 'own-project-4821' } } }, {
      groups: [{ displayName: 'All Models', buckets: [{ bucketId: 'gemini-pro', remainingFraction: 1 }, { bucketId: 'own-project-4821-claude', remainingFraction: 1 }] }],
    })
    const placeholder = (await own.limits.read()).antigravity!.error!
    assert.equal(
      placeholder,
      'daily-cloudcode-pa.googleapis.com gave no window: loadCodeAssist currentTier "standard-tier", paidTier none, the account\'s own project, fields {currentTier, cloudaicompanionProject}; ' +
        'summary fields {groups}; groups "All Models" [' +
        '"gemini-pro" (window none, remainingFraction 1, fields {bucketId, remainingFraction}); withheld (window none, remainingFraction 1, fields {bucketId, remainingFraction})]',
    )
    assert.ok(!placeholder.includes('own-project-4821'))

    // Without a project: the tiers Google refuses the account, and why (steipete/CodexBar #4293).
    const refused = google({ status: 200, body: { ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT', reasonMessage: 'person@example.com may not' }] } })
    assert.equal(
      (await refused.limits.read()).antigravity!.error,
      'loadCodeAssist named no project: currentTier none, paidTier none, no project, ineligibleTiers "free-tier" "GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT", fields {ineligibleTiers}',
    )
  })
  it('C89 every value and name the error shows, under one rule: an email, a token, the project, in any field, hidden in any way, withheld', async () => {
    const project = 'own-project-4821'
    const email = 'person@example.com'
    const token = 'ya29.a0AfB_secret'
    const hostile = {
      ownproject4821: true,
      [email]: 1,
      groups: [
        { displayName: 'own\u200bproject4821', buckets: [{ bucketId: `quota ${token}`, window: 'own project 4821', disabled: email, displayName: 'OWN_PROJECT_4821' }] },
        { displayName: 'Claude and GPT models', buckets: [{ bucketId: 'gemini-5h', window: '5h', disabled: [project], remainingFraction: 'x', [`a${token}`]: 1, 'person%40example.com': 2 }] },
        { displayName: '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', buckets: [{ bucketId: 'x eyJhbGciOiJFZERTQSJ9 y', window: 'AIzaSyD', displayName: '1//0gRefresh' }, { bucketId: 'a8f3k29d0s7g6h5j4k3l2', displayName: `${'x'.repeat(65)}` }] },
      ],
    }
    const { limits } = google({ status: 200, body: { currentTier: { id: email }, paidTier: { id: token }, cloudaicompanionProject: project, [project]: 1, ineligibleTiers: [{ tierId: project, reasonCode: `${token} ${email}` }] } }, hostile)
    const error = (await limits.read()).antigravity!.error!
    assert.equal(
      error,
      'daily-cloudcode-pa.googleapis.com gave no window: loadCodeAssist currentTier withheld, paidTier withheld, the account\'s own project, ineligibleTiers withheld withheld, fields {currentTier, paidTier, cloudaicompanionProject, withheld, ineligibleTiers}; ' +
        'summary fields {withheld, withheld, groups}; groups withheld [withheld (window withheld, remainingFraction none, disabled not a boolean, displayName withheld, fields {bucketId, window, disabled, displayName})] | ' +
        '"Claude and GPT models" ["gemini-5h" (window "5h", remainingFraction none, disabled not a boolean, fields {bucketId, window, disabled, remainingFraction, withheld, withheld})] | ' +
        'withheld [withheld (window withheld, remainingFraction none, displayName withheld, fields {bucketId, window, displayName}); withheld (window none, remainingFraction none, displayName withheld, fields {bucketId, displayName})]',
    )
    const flat = error.toLowerCase().replace(/[^a-z0-9]/g, '')
    for (const secret of [project, email, token, 'GOCSPX', 'eyJ', 'AIza', '1//', 'a8f3k29d0s7g6h5j4k3l2']) {
      assert.ok(!error.includes(secret), secret)
      assert.ok(!flat.includes(secret.toLowerCase().replace(/[^a-z0-9]/g, '')), `${secret}, compacted`)
    }
  })
})

describe('GET /api/limits', () => {
  it('C34 the limits by profile; nothing when the server cannot read them; GET only', async () => {
    // The production catalogue: pools on `anthropic`, `chatgpt` and `zai`, and a repository's profile.
    const { limits } = limitsWith(async (input) => ({ status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }))
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
      assert.deepEqual(Object.keys(on.body.limits as object), ['anthropic', 'chatgpt', 'xiaomi'], 'no zai')
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
  it('C37 CONNECT with the grant, TLS to the host, the placeholder and the endpoint\'s headers, a POST\'s body; a refused tunnel is an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'limits-tls-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=api.anthropic.com', '-addext', 'subjectAltName=DNS:api.anthropic.com', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf8')
    const seen: Record<string, unknown>[] = []
    const upstream = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization, beta: req.headers['anthropic-beta'], ...(body === '' ? {} : { type: req.headers['content-type'], body }) })
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ANSWERS.anthropic))
      })
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
      assert.deepEqual(seen, [{ method: 'GET', path: '/api/oauth/usage', authorization: 'Bearer agora-placeholder', beta: 'oauth-2025-04-20' }])
      const posted = await getThroughGateway({ proxy, token: 'grant', host: endpoint.host, path: '/v1internal:retrieveUserQuotaSummary', headers: {}, timeoutMs: 5000, ca: cert, method: 'POST', body: '{"project":"p"}' })
      assert.equal(posted.status, 200)
      assert.deepEqual(seen[1], { method: 'POST', path: '/v1internal:retrieveUserQuotaSummary', authorization: 'Bearer agora-placeholder', beta: undefined, type: 'application/json', body: '{"project":"p"}' })
      await assert.rejects(getThroughGateway({ proxy, token: 'other', host: endpoint.host, path: endpoint.path, headers: {}, timeoutMs: 5000, ca: cert }), /refused the tunnel: 403/)
    } finally {
      for (const socket of sockets) socket.destroy()
      gateway.close()
      upstream.closeAllConnections()
      upstream.close()
    }
  })
})
