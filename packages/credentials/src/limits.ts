// The subscriptions' limits (docs/specs/credentials.md, "Limits"): each account's 5-hour and weekly
// windows, as its provider's own usage endpoint gives them. Agora asks through the gateway, the way an
// execution goes out, with a grant it signs for itself — the `limits` profile, bound to the server's own
// Pod address — so it never holds a provider's credential. Read when the interface asks, at most once
// every few minutes; a failed read keeps the windows before it, marked stale.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { GrantSigner } from './grants.ts'

export type WindowKind = 'five_hour' | 'weekly'

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
  readonly headers: Readonly<Record<string, string>>
  /** The provider's answer, read into windows; none when it holds no window this reads. */
  read(body: unknown): { windows: LimitWindow[]; plan: string | null }
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const percent = (value: number): number => Math.min(100, Math.max(0, value))
const instant = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString())
const ORDER: Record<WindowKind, number> = { five_hour: 0, weekly: 1 }
const ordered = (windows: LimitWindow[]): LimitWindow[] => windows.sort((a, b) => ORDER[a.kind] - ORDER[b.kind])

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
}

const MAX_ANSWER = 1024 * 1024

/**
 * A GET through the gateway, as an execution goes out: CONNECT with the grant, then TLS to the host,
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
        method: 'GET',
        headers: { host: input.host, accept: 'application/json', 'user-agent': 'agora', authorization: 'Bearer agora-placeholder', connection: 'close', ...input.headers },
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
    req.end()
  })
}

export interface SubscriptionLimitsOptions {
  readonly signer: GrantSigner
  /** The server's own Pod address, which its grant is bound to. */
  readonly address: string
  /** The profiles to read: the base profiles of the catalogue's pools. Those without an endpoint are left out. */
  readonly profiles: () => Promise<readonly string[]>
  /** How long a read stands before the next one; 5 minutes. */
  readonly maxAgeMs?: number
  readonly timeoutMs?: number
  readonly ca?: string
  readonly get?: (input: GatewayGet) => Promise<{ status: number; body: string }>
  readonly now?: () => number
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
    const profiles = [...new Set(await this.options.profiles())].filter((p) => Object.hasOwn(LIMIT_ENDPOINTS, p)).sort()
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
          const answer = await get({ proxy: credentials.proxy, token: credentials.token, host: endpoint.host, path: endpoint.path, headers: endpoint.headers, timeoutMs: this.options.timeoutMs ?? 10_000, ...(this.options.ca === undefined ? {} : { ca: this.options.ca }) })
          if (answer.status !== 200) throw new Error(`${endpoint.host} answered ${String(answer.status)}`)
          const read = endpoint.read(JSON.parse(answer.body) as unknown)
          if (read.windows.length === 0) throw new Error(`${endpoint.host} gave no window`)
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

/** `GET /api/limits`: the accounts' limits, by base profile; none when the server cannot read them. */
export async function limitsHttp(limits: SubscriptionLimits | undefined, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (new URL(req.url ?? '/', 'http://agora').pathname !== '/api/limits') return false
  const reply = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  if (req.method !== 'GET') return reply(405, { error: 'method_not_allowed' }), true
  reply(200, { limits: limits === undefined ? {} : await limits.read() })
  return true
}
