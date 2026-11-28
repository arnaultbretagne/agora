// The accounts' limits (docs/specs/credentials.md, "Limits", C32, C34–C37, C84, C85, C87–C92): each provider's answer
// read into windows, the grant Agora gives itself, the reads it keeps, Google's requests, and a real GET and POST
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
import { DIAGNOSTIC_FIELDS, DIAGNOSTIC_WORDS } from '../src/limits.ts'

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
    const disabled = { groups: [{ buckets: [{ ...GOOGLE_SPENT.groups[0]!.buckets[1]!, disabled: true }, { bucketId: 'gemini-weekly' }] }] }
    assert.deepEqual(LIMIT_ENDPOINTS.antigravity!.read(disabled).windows, [], 'a disabled bucket, and one without its fraction nor a reset: no window')
    // Without its fraction but with a reset time, a bucket is spent: proto3 JSON leaves a zero out (Omarchy's `used`).
    const spent = { groups: [{ buckets: [{ bucketId: 'gemini-weekly', resetTime: '2026-10-25T04:15:26Z' }] }] }
    assert.deepEqual(LIMIT_ENDPOINTS.antigravity!.read(spent).windows, [{ kind: 'weekly', usedPercent: 100, resetsAt: '2026-10-25T04:15:26.000Z' }], 'no fraction, a reset: spent')
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
      gemini([{ bucketId: 'gemini-weekly', remainingFraction: 1.5 }, { bucketId: 'gemini-5h', remainingFraction: -0.5 }]),
      { groups: [{ displayName: 'All Models', buckets: [{ bucketId: 'gemini-pro', remainingFraction: 1 }] }] },
    ]) assert.deepEqual(read(body), [], JSON.stringify(body))
  })

  it('C91 Gemini, on Omarchy\'s own summaries: the spent bucket without a fraction, the amount arm, snake case, the group wherever it is, the shapes that hold none', () => {
    // basecamp/omarchy at 7278346 (the parent of 0fae8e6, which removed the file), test/shell.d/agent-usage-agy-limits-test.sh,
    // lines 75–130: each `limits(...)` answer, the windows its `extract_limits` reads. Omarchy also shows the Claude and GPT
    // allowance once touched (its "Claude/GPT Weekly"); Agora's Gemini windows leave it out (docs/specs/credentials.md, "Google's answer").
    const read = (body: unknown) => LIMIT_ENDPOINTS.antigravity!.read(body).windows
    assert.deepEqual(read({ groups: [
      { displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-09-17T18:19:42Z', remainingFraction: 0.95 },
        { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-09-15T19:31:46Z', remainingFraction: 0.90 },
      ] },
      { displayName: 'Claude and GPT models', buckets: [
        { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-09-18T12:56:14Z', remainingFraction: 0.98 },
        { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-09-15T22:16:22Z', remainingFraction: 1.0 },
      ] },
    ] }), [
      { kind: 'five_hour', usedPercent: 10, resetsAt: '2026-09-15T19:31:46.000Z' },
      { kind: 'weekly', usedPercent: 5, resetsAt: '2026-09-17T18:19:42.000Z' },
    ])
    assert.deepEqual(read({ groups: [
      { displayName: 'Claude and GPT models', buckets: [{ window: '5h', remainingFraction: 1.0 }] },
      { displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 0.5 }] },
    ] }), [{ kind: 'weekly', usedPercent: 50, resetsAt: null }], 'the Gemini group wherever it is listed')
    assert.deepEqual(read({ buckets: [
      { window: '5h', remaining_fraction: 0.4, reset_time: '2026-09-15T19:31:46Z' },
      { window: 'weekly', remainingFraction: 'plenty' },
      { bucketId: 'gemini-weekly', remainingFraction: Infinity },
    ] }), [{ kind: 'five_hour', usedPercent: 60, resetsAt: '2026-09-15T19:31:46.000Z' }], 'snake case, buckets without groups, unreadable fractions skipped')
    assert.deepEqual(read({ buckets: [{ window: '5h', resetTime: '2026-09-15T19:31:46Z' }, { window: 'weekly' }] }), [
      { kind: 'five_hour', usedPercent: 100, resetsAt: '2026-09-15T19:31:46.000Z' },
    ], 'no fraction and a reset: spent, proto3 JSON leaving the zero out; neither: none')
    assert.deepEqual(read({ groups: [
      { displayName: 'Gemini Models', buckets: [
        { window: '5h', remainingAmount: '800', resetTime: '2026-09-15T19:31:46Z' },
        { window: 'weekly', remainingAmount: '0', resetTime: '2026-09-17T18:19:42Z' },
      ] },
      { displayName: 'Claude and GPT models', buckets: [{ window: '5h', disabled: true, resetTime: '2026-09-15T22:16:22Z' }] },
    ] }), [{ kind: 'weekly', usedPercent: 100, resetsAt: '2026-09-17T18:19:42.000Z' }], 'the amount arm, spent at zero alone')
    for (const shape of [null, [1], { error: { code: 500 } }, { groups: 5 }, { groups: 'abc' }, { buckets: 5 }, { groups: [{ displayName: 'Gemini Models', buckets: 5 }] }]) {
      assert.deepEqual(read(shape), [], JSON.stringify(shape))
    }
    assert.deepEqual(read({ groups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.5 }] }, { displayName: 'Claude and GPT models', buckets: 5 }] }), [
      { kind: 'five_hour', usedPercent: 50, resetsAt: null },
    ], 'another group of the wrong shape skipped')
    // In the same group, an amount at zero in the oneof as protobuf-es writes it: spent too.
    assert.deepEqual(read({ groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'gemini-5h', remaining: { case: 'remainingAmount', value: '0' }, resetTime: '2026-09-15T19:31:46Z' }] }] }), [
      { kind: 'five_hour', usedPercent: 100, resetsAt: '2026-09-15T19:31:46.000Z' },
    ])
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
    assert.ok(allowed('daily-cloudcode-pa.googleapis.com', '/v1internal:retrieveUserQuota', 'POST'))
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

