// The subscriptions' limits (docs/specs/credentials.md, "Limits"): each account's 5-hour and weekly
// windows, or its billing period, as its provider's own usage endpoint gives them. Agora asks through the gateway, the way an
// execution goes out, with a grant it signs for itself — the `limits` profile, bound to the server's own
// Pod address — so it never holds a provider's credential. Read when the interface asks, at most once
// every few minutes; a failed read keeps the windows before it, marked stale.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { GrantSigner } from './grants.ts'

/** `period`: a subscription's billing period, a month or a year, as a quota of credits gives it. */
export type WindowKind = 'five_hour' | 'weekly' | 'period'

export interface LimitWindow {
  readonly kind: WindowKind
  /** From 0 to 100. */
  readonly usedPercent: number
  /** ISO 8601; null while the provider has not started the window. */
  readonly resetsAt: string | null
}

export interface AccountLimits {
  readonly windows: readonly LimitWindow[]
  /** The plan, when the provider names it. */
  readonly plan: string | null
  /** When the windows were read from the provider; null before any read succeeded. */
  readonly checkedAt: string | null
  /** The last read failed: the windows are those before it. */
  readonly stale: boolean
  readonly error: string | null
}

export interface LimitEndpoint {
  readonly host: string
  readonly path: string
  /** `GET` when absent. */
  readonly method?: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  /**
   * A first request on the same host, a `POST` of this JSON body with the same headers, whose answer `body` reads:
   * Google's quota is read for the account's project, which only that answer names.
   */
  readonly prelude?: { readonly path: string; readonly body: string }
  /** The request's JSON body, from the prelude's answer when there is one; throws when that answer lacks what it needs. */
  body?(prelude: unknown): string
  /** The provider's answer, read into windows; none when it holds no window this reads. */
  read(body: unknown): { windows: LimitWindow[]; plan: string | null }
  /**
   * What an answer that gave no window held, for the error: its fields' names and the provider's own identifiers, enough
   * to write the reader from, never a value of the account's — no token, email or project.
   */
  describe?(body: unknown, prelude: unknown): string
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const percent = (value: number): number => Math.min(100, Math.max(0, value))
const instant = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString())
const hundredths = (value: number): number => Math.round(value * 100) / 100
const ORDER: Record<WindowKind, number> = { five_hour: 0, weekly: 1, period: 2 }
const ordered = (windows: LimitWindow[]): LimitWindow[] => windows.sort((a, b) => ORDER[a.kind] - ORDER[b.kind])

// Google's answers (docs/specs/credentials.md, "Google's answer").

/** Wrapped in `response` or `summary`, as CodexBar's and token-monitor's readers take it, or bare. */
const googleSummary = (body: unknown): Record<string, unknown> | null => {
  const root = object(body)
  return object(root?.response) ?? object(root?.summary) ?? root
}

/** `loadCodeAssist`'s project: `cloudaicompanionProject`, a string or an object's `id`, bare or in `response`. */
function googleProject(prelude: unknown): string | null {
  const root = object(prelude)
  for (const answer of [root, object(root?.response)]) {
    const named = answer?.cloudaicompanionProject
    const project = typeof named === 'string' ? named : object(named)?.id
    if (typeof project === 'string' && project !== '') return project
  }
  return null
}

/** `remainingFraction`, or the oneof as protobuf-es writes it, `remaining: {remainingFraction}` or `{case, value}`. */
function googleFraction(bucket: Record<string, unknown>): number | null {
  const remaining = object(bucket.remaining)
  return finite(bucket.remainingFraction) ?? finite(remaining?.remainingFraction) ?? (remaining?.case === 'remainingFraction' ? finite(remaining.value) : null)
}

const FIVE_HOURS = ['5h', 'session', '5-hour', 'five hour', 'five-hour']

/** The bucket's window, from its `window`, else its `bucketId`, else its `displayName`: `5h`, `gemini-weekly`, "Five Hour Limit Remaining". */
function googleCadence(bucket: Record<string, unknown>): WindowKind | null {
  for (const value of [bucket.window, bucket.bucketId, bucket.displayName]) {
    if (typeof value !== 'string') continue
    const v = value.trim().toLowerCase().replaceAll('_', '-').replace(/ limit( remaining)?$/, '')
    if (v === 'weekly' || /[- ]weekly$/.test(v)) return 'weekly'
    if (FIVE_HOURS.some((a) => v === a || v.endsWith(`-${a}`) || v.endsWith(` ${a}`))) return 'five_hour'
  }
  return null
}