describe('Google\'s requests', () => {
  // The per-model quota answers 404 unless a test says otherwise: an account it holds nothing for.
  const google = (assist: { status: number; body: unknown }, summary: unknown = GOOGLE_SUMMARY, quota: { status: number; body: unknown } = { status: 404, body: { error: { code: 404 } } }) => {
    // Google's requests alone: xiaomi, read beside it whatever the pools declare (C87), is answered and left out.
    const calls: GatewayGet[] = []
    const { limits } = limitsWith(async (input) => {
      if (input.host !== 'daily-cloudcode-pa.googleapis.com') return { status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }
      calls.push(input)
      if (input.path === '/v1internal:loadCodeAssist') return { status: assist.status, body: JSON.stringify(assist.body) }
      if (input.path === '/v1internal:retrieveUserQuota') return { status: quota.status, body: JSON.stringify(quota.body) }
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
        'summary fields {groups, description}; groups "claude and gpt models" [' +
        '"3p-weekly" (window "weekly", remainingFraction 0.5, displayName "weekly limit remaining", fields {bucketId, displayName, window, resetTime, remainingFraction, description}); ' +
        '"3p-5h" (window "5h", remainingFraction none, disabled true, displayName withheld, fields {bucketId, displayName, window, disabled})] | ' +
        '"*-*" ["*.*_*" (window "weekly", remainingFraction none, fields {bucketId, window, remainingAmount})]; retrieveUserQuota answered 404',
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
        'summary fields {groups}; groups "all models" [' +
        '"gemini-pro" (window none, remainingFraction 1, fields {bucketId, remainingFraction}); "*-*-*-claude" (window none, remainingFraction 1, fields {bucketId, remainingFraction})]; retrieveUserQuota answered 404',
    )
    assert.ok(!placeholder.includes('own-project-4821'))

    // Without a project: the tiers Google refuses the account, and why (steipete/CodexBar #4293).
    const refused = google({ status: 200, body: { ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT', reasonMessage: 'person@example.com may not' }] } })
    assert.equal(
      (await refused.limits.read()).antigravity!.error,
      'loadCodeAssist named no project: currentTier none, paidTier none, no project, ineligibleTiers "free-tier" "google_tos_not_supported_by_client", fields {ineligibleTiers}',
    )
  })
  it('C89 the error writes nothing of Google\'s but its own vocabulary, `*` for any other word, and fractions: whatever Google sends', async () => {
    const project = 'own-project-4821'
    const email = 'person@example.com'
    const token = 'ya29.a0AfB_secret'
    const hostile = {
      ownproject4821: true,
      [email]: 1,
      groups: [
        { displayName: 'own​project4821', buckets: [{ bucketId: `quota ${token}`, window: 'own project 4821', disabled: email, displayName: 'OWN_PROJECT_4821' }] },
        { displayName: 'Claude and GPT models', buckets: [{ bucketId: 'gemini-5h', window: '5h', disabled: [project], remainingFraction: 'x', [`a${token}`]: 1, 'person%40example.com': 2 }] },
        { displayName: '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', buckets: [{ bucketId: 'x eyJhbGciOiJFZERTQSJ9 y', window: 'AIzaSyD', displayName: '1//0gRefresh' }, { bucketId: 'a8f3k29d0s7g6h5j4k3l2', displayName: `${'x'.repeat(65)}` }] },
      ],
    }
    const { limits } = google({ status: 200, body: { currentTier: { id: email }, paidTier: { id: token }, cloudaicompanionProject: project, [project]: 1, ineligibleTiers: [{ tierId: project, reasonCode: `${token} ${email}` }] } }, hostile)
    assert.equal(
      (await limits.read()).antigravity!.error!,
      'daily-cloudcode-pa.googleapis.com gave no window: loadCodeAssist currentTier withheld, paidTier "*.*_*", the account\'s own project, ineligibleTiers "*-*-*" withheld, fields {currentTier, paidTier, cloudaicompanionProject, withheld, ineligibleTiers}; ' +
        'summary fields {"*", withheld, groups}; groups withheld ["quota *.*_*" (window "* * *", remainingFraction none, disabled not a boolean, displayName "*_*_*", fields {bucketId, window, disabled, displayName})] | ' +
        '"claude and gpt models" ["gemini-5h" (window "5h", remainingFraction none, disabled not a boolean, fields {bucketId, window, disabled, remainingFraction, withheld, withheld})] | ' +
        '"*-*" ["* * *" (window "*", remainingFraction none, displayName withheld, fields {bucketId, window, displayName}); "*" (window none, remainingFraction none, displayName withheld, fields {bucketId, displayName})]; retrieveUserQuota answered 404',
    )

    // A judge's probe: an opaque token across separators, a telephone number, the project as a number in each fraction.
    const numeric = google({ status: 200, body: { cloudaicompanionProject: '123456789012', currentTier: { id: 'm9Jx4QpY7vR2nK5f_hT8cW3sA6dL1uG0b_ZqE' } } }, {
      groups: [{ displayName: 'Claude and GPT models', buckets: [
        { bucketId: 'm9Jx4QpY7vR2nK5f_hT8cW3sA6dL1uG0b_ZqE', displayName: '+33 6 12 34 56 78', remainingFraction: 123456789012 },
        { bucketId: 'gemini-weekly', displayName: '33 6 12 34 56 78', remaining: { case: 'remainingFraction', value: 123456789012 } },
        { bucketId: '3p-5h', remainingFraction: 0.123456789012 },
      ] }],
    })
    assert.equal(
      (await numeric.limits.read()).antigravity!.error!,
      'daily-cloudcode-pa.googleapis.com gave no window: loadCodeAssist currentTier "*_*_*", paidTier none, the account\'s own project, fields {cloudaicompanionProject, currentTier}; ' +
        'summary fields {groups}; groups "claude and gpt models" [' +
        '"*_*_*" (window none, remainingFraction not a fraction, displayName withheld, fields {bucketId, displayName, remainingFraction}); ' +
        '"gemini-weekly" (window none, remainingFraction not a fraction, displayName "* * * * * *", fields {bucketId, displayName, remaining}); ' +
        '"3p-5h" (window none, remainingFraction 0.1235, fields {bucketId, remainingFraction})]; retrieveUserQuota answered 404',
    )
    // An answer that is not JSON: not a word of it, which JSON.parse's own error would quote.
    const garbled = limitsWith(async (input) => (input.host === 'daily-cloudcode-pa.googleapis.com' ? { status: 200, body: input.path.endsWith('loadCodeAssist') ? JSON.stringify(GOOGLE_ASSIST) : 'person@example.com ya29.secret' } : { status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }), ['antigravity'])
    assert.equal((await garbled.limits.read()).antigravity!.error, 'daily-cloudcode-pa.googleapis.com answered no JSON to /v1internal:retrieveUserQuotaSummary')
    // A project made of Google's own words: the part that would hold it withheld whole.
    const worded = google({ status: 200, body: { cloudaicompanionProject: 'gemini-pro-weekly', currentTier: { id: 'free-tier' } } }, { groups: [{ displayName: 'Gemini Pro Weekly', buckets: [] }] })
    assert.equal((await worded.limits.read()).antigravity!.error!, 'daily-cloudcode-pa.googleapis.com gave no window: loadCodeAssist currentTier "free-tier", paidTier none, the account\'s own project, fields {cloudaicompanionProject, currentTier}; summary withheld, as it would hold the project; retrieveUserQuota answered 404')

    // Any answer at all: random strings in every place the error looks, and random keys. No string of Google's reaches
    // the error but a word of the vocabulary; no run of digits but a fraction's.
    let seed = 7
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. @+%/:​'
    const text = () => Array.from({ length: 4 + Math.floor(random() * 30) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
    // The error's own words, beside the vocabulary and the fields' names the code lists.
    const own = 'daily cloudcode pa googleapis com gave no window loadcodeassist currenttier paidtier none the account s own project google shared consumer ineligibletiers fields summary inside buckets groups unnamed withheld remainingfraction not a fraction disabled boolean displayname string an object bucketid true false as it would hold retrieveuserquota answered modelid in another shape list'
    const vocabulary = new Set([...own.split(' '), ...DIAGNOSTIC_WORDS, ...[...DIAGNOSTIC_FIELDS].map((f) => f.toLowerCase())])
    for (let round = 0; round < 200; round += 1) {
      const sent = [text(), text(), text(), text(), text(), text(), text(), text()]
      const bucket = { bucketId: sent[0], window: sent[1], displayName: sent[2], [sent[3]!]: sent[4], remainingFraction: random() * 1e12, disabled: sent[5] }
      // The per-model quota too: random models, fields and states, none a fraction; one round in four, a 400.
      const models = { [sent[2]!]: 1, buckets: [{ modelId: sent[0], [sent[5]!]: sent[1], remainingFraction: random() * 1e12, disabled: sent[3] }, { model_id: `models/gemini-${sent[4]!}`, remaining_fraction: sent[6] }, sent[7]] }
      const quota = round % 4 === 0 ? { status: 400, body: { error: { message: sent[1] } } } : { status: 200, body: round % 2 === 0 ? models : { response: models } }
      const probe = google({ status: 200, body: { cloudaicompanionProject: sent[6], currentTier: { id: sent[7] }, paidTier: { id: sent[3] }, ineligibleTiers: [{ tierId: sent[4], reasonCode: sent[5] }] } }, { [sent[7]!]: 1, groups: [{ displayName: sent[6], buckets: [bucket] }] }, quota)
      const error = (await probe.limits.read()).antigravity!.error!
      for (const run of error.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const allowed = vocabulary.has(run) || /^\d{1,4}$/.test(run)
        assert.ok(allowed, `${run} in ${error}`)
      }
      for (const value of sent) for (const piece of value.match(/[A-Za-z0-9]{5,}/g) ?? []) if (!/^[a-z]+$/i.test(piece)) assert.ok(!error.includes(piece), `${piece} of ${value}`)
    }
  })

  it('C90 a summary without Gemini: the per-model quota for the same project, its fullest Gemini bucket the 5-hour window, as Omarchy reads it; 400 and 404 none, another status a failure', async () => {
    // basecamp/omarchy at cafb698, test/shell.d/agent-usage-agy-test.sh: its answers, replayed. Times relative to the
    // capture there (`iso_in`) are fixed here, two and four hours after the test's clock (2026-10-07T10:00:00Z).
    const early = '2026-10-07T12:00:00Z'
    const late = '2026-10-07T14:00:00Z'
    const ultraAssist = { paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' }, cloudaicompanionProject: 'aicode-consumers' }
    const ultraSummary = { groups: [{ displayName: 'Claude and GPT models', buckets: [
      { bucketId: '3p-5h', window: '5h', remainingFraction: 1.0 },
      { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.9 },
    ] }] }
    const ultraQuota = { buckets: [
      { modelId: 'claude-opus-5-5-high', remainingFraction: 0.2, resetTime: early },
      { modelId: 'tab_flash_lite_preview', remainingFraction: 0.1, resetTime: early },
      { modelId: 'gemini-2.5-flash', remainingFraction: 0.93, resetTime: late },
      { modelId: 'gemini-4-hydrogen-sonar', remainingFraction: 0.85, resetTime: early },
      { modelId: 'models/gemini-2.5-pro', remainingFraction: 0.85, resetTime: late },
    ] }

    // Ultra: the summary lists Claude and GPT alone; the fallback asks retrieveUserQuota with the same project, the same
    // headers, and reads Gemini's fullest bucket, the earliest reset among equals; Claude's and tab_*'s left out.
    const ultra = google({ status: 200, body: ultraAssist }, ultraSummary, { status: 200, body: ultraQuota })
    const read = await ultra.limits.read()
    assert.deepEqual(read.antigravity, { windows: [{ kind: 'five_hour', usedPercent: 15, resetsAt: '2026-10-07T12:00:00.000Z' }], plan: null, checkedAt: '2026-10-07T10:00:00.000Z', stale: false, error: null })
    assert.deepEqual(
      ultra.calls.map((c) => [c.method, c.path, c.body === undefined ? undefined : JSON.parse(c.body), c.headers['user-agent']]),
      [
        ['POST', '/v1internal:loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY', platform: 'LINUX_AMD64', pluginType: 'GEMINI' } }, 'antigravity/1.5.13 linux/amd64'],
        ['POST', '/v1internal:retrieveUserQuotaSummary', { project: 'aicode-consumers' }, 'antigravity/1.5.13 linux/amd64'],
        ['POST', '/v1internal:retrieveUserQuota', { project: 'aicode-consumers' }, 'antigravity/1.5.13 linux/amd64'],
      ],
    )

    // An untouched Gemini bucket: 0 %, without the rolling reset Google gives it, five hours after the request.
    const untouched = google({ status: 200, body: { ...ultraAssist, paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } } }, { groups: [{ displayName: 'Claude and GPT models', buckets: [{ window: '5h', remainingFraction: 1.0 }] }] }, {
      status: 200,
      body: { buckets: [{ modelId: 'gemini-3-flash', remainingFraction: 1.0, resetTime: '2026-10-07T15:00:00Z' }] },
    })
    assert.deepEqual((await untouched.limits.read()).antigravity!.windows, [{ kind: 'five_hour', usedPercent: 0, resetsAt: null }])

    // A summary with its Gemini group: retrieveUserQuota never asked.
    const pro = google({ status: 200, body: { paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' }, cloudaicompanionProject: 'aicode-consumers' } }, {
      groups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.75, resetTime: early }] }],
    }, { status: 200, body: ultraQuota })
    assert.deepEqual((await pro.limits.read()).antigravity!.windows, [{ kind: 'five_hour', usedPercent: 25, resetsAt: '2026-10-07T12:00:00.000Z' }])
    assert.deepEqual(pro.calls.map((c) => c.path), ['/v1internal:loadCodeAssist', '/v1internal:retrieveUserQuotaSummary'])

    // 404, and 400: no per-model quota, so no window — the error naming what each answer held. Omarchy shows the account
    // healthy without a meter; Agora's header has no such state, a read with no window is a failure (C89).
    for (const status of [404, 400]) {
      const none = google({ status: 200, body: { paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' }, cloudaicompanionProject: 'aicode-consumers' } }, { groups: [{ displayName: 'Claude and GPT models', buckets: [{ window: '5h', remainingFraction: 1.0 }] }] }, { status, body: { error: { code: status } } })
      const failed = (await none.limits.read()).antigravity!
      assert.deepEqual([failed.windows, failed.stale], [[], true])
      assert.equal(
        failed.error,
        'daily-cloudcode-pa.googleapis.com gave no window: loadCodeAssist currentTier none, paidTier "g1-ultra-tier", Google\'s shared consumer project, fields {paidTier, cloudaicompanionProject}; ' +
          `summary fields {groups}; groups "claude and gpt models" [no bucketId (window "5h", remainingFraction 1, fields {window, remainingFraction})]; retrieveUserQuota answered ${String(status)}`,
      )
    }

    // A transient 500 on retrieveUserQuota: the windows read before it stand, stale, and why.
    let quota = { status: 200, body: ultraQuota as unknown }
    const { limits, clock } = limitsWith(async (input) => {
      if (input.host !== 'daily-cloudcode-pa.googleapis.com') return { status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }
      if (input.path === '/v1internal:loadCodeAssist') return { status: 200, body: JSON.stringify(ultraAssist) }
      if (input.path === '/v1internal:retrieveUserQuota') return { status: quota.status, body: JSON.stringify(quota.body) }
      return { status: 200, body: JSON.stringify(ultraSummary) }
    }, ['antigravity'])
    await limits.read()
    quota = { status: 500, body: { error: { code: 500 } } }
    clock.now += 300_000
    const kept = (await limits.read()).antigravity!
    assert.deepEqual([kept.windows.map((w) => w.usedPercent), kept.stale, kept.error], [[15], true, 'daily-cloudcode-pa.googleapis.com answered 500 to /v1internal:retrieveUserQuota'])

    // A per-model quota with no Gemini bucket it can read: the error names its fields and each bucket's model, never a
    // value of the account's: an email withheld, Argon's model left out, an amount not zero no share of the whole.
    const unread = google({ status: 200, body: { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'own-project-4821' } }, ultraSummary, {
      status: 200,
      body: { buckets: [
        { modelId: 'claude-opus-5-5-high', remainingFraction: 0.2, resetTime: early, tokenType: 'REQUESTS' },
        { modelId: 'gemini-2.5-pro', remainingAmount: '800', disabled: false },
        { model_id: 'models/gemini-4-argon', remaining_fraction: 0.5 },
        { modelId: 'gemini-pro person@example.com', remainingFraction: 1.5 },
      ] },
    })
    assert.equal(
      (await unread.limits.read()).antigravity!.error,
      'daily-cloudcode-pa.googleapis.com gave no window: loadCodeAssist currentTier "free-tier", paidTier none, the account\'s own project, fields {currentTier, cloudaicompanionProject}; ' +
        'summary fields {groups}; groups "claude and gpt models" ["3p-5h" (window "5h", remainingFraction 1, fields {bucketId, window, remainingFraction}); "3p-weekly" (window "weekly", remainingFraction 0.9, fields {bucketId, window, remainingFraction})]; ' +
        'retrieveUserQuota fields {buckets}; buckets ["claude-opus-*-*-high" (remainingFraction 0.2, fields {modelId, remainingFraction, resetTime, tokenType}); ' +
        '"gemini-*.*-pro" (remainingFraction none, disabled false, fields {modelId, remainingAmount, disabled}); "gemini-*-argon" (remainingFraction 0.5, fields {model_id, remaining_fraction}); ' +
        'withheld (remainingFraction not a fraction, fields {modelId, remainingFraction})]',
    )
    // A project made of Google's own words, in a model's name: that part withheld whole.
    const own = google({ status: 200, body: { cloudaicompanionProject: 'gemini-pro-weekly' } }, ultraSummary, { status: 200, body: { buckets: [{ modelId: 'models/gemini-pro-weekly' }] } })
    assert.match((await own.limits.read()).antigravity!.error!, /; retrieveUserQuota withheld, as it would hold the project$/)
    // Not JSON: not a word of it.
    const notJson = limitsWith(async (input) => {
      if (input.host !== 'daily-cloudcode-pa.googleapis.com') return { status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }
      if (input.path === '/v1internal:loadCodeAssist') return { status: 200, body: JSON.stringify(ultraAssist) }
      if (input.path === '/v1internal:retrieveUserQuota') return { status: 200, body: 'person@example.com ya29.secret' }
      return { status: 200, body: JSON.stringify(ultraSummary) }
    }, ['antigravity'])
    assert.equal((await notJson.limits.read()).antigravity!.error, 'daily-cloudcode-pa.googleapis.com answered no JSON to /v1internal:retrieveUserQuota')
  })

  it('C92 an answer of another shape, the summary\'s or the per-model quota\'s, as Omarchy tells it from an empty one: a failed read, stale, naming what it held, never a fallback; an answer carrying `error` never read', async () => {
    // basecamp/omarchy at cafb698, bin/omarchy-agent-usage-agy: `extract_limits` (lines 303–313) and `extract_model_limits`
    // (349–351) answer None for these shapes, and `collect_limits` (462–464, 473–474) raises before any fallback; an empty
    // summary, `{"groups": []}`, is `[]`, and the fallback is asked.
    const assist = { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'own-project-4821' }
    const good = { buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.8 }] }
    const prefix = 'daily-cloudcode-pa.googleapis.com answered /v1internal:retrieveUserQuotaSummary in another shape: loadCodeAssist currentTier "free-tier", paidTier none, the account\'s own project, fields {currentTier, cloudaicompanionProject}; summary '
    const shapes: [unknown, string][] = [
      [null, 'fields none; groups none'],
      [[1], 'fields none; groups none'],
      [{ error: { code: 500 } }, 'fields {error}; groups none'],
      [{ response: { error: { code: 500 }, groups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.5 }] }] } }, 'fields {response}; inside, fields {error, groups}; groups "gemini models" [no bucketId (window "5h", remainingFraction 0.5, fields {window, remainingFraction})]'],
      [{ groups: 5 }, 'fields {groups}; groups not a list'],
      [{ groups: 'abc' }, 'fields {groups}; groups not a list'],
      [{ buckets: 5 }, 'fields {buckets}; buckets not a list; groups none'],
      [{ groups: [{ displayName: 'Gemini Models', buckets: 5 }] }, 'fields {groups}; groups "gemini models" not a list'],
    ]
    for (const [summary, described] of shapes) {
      const run = google({ status: 200, body: assist }, summary, { status: 200, body: good })
      const failed = (await run.limits.read()).antigravity!
      assert.deepEqual(failed, { windows: [], plan: null, checkedAt: null, stale: true, error: `${prefix}${described}` }, JSON.stringify(summary))
      assert.deepEqual(run.calls.map((c) => c.path), ['/v1internal:loadCodeAssist', '/v1internal:retrieveUserQuotaSummary'], `no fallback after ${JSON.stringify(summary)}`)
    }

    // The per-model quota of another shape — carrying `error` beside a Gemini bucket it would read, not an object, its
    // buckets not a list —: a failed read too, never its window.
    const empty = { groups: [] }
    const quotas: [unknown, string][] = [
      [{ error: { code: 500 }, ...good }, 'fields {error, buckets}; buckets ["gemini-*.*-pro" (remainingFraction 0.8, fields {modelId, remainingFraction})]'],
      [{ response: { error: { code: 500 }, ...good } }, 'fields {response}; inside, fields {error, buckets}; buckets ["gemini-*.*-pro" (remainingFraction 0.8, fields {modelId, remainingFraction})]'],
      [null, 'fields none; buckets none'],
      [{ buckets: 5 }, 'fields {buckets}; buckets not a list'],
    ]
    for (const [quota, described] of quotas) {
      const run = google({ status: 200, body: assist }, empty, { status: 200, body: quota })
      const failed = (await run.limits.read()).antigravity!
      assert.deepEqual(failed, {
        windows: [], plan: null, checkedAt: null, stale: true,
        error: `daily-cloudcode-pa.googleapis.com answered /v1internal:retrieveUserQuota in another shape: loadCodeAssist currentTier "free-tier", paidTier none, the account\'s own project, fields {currentTier, cloudaicompanionProject}; summary fields {groups}; groups none; retrieveUserQuota ${described}`,
      }, JSON.stringify(quota))
    }

    // An empty summary is an answer: the fallback asked, its window read. Its window, then a summary of another shape:
    // that window kept, stale, with why.
    const ok = google({ status: 200, body: assist }, empty, { status: 200, body: good })
    assert.deepEqual((await ok.limits.read()).antigravity, { windows: [{ kind: 'five_hour', usedPercent: 20, resetsAt: null }], plan: null, checkedAt: '2026-10-07T10:00:00.000Z', stale: false, error: null })
    assert.deepEqual(ok.calls.map((c) => c.path), ['/v1internal:loadCodeAssist', '/v1internal:retrieveUserQuotaSummary', '/v1internal:retrieveUserQuota'])
    let summary: unknown = empty
    const { limits, clock } = limitsWith(async (input) => {
      if (input.host !== 'daily-cloudcode-pa.googleapis.com') return { status: 200, body: JSON.stringify(ANSWERS[byHost(input)]) }
      if (input.path === '/v1internal:loadCodeAssist') return { status: 200, body: JSON.stringify(assist) }
      return { status: 200, body: JSON.stringify(input.path === '/v1internal:retrieveUserQuota' ? good : summary) }
    }, ['antigravity'])
    await limits.read()
    summary = { error: { code: 500 } }
    clock.now += 300_000
    assert.deepEqual((await limits.read()).antigravity, { windows: [{ kind: 'five_hour', usedPercent: 20, resetsAt: null }], plan: null, checkedAt: '2026-10-07T10:00:00.000Z', stale: true, error: `${prefix}fields {error}; groups none` })
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