/**
 * The words the error may carry of Google's answers (docs/specs/credentials.md, "A failed read"): Google's own
 * vocabulary — its tiers, reasons, groups, buckets, windows and fields as the sources show them —, and plain English.
 * Nothing else of what Google sends is ever written: no word of a token, an email, a telephone number or a project can
 * reach the error unless it is one of these, whatever Google sends.
 */
export const DIAGNOSTIC_WORDS: ReadonlySet<string> = new Set(
  (
    'gemini models model claude gpt oss opus sonnet haiku flash pro ultra lite argon wtu 3p 5h all other third party google ai antigravity ' +
    'free standard legacy g1 tier tiers paid current allowed ineligible consumer plus business enterprise workspace default ' +
    'tos not supported by client account unknown location unsupported restricted network age user validation verification required ' +
    'window windows weekly week daily day hourly hour hours five session monthly month limit limits remaining quota quotas reset time ' +
    'fraction amount bucket buckets group groups id ids name display description disabled enabled summary response case value ' +
    'reason code message plan type info and or of for with in per shared used left'
  ).split(' '),
)

/** The fields the sources name, written as they are: the proto's, `loadCodeAssist`'s, the oneof's. */
export const DIAGNOSTIC_FIELDS: ReadonlySet<string> = new Set(
  (
    'buckets groups description bucketId displayName window remainingFraction remainingAmount disabled resetTime response summary ' +
    'remaining case value currentTier paidTier allowedTiers ineligibleTiers cloudaicompanionProject gcpManaged id name tierId ' +
    'reasonCode reasonMessage isDefault planInfo planType manageSubscriptionUri upgradeSubscriptionUri upgradeSubscriptionText ' +
    'upgradeSubscriptionType userDefinedCloudaicompanionProject usesGcpTos hasAcceptedTos privacyNotice'
  ).split(' '),
)

/**
 * A string of Google's as the error writes it: each word — a run of letters or digits — kept if `DIAGNOSTIC_WORDS` has it,
 * lowercased, else `*`; between words, `-`, `_`, `.` and spaces as they were. A string holding any other character, or
 * longer than 64, is `withheld` whole. So what is written is made of `DIAGNOSTIC_WORDS` and those four separators alone.
 */
function words(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!/^[A-Za-z0-9 ._-]{1,64}$/.test(value)) return 'withheld'
  return `"${value
    .split(/([ ._-]+)/)
    .map((part, i) => (i % 2 === 1 ? part : part === '' ? '' : DIAGNOSTIC_WORDS.has(part.toLowerCase()) ? part.toLowerCase() : '*'))
    .join('')}"`
}

/** A field's name: as it is when the sources name it, else its camel-cased words under the same rule. */
function field(key: string): string {
  if (DIAGNOSTIC_FIELDS.has(key)) return key
  return /^[A-Za-z0-9_]{1,40}$/.test(key) ? `${words(key.replace(/([a-z0-9])([A-Z])/g, '$1 $2')) ?? '*'}` : 'withheld'
}
const fields = (value: Record<string, unknown> | null): string => (value === null ? 'none' : `{${Object.keys(value).map(field).join(', ')}}`)

/** A fraction, from 0 to 1, to the ten-thousandth; any other number is not written. */
const fraction = (value: number | null): string => (value === null ? 'none' : value >= 0 && value <= 1 ? String(Math.round(value * 10_000) / 10_000) : 'not a fraction')

const capped = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

/** The project, once more: should the text hold it, reduced to letters and digits, the text is withheld whole. */
function unlessProject(text: string, project: string | null): string {
  const own = project === null ? '' : project.toLowerCase().replace(/[^a-z0-9]/g, '')
  return own !== '' && text.toLowerCase().replace(/[^a-z0-9]/g, '').includes(own) ? 'withheld, as it would hold the project' : text
}

/** What `loadCodeAssist` said of the account: its tiers' ids, which project, the tiers it may not have and why. */
function describeAssist(prelude: unknown): string {
  const root = object(prelude)
  const answer = object(root?.response) ?? root
  const project = googleProject(prelude)
  const tier = (t: unknown) => words(object(t)?.id) ?? 'none'
  const which = project === null ? 'no project' : project === 'aicode-consumers' ? "Google's shared consumer project" : "the account's own project"
  const ineligible = (Array.isArray(answer?.ineligibleTiers) ? answer.ineligibleTiers : []).map((t) => `${tier({ id: object(t)?.tierId })} ${words(object(t)?.reasonCode) ?? 'no reason'}`)
  return unlessProject(capped(`currentTier ${tier(answer?.currentTier)}, paidTier ${tier(answer?.paidTier)}, ${which}${ineligible.length === 0 ? '' : `, ineligibleTiers ${ineligible.join(', ')}`}, fields ${fields(answer)}`, 500), project)
}

/** What the summary held: its fields, each group's name, each bucket's id, window, fraction, state and fields. */
function describeSummary(body: unknown, project: string | null): string {
  const root = object(body)
  const summary = googleSummary(body)
  const bucket = (value: unknown): string => {
    const b = object(value)
    if (b === null) return 'not an object'
    const shown = [
      `window ${words(b.window) ?? 'none'}`,
      `remainingFraction ${fraction(googleFraction(b))}`,
      ...(b.disabled === undefined ? [] : [`disabled ${typeof b.disabled === 'boolean' ? String(b.disabled) : 'not a boolean'}`]),
      ...(b.displayName === undefined ? [] : [`displayName ${words(b.displayName) ?? 'not a string'}`]),
    ]
    return `${words(b.bucketId) ?? 'no bucketId'} (${shown.join(', ')}, fields ${fields(b)})`
  }
  const list = (value: unknown): string => (Array.isArray(value) ? `[${value.map(bucket).join('; ')}]` : 'none')
  const groups = Array.isArray(summary?.groups) ? summary.groups.map((g) => `${words(object(g)?.displayName) ?? 'unnamed'} ${list(object(g)?.buckets)}`) : []
  const text = [
    `fields ${fields(root)}`,
    ...(summary === root ? [] : [`inside, fields ${fields(summary)}`]),
    ...(summary?.buckets === undefined ? [] : [`buckets ${list(summary.buckets)}`]),
    `groups ${groups.length === 0 ? 'none' : groups.join(' | ')}`,
  ].join('; ')
  return unlessProject(capped(text, 1500), project)
}

/** Each base profile's usage endpoint, by profile. The catalogue is here, in code, reviewed like code. */
export const LIMIT_ENDPOINTS: Readonly<Record<string, LimitEndpoint>> = {
  // Claude: the cluster's own login answers here, not the setup-token, which lacks `user:profile`.
  // `utilization` is a percentage; the week is `seven_day`, every model's, as Claude Code's /usage shows it.
  anthropic: {
    host: 'api.anthropic.com',
    path: '/api/oauth/usage',
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    read(body) {
      const answer = object(body)
      const window = (kind: WindowKind, value: unknown): LimitWindow[] => {
        const w = object(value)
        const used = finite(w?.utilization)
        if (used === null) return []
        return [{ kind, usedPercent: percent(used), resetsAt: typeof w?.resets_at === 'string' ? instant(Date.parse(w.resets_at)) : null }]
      }
      return { windows: ordered([...window('five_hour', answer?.five_hour), ...window('weekly', answer?.seven_day)]), plan: null }
    },
  },
  // ChatGPT, for codex: the primary and secondary windows, told apart by their length.
  chatgpt: {
    host: 'chatgpt.com',
    path: '/backend-api/wham/usage',
    headers: {},
    read(body) {
      const answer = object(body)
      const rate = object(answer?.rate_limit)
      const windows = [rate?.primary_window, rate?.secondary_window].flatMap((value): LimitWindow[] => {
        const w = object(value)
        const used = finite(w?.used_percent),
          seconds = finite(w?.limit_window_seconds),
          reset = finite(w?.reset_at)
        if (used === null || seconds === null) return []
        const kind: WindowKind | null = seconds <= 6 * 3600 ? 'five_hour' : seconds >= 6 * 86_400 ? 'weekly' : null
        return kind === null ? [] : [{ kind, usedPercent: percent(used), resetsAt: reset === null ? null : instant(reset * 1000) }]
      })
      return { windows: ordered(windows), plan: typeof answer?.plan_type === 'string' ? answer.plan_type : null }
    },
  },
  // Xiaomi MiMo's Token Plan, on its European cluster, with its `tp-` key: Xiaomi's "Query Token Plan Credits"
  // (mimo.mi.com/docs/en-US/api/asset/credits-get). One window, the billing period: the credits used of its total,
  // until `period.end_at`, UTC written without a zone; none while the plan holds no credit.
  xiaomi: {
    host: 'token-plan-ams.xiaomimimo.com',
    path: '/v1/platform/token_plan',
    headers: {},
    read(body) {
      const answer = object(body)
      const quota = object(answer?.quota)
      const total = finite(quota?.total_credits),
        used = finite(quota?.used_credits),
        end = object(answer?.period)?.end_at
      if (answer?.object !== 'token_plan' || total === null || used === null || total <= 0) return { windows: [], plan: null }
      const resetsAt = typeof end === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(end) ? instant(Date.parse(`${end.replace(' ', 'T')}Z`)) : null
      return { windows: [{ kind: 'period', usedPercent: percent((used / total) * 100), resetsAt }], plan: typeof answer.plan_code === 'string' ? answer.plan_code : null }
    },
  },
  // z.ai's Coding Plan: its token (or credit) limits, the 5-hour one with unit 3, the weekly one with
  // unit 6; the MCP calls' limit is left out. No reset time until the window has started.
  zai: {
    host: 'api.z.ai',
    path: '/api/monitor/usage/quota/limit',
    headers: {},
    read(body) {
      const data = object(object(body)?.data)
      const limits = Array.isArray(data?.limits) ? data.limits : []
      const windows = limits.flatMap((value): LimitWindow[] => {
        const l = object(value)
        const used = finite(l?.percentage),
          unit = finite(l?.unit),
          reset = finite(l?.nextResetTime)
        if (used === null || (l?.type !== 'TOKENS_LIMIT' && l?.type !== 'CREDIT_LIMIT')) return []
        const kind: WindowKind | null = unit === 3 ? 'five_hour' : unit === 6 ? 'weekly' : null
        return kind === null ? [] : [{ kind, usedPercent: percent(used), resetsAt: instant(reset) }]
      })
      return { windows: ordered(windows), plan: typeof data?.level === 'string' ? data.level : null }
    },
  },
  // Google's Antigravity, for agy, on the cluster's own Google login (docs/specs/credentials.md, "Antigravity", "Google's
  // answer"): the quota summary agy 1.5.13 reads (its quota_summary.proto), for the account's project, which
  // `loadCodeAssist` names — both POSTs, as Antigravity's client, which Google requires. The Gemini buckets become the
  // 5-hour and weekly windows, used being what the remaining fraction leaves; a disabled bucket left out. A window
  // untouched (fraction 1) has no reset: Google then gives the request's time plus the window's length. An answer with
  // no such bucket fails naming what it held, never a value of the account's.
  antigravity: {
    host: 'daily-cloudcode-pa.googleapis.com',
    path: '/v1internal:retrieveUserQuotaSummary',
    method: 'POST',
    headers: { 'user-agent': 'antigravity/1.5.13 linux/amd64' },
    prelude: { path: '/v1internal:loadCodeAssist', body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', platform: 'LINUX_AMD64', pluginType: 'GEMINI' } }) },
    body(prelude) {
      const project = googleProject(prelude)
      if (project === null) throw new Error(`loadCodeAssist named no project: ${describeAssist(prelude)}`)
      return JSON.stringify({ project })
    },
    read(body) {
      const summary = googleSummary(body)
      const groups = Array.isArray(summary?.groups) ? summary.groups : []
      // The deprecated top-level buckets (the proto's field 1), then each group's; a Gemini bucket is one whose id says
      // so, or one in the group named Gemini, Argon's apart.
      const candidates = [
        ...(Array.isArray(summary?.buckets) ? summary.buckets : []).map((b) => ({ bucket: object(b), group: false })),
        ...groups.flatMap((g) => {
          const group = object(g)
          const buckets = Array.isArray(group?.buckets) ? group.buckets : []
          const gemini = typeof group?.displayName === 'string' && /^gemini( models)?$/i.test(group.displayName.trim())
          return buckets.map((b) => ({ bucket: object(b), group: gemini }))
        }),
      ]
      const least = new Map<WindowKind, { remaining: number; resetsAt: string | null }>()
      for (const { bucket, group } of candidates) {
        const id = typeof bucket?.bucketId === 'string' ? bucket.bucketId.toLowerCase() : ''
        if (bucket === null || id.includes('argon') || !(group || /^gemini[-_]/.test(id))) continue
        const kind = googleCadence(bucket)
        const remaining = googleFraction(bucket)
        if (kind === null || remaining === null || remaining < 0 || remaining > 1 || bucket.disabled === true) continue
        const resetsAt = remaining >= 1 || typeof bucket.resetTime !== 'string' ? null : instant(Date.parse(bucket.resetTime))
        const before = least.get(kind)
        if (before === undefined || remaining < before.remaining) least.set(kind, { remaining, resetsAt })
      }
      const windows = [...least].map(([kind, w]): LimitWindow => ({ kind, usedPercent: percent(hundredths((1 - w.remaining) * 100)), resetsAt: w.resetsAt }))
      return { windows: ordered(windows), plan: null }
    },
    describe(body, prelude) {
      return `loadCodeAssist ${describeAssist(prelude)}; summary ${describeSummary(body, googleProject(prelude))}`
    },
  },
}

export interface GatewayGet {
  /** The gateway's CONNECT listener, `host:port`. */
  readonly proxy: string
  readonly token: string
  readonly host: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
  /** The roots the gateway's certificates are checked against; the process's own when absent. */
  readonly ca?: string
  /** `GET` when absent. */
  readonly method?: string
  /** A JSON body, for a method that carries one. */
  readonly body?: string
}

const MAX_ANSWER = 1024 * 1024

/**
 * A GET, or a POST with its JSON body, through the gateway, as an execution goes out: CONNECT with the grant, then TLS to the host,
 * which the gateway terminates to check the grant and set the account's credential. The placeholder
 * Authorization is replaced there.
 */
export async function getThroughGateway(input: GatewayGet): Promise<{ status: number; body: string }> {
  const signal = AbortSignal.timeout(input.timeoutMs)
  const [proxyHost = '', proxyPort = ''] = input.proxy.replace(/^[a-z]+:\/\//, '').split(':')
  const authority = `${input.host}:443`
  const tunnel = await new Promise<Socket>((resolve, reject) => {
    const connect = httpRequest({ host: proxyHost, port: Number(proxyPort), method: 'CONNECT', path: authority, headers: { host: authority, 'proxy-authorization': `Bearer ${input.token}` }, signal })
    connect.once('connect', (response, socket) => {
      if (response.statusCode === 200) return resolve(socket)
      socket.destroy()
      reject(new Error(`the gateway refused the tunnel: ${String(response.statusCode)}`))
    })
    connect.once('error', reject)
    connect.end()
  })
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: input.host,
        path: input.path,
        method: input.method ?? 'GET',
        headers: {
          host: input.host,
          accept: 'application/json',
          'user-agent': 'agora',
          authorization: 'Bearer agora-placeholder',
          connection: 'close',
          ...(input.body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(input.body)) }),
          ...input.headers,
        },
        // No agent: `agent: false` would make a fresh one, which dials the host itself and ignores this.
        createConnection: () => tlsConnect({ socket: tunnel, servername: input.host, ...(input.ca === undefined ? {} : { ca: input.ca }) }),
        signal,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_ANSWER) return res.destroy(new Error('answer too large'))
          chunks.push(chunk)
        })
        res.once('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        res.once('error', reject)
      },
    )
    req.once('error', reject)
    req.end(input.body)
  })
}

export interface SubscriptionLimitsOptions {
  readonly signer: GrantSigner
  /** The server's own Pod address, which its grant is bound to. */
  readonly address: string
  /** The profiles to read: the base profiles of the catalogue's pools, beside `LIMITS_WITHOUT_POOL`. Those without an endpoint are left out. */
  readonly profiles: () => Promise<readonly string[]>
  /** How long a read stands before the next one; 5 minutes. */
  readonly maxAgeMs?: number
  /** How long each request may take, 10 seconds: an account read in two requests (Google's) may take twice that. */
  readonly timeoutMs?: number
  readonly ca?: string
  readonly get?: (input: GatewayGet) => Promise<{ status: number; body: string }>
  readonly now?: () => number
}

/**
 * The base profiles whose endpoint is kept but not read (docs/specs/credentials.md, "Limits"): neither asked nor
 * in `GET /api/limits`, whatever the pools declare. `zai`: the operator's z.ai subscription has lapsed since
 * 2026-11. Taking a profile out of this set reads it again.
 */
export const LIMITS_NOT_READ: ReadonlySet<string> = new Set(['zai'])

/**
 * The accounts read though no pool of the catalogue draws from them (docs/specs/credentials.md, "Limits"): `xiaomi`,
 * the operator's Xiaomi MiMo subscription, which no harness uses.
 */
export const LIMITS_WITHOUT_POOL: readonly string[] = ['xiaomi']

/** An answer's JSON; one that is none fails without a word of it, which `JSON.parse`'s own error would quote. */
function json(body: string, host: string, path: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new Error(`${host} answered no JSON to ${path}`)
  }
}

/** The accounts' limits, read through the gateway at most once per `maxAgeMs`, one read at a time. */
export class SubscriptionLimits {
  private readonly options: SubscriptionLimitsOptions
  private readonly last = new Map<string, AccountLimits>()
  private readAt = Number.NEGATIVE_INFINITY
  private reading: Promise<void> | null = null

  constructor(options: SubscriptionLimitsOptions) {
    this.options = options
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  async read(): Promise<Record<string, AccountLimits>> {
    const profiles = [...new Set([...(await this.options.profiles()), ...LIMITS_WITHOUT_POOL])].filter((p) => Object.hasOwn(LIMIT_ENDPOINTS, p) && !LIMITS_NOT_READ.has(p)).sort()
    const due = this.now() - this.readAt >= (this.options.maxAgeMs ?? 300_000) || profiles.some((p) => !this.last.has(p))
    if (due && profiles.length > 0) {
      this.reading ??= this.refresh(profiles).finally(() => {
        this.reading = null
      })
      await this.reading
    }
    return Object.fromEntries(profiles.flatMap((p) => (this.last.has(p) ? [[p, this.elapsed(this.last.get(p)!)]] : [])))
  }

  /** A window whose reset has passed holds nothing yet, and its next reset is not known. */
  private elapsed(limits: AccountLimits): AccountLimits {
    const now = this.now()
    return { ...limits, windows: limits.windows.map((w) => (w.resetsAt !== null && Date.parse(w.resetsAt) <= now ? { ...w, usedPercent: 0, resetsAt: null } : w)) }
  }

  private async refresh(profiles: readonly string[]): Promise<void> {
    const get = this.options.get ?? getThroughGateway
    let credentials: { proxy: string; token: string } | null = null
    let refused: string | null = null
    try {
      credentials = await this.options.signer.mint({ label: 'agora limits', ttlSeconds: 300, profiles: ['limits'], address: this.options.address })
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    await Promise.all(
      profiles.map(async (profile) => {
        const endpoint = LIMIT_ENDPOINTS[profile]!
        const before = this.last.get(profile)
        try {
          if (credentials === null) throw new Error(`no grant: ${String(refused)}`)
          const grant = credentials
          const send = (path: string, method: string, body: string | undefined) =>
            get({ proxy: grant.proxy, token: grant.token, host: endpoint.host, path, headers: endpoint.headers, timeoutMs: this.options.timeoutMs ?? 10_000, ...(this.options.ca === undefined ? {} : { ca: this.options.ca }), ...(method === 'GET' ? {} : { method }), ...(body === undefined ? {} : { body }) })
          let prelude: unknown = null
          if (endpoint.prelude !== undefined) {
            const first = await send(endpoint.prelude.path, 'POST', endpoint.prelude.body)
            if (first.status !== 200) throw new Error(`${endpoint.host} answered ${String(first.status)} to ${endpoint.prelude.path}`)
            prelude = json(first.body, endpoint.host, endpoint.prelude.path)
          }
          const answer = await send(endpoint.path, endpoint.method ?? 'GET', endpoint.body?.(prelude))
          if (answer.status !== 200) throw new Error(`${endpoint.host} answered ${String(answer.status)}`)
          const parsed = json(answer.body, endpoint.host, endpoint.path)
          const read = endpoint.read(parsed)
          if (read.windows.length === 0) throw new Error(`${endpoint.host} gave no window${endpoint.describe === undefined ? '' : `: ${endpoint.describe(parsed, prelude)}`}`)
          this.last.set(profile, { ...read, checkedAt: new Date(this.now()).toISOString(), stale: false, error: null })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.last.set(profile, { windows: before?.windows ?? [], plan: before?.plan ?? null, checkedAt: before?.checkedAt ?? null, stale: true, error: message })
        }
      }),
    )
    this.readAt = this.now()
  }
}

/** `GET /api/limits`: the accounts' limits, by base profile, as `limits` reads them (a preview's are fixed); none when the server cannot read them. */
export async function limitsHttp(limits: Pick<SubscriptionLimits, 'read'> | undefined, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (new URL(req.url ?? '/', 'http://agora').pathname !== '/api/limits') return false
  const reply = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  if (req.method !== 'GET') return reply(405, { error: 'method_not_allowed' }), true
  reply(200, { limits: limits === undefined ? {} : await limits.read() })
  return true
}
