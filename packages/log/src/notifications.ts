/// <reference path="./web-push.d.ts" />
// Notifications (docs/specs/notifications.md): a form shown to the person, an approval or a merge card becomes pending;
// the projection's run writes what to send in its own transaction (`CardSink`); this engine sends it, Web Push, to every
// subscription of the card's owner, once, unless the card is no longer pending by then. The payload is Safari's
// declarative Web Push message, encrypted to each subscription (RFC 8291) and signed VAPID (RFC 8292) by `web-push`.
import type { PoolClient } from 'pg'
import { generateRequestDetails } from 'web-push'
import type { Card, CardSink } from './projection.ts'
import { telemetry } from './telemetry.ts'
import type { Workstreams } from './workstreams.ts'

/** The push services an endpoint may name (docs/specs/notifications.md, "Subscriptions"): a host, or a domain under which. */
export const PUSH_HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'] as const
export const PUSH_DOMAINS = ['.notify.windows.com'] as const
/** At most so many subscriptions per owner. */
export const MAX_SUBSCRIPTIONS = 10
/** A form's and a merge card's time to live, in seconds. */
export const CARD_TTL = 86_400
/** The card's line in a notification, in code points (docs/specs/notifications.md, "The message"). */
export const LINE_MAX = 120
/** The waits between attempts, then every last one, ms. */
export const RETRY_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000]
/** After the database failed the engine: its next look, ms. */
export const RECOVER_MS = 30_000
/** A message's bound, UTF-8 JSON before encryption (docs/specs/notifications.md, "The message"). */
export const MESSAGE_MAX = 3_000

const PREFIX: Readonly<Record<Card['kind'], string>> = { form: 'Question', approval: 'Approval', merge: 'Merge' }

export interface Subscription {
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
}
/** One push request, as the network answers it. */
export type Send = (endpoint: string, init: { headers: Record<string, string>; body: Buffer }) => Promise<{ status: number; retryAfter: string | null }>

export interface NotificationsOptions {
  /** The VAPID key pair, P-256, base64url. */
  readonly publicKey: string
  readonly privateKey: string
  /** `mailto:` or `https:`, naming the operator. */
  readonly subject: string
  /** The client's origin, `https://agora.bretagne.dev`. */
  readonly origin: string
  /** The network; `fetch` with a 10 s limit by default. Tests stand in for the push services. */
  readonly send?: Send
  readonly retryMs?: readonly number[]
  /** After a database failure, the next look; 30 s. */
  readonly recoverMs?: number
  readonly sink?: (line: string) => void
}

/** What a refused subscription is answered (docs/specs/notifications.md, "Subscriptions"). */
export class PushRefused extends Error {}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/
const bytes = (text: unknown): Buffer | null => (typeof text === 'string' && BASE64URL.test(text) ? Buffer.from(text, 'base64url') : null)

/** A `PushSubscription`'s JSON, checked: an endpoint of a push service, a P-256 key and a 16-byte secret. */
export function subscriptionOf(body: Readonly<Record<string, unknown>>): Subscription {
  const keys = (body.keys ?? {}) as Record<string, unknown>
  const endpoint = body.endpoint
  if (typeof endpoint !== 'string' || endpoint.length > 1024) throw new PushRefused('invalid_subscription')
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new PushRefused('invalid_subscription')
  }
  const host = url.hostname
  const known = (PUSH_HOSTS as readonly string[]).includes(host) || PUSH_DOMAINS.some((d) => host.endsWith(d) && host.length > d.length)
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '' || !known) throw new PushRefused('invalid_subscription')
  const p256dh = bytes(keys.p256dh),
    auth = bytes(keys.auth)
  if (p256dh === null || p256dh.length !== 65 || p256dh[0] !== 0x04 || auth === null || auth.length !== 16) throw new PushRefused('invalid_subscription')
  return { endpoint, p256dh: String(keys.p256dh), auth: String(keys.auth) }
}

/** A card's line (docs/specs/notifications.md, "The message"): its first line alone, cut with an ellipsis past 120 code points. */
export function lineOf(text: string): string {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? ''
  const points = [...first]
  return points.length <= LINE_MAX ? first : `${points.slice(0, LINE_MAX - 1).join('')}…`
}

/** What a message says of its card (docs/specs/notifications.md, "The message"). */
export interface MessageInput {
  readonly origin: string
  readonly workstream: string
  readonly position: string
  readonly kind: string
  readonly title: string
  readonly body: string
  readonly badge: number
}

/**
 * The declarative Web Push message, within MESSAGE_MAX bytes: the title cut shorter, an ellipsis last, until the whole
 * UTF-8 JSON fits; the body is a line already (`lineOf`).
 */
export function messageOf(input: MessageInput): string {
  const make = (title: string) =>
    JSON.stringify({
      web_push: 8030,
      notification: {
        title,
        body: input.body,
        navigate: `${input.origin}/w/${input.workstream}`,
        tag: input.workstream,
        data: { workstream: input.workstream, position: input.position, kind: input.kind },
        app_badge: String(input.badge),
      },
    })
  const points = [...(input.title === '' ? 'Agora' : input.title)]
  let message = make(points.join(''))
  if (Buffer.byteLength(message) <= MESSAGE_MAX) return message
  // The longest cut that fits, found by halves.
  let low = 0,
    high = points.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(make(`${points.slice(0, mid).join('')}…`)) <= MESSAGE_MAX) low = mid
    else high = mid - 1
  }
  message = make(`${points.slice(0, low).join('')}…`)
  return message
}

/** The host a log line may name: a push service's, or nothing. */
function hostOf(endpoint: string): string | undefined {
  try {
    const host = new URL(endpoint).hostname
    if ((PUSH_HOSTS as readonly string[]).includes(host)) return host
    const domain = PUSH_DOMAINS.find((d) => host.endsWith(d))
    return domain === undefined ? undefined : domain.slice(1)
  } catch {
    return undefined
  }
}

const fetchSend: Send = async (endpoint, init) => {
  const answer = await fetch(endpoint, { method: 'POST', headers: init.headers, body: new Uint8Array(init.body), signal: AbortSignal.timeout(10_000), redirect: 'error' })
  await answer.body?.cancel().catch(() => {})
  return { status: answer.status, retryAfter: answer.headers.get('retry-after') }
}

/**
 * The cards pending for the person (docs/specs/notifications.md, "What notifies"): each view's question that is an
 * approval not expired or a merge card, and its form unless the Workstream is a delegate's — a native sub-stream's while
 * its element is pending. `owner` and, when given, one Workstream and position.
 */
const PENDING = `
SELECT * FROM (
  SELECT v.workstream, q.object->>'position' AS position, q.object->>'kind' AS kind
  FROM objects v JOIN workstreams w ON w.id = v.workstream
  JOIN objects q ON q.workstream = v.workstream AND q.kind = 'element' AND q.type = 'question' AND q.object->>'position' = v.object->>'question'
  WHERE v.kind = 'workstream' AND v.id = v.workstream AND w.owner = $1 AND q.object->>'status' = 'pending'
    AND (q.object->>'kind' = 'merge' OR (q.object->>'kind' = 'approval' AND (q.object->>'expiresAt')::timestamptz > now()))
  UNION ALL
  SELECT v.workstream, f.object->>'requestPosition', 'form'
  FROM objects v JOIN workstreams w ON w.id = v.workstream
  JOIN objects f ON f.workstream = v.workstream AND f.kind = 'element' AND f.type = 'elicitation'
    AND (f.object->>'requestPosition' = v.object->>'request' OR v.object ? 'native')
  WHERE v.kind = 'workstream' AND v.id = v.workstream AND w.owner = $1 AND NOT (v.object ? 'delegation') AND NOT (f.object ? 'declined')
    AND f.object->>'status' = 'pending'
) cards WHERE ($2::uuid IS NULL OR workstream = $2::uuid) AND ($3::text IS NULL OR position = $3::text)
ORDER BY position::bigint, workstream`

type Row = { workstream: string; position: string; owner: string; kind: Card['kind']; title: string; body: string; expires_at: Date; done: string[]; delivered: boolean; attempts: number }

export class Notifications implements CardSink {
  private readonly workstreams: Workstreams
  private readonly options: NotificationsOptions
  private readonly send: Send
  private timer: NodeJS.Timeout | null = null
  private draining: Promise<void> | null = null
  private again = false
  /** The database failed the last drain: the next look comes after RECOVER_MS, whatever is due. */
  private failed = false
  private stopped = false

  constructor(workstreams: Workstreams, options: NotificationsOptions) {
    this.workstreams = workstreams
    this.options = options
    this.send = options.send ?? fetchSend
    workstreams.notifications = this
    workstreams.projections.cards = this
  }

  private get db() {
    return this.workstreams.projections.store.projector
  }
  private report(fields: Record<string, unknown>): void {
    telemetry({ operation: 'push', ...fields }, this.options.sink ?? this.workstreams.options.sink ?? (() => {}))
  }

  /** `GET /api/push`: the VAPID public key the client subscribes with. */
  get key(): string {
    return this.options.publicKey
  }

  // ---------------------------------------------------------------- subscriptions

  /** `POST /api/push/subscriptions`: stored for its owner; the same endpoint again takes the new keys and owner. */
  async subscribe(owner: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    const subscription = subscriptionOf(body)
    const client = await this.db.connect()
    let broken = false
    try {
      await client.query('BEGIN')
      // One owner's subscriptions counted under its lock: two at once never make an eleventh.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`push:${owner}`])
      const held = await client.query('SELECT count(*)::int AS n, bool_or(endpoint = $2) AS known FROM push_subscriptions WHERE owner = $1', [owner, subscription.endpoint])
      if (!held.rows[0].known && Number(held.rows[0].n) >= MAX_SUBSCRIPTIONS) throw new PushRefused('too_many_subscriptions')
      await client.query(
        'INSERT INTO push_subscriptions(endpoint, owner, p256dh, auth) VALUES($1, $2, $3, $4) ON CONFLICT(endpoint) DO UPDATE SET owner = excluded.owner, p256dh = excluded.p256dh, auth = excluded.auth',
        [subscription.endpoint, owner, subscription.p256dh, subscription.auth],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => (broken = true))
      throw error
    } finally {
      client.release(broken)
    }
  }

  /** `DELETE /api/push/subscriptions`: the owner's subscription with that endpoint, when there is one. */
  async unsubscribe(owner: string, endpoint: unknown): Promise<void> {
    if (typeof endpoint !== 'string') throw new PushRefused('invalid_subscription')
    await this.db.query('DELETE FROM push_subscriptions WHERE owner = $1 AND endpoint = $2', [owner, endpoint])
  }

  /** `GET /api/push/pending`: the owner's cards pending for the person, by position. */
  async pending(owner: string, only?: { workstream: string; position: string }): Promise<{ workstream: string; position: string; kind: string }[]> {
    const rows = await this.db.query(PENDING, [owner, only?.workstream ?? null, only?.position ?? null])
    return rows.rows.map((r) => ({ workstream: r.workstream as string, position: r.position as string, kind: r.kind as string }))
  }

  // ---------------------------------------------------------------- writing

  /** In the run's transaction: one notification per Workstream and card position, the same again writing none. */
  async write(client: PoolClient, cards: readonly Card[]): Promise<void> {
    for (const card of cards) {
      const owner = (await client.query('SELECT owner FROM workstreams WHERE id = $1', [card.workstream])).rows[0]?.owner as string | undefined
      if (owner === undefined) continue
      const line = lineOf(card.text)
      const body = line === '' ? PREFIX[card.kind] : `${PREFIX[card.kind]} · ${line}`
      // An approval lives until its expiry; a form and a merge card a day.
      const expires = card.kind === 'approval' ? new Date(Date.parse(card.expiresAt ?? '')) : new Date(Date.now() + CARD_TTL * 1000)
      await client.query(
        'INSERT INTO push_notifications(workstream, position, owner, kind, title, body, expires_at) VALUES($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
        [card.workstream, card.position, owner, card.kind, lineOf(card.title), body, Number.isNaN(expires.getTime()) ? new Date() : expires],
      )
    }
  }

  committed(): void {
    if (!this.stopped) void this.drain()
  }

  // ---------------------------------------------------------------- sending

  /** At start: every notification neither sent nor dropped. */
  async start(): Promise<void> {
    this.stopped = false
    await this.drain()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    await this.draining?.catch(() => {})
  }

  /** Sends what is due, one drain at a time; one asked meanwhile runs after it. */
  drain(): Promise<void> {
    if (this.draining !== null) {
      this.again = true
      return this.draining
    }
    this.draining = (async () => {
      this.failed = false
      try {
        do {
          this.again = false
          const due = await this.db.query(
            "SELECT workstream, position::text AS position, owner, kind, title, body, expires_at, done, delivered, attempts FROM push_notifications WHERE state = 'pending' AND next_at <= now() ORDER BY next_at, position",
          )
          for (const row of due.rows as Row[]) {
            if (this.stopped) return
            await this.attempt(row).catch(() => {
              this.failed = true
              this.report({ workstream: row.workstream, position: row.position, outcome: 'failed', errorClass: 'database' })
            })
          }
        } while (this.again && !this.stopped)
      } catch {
        this.failed = true
        this.report({ outcome: 'failed', errorClass: 'database' })
      } finally {
        this.draining = null
      }
      await this.schedule()
    })()
    return this.draining
  }

  /**
   * The next attempt due, as a timer. The database failing — the drain, or this read — never leaves the engine without
   * one: it looks again after RECOVER_MS, and not sooner, so that a failing row is not tried in a loop.
   */
  private async schedule(): Promise<void> {
    if (this.stopped) return
    const next = await this.db.query("SELECT min(next_at) AS at FROM push_notifications WHERE state = 'pending'").catch(() => null)
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.stopped) return
    const recover = this.options.recoverMs ?? RECOVER_MS
    const at = next?.rows[0]?.at as Date | null | undefined
    let delay: number
    if (next === null) delay = recover
    else if (at === null || at === undefined) {
      if (!this.failed) return
      delay = recover
    } else delay = Math.max(this.failed ? recover : 0, at.getTime() - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, delay)
  }

  private async finish(row: Row, state: 'sent' | 'dropped'): Promise<void> {
    await this.db.query('UPDATE push_notifications SET state = $3 WHERE workstream = $1 AND position = $2', [row.workstream, row.position, state])
    this.report({ workstream: row.workstream, position: row.position, outcome: state === 'sent' ? 'succeeded' : 'refused' })
  }

  /** Whether the card is still pending for the person, and the whole seconds left to the notification's end. */
  private async still(row: Row): Promise<number> {
    const left = Math.floor((row.expires_at.getTime() - Date.now()) / 1000)
    if (left <= 0) return 0
    return (await this.pending(row.owner, { workstream: row.workstream, position: row.position })).length > 0 ? left : 0
  }

  /**
   * One attempt: every subscription not yet done, the card read again before each request, its time to live counted
   * again; each answer recorded as it comes (docs/specs/notifications.md, "Sending"), so that a stop or a failure in
   * the middle repeats none of those before it.
   */
  private async attempt(row: Row): Promise<void> {
    if ((await this.still(row)) === 0) return this.finish(row, row.delivered ? 'sent' : 'dropped')
    const subscriptions = (
      await this.db.query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE owner = $1 AND NOT (endpoint = ANY($2::text[])) ORDER BY created_at, endpoint', [row.owner, row.done])
    ).rows as Subscription[]
    if (subscriptions.length === 0) return this.finish(row, row.delivered ? 'sent' : 'dropped')
    const payload = messageOf({ origin: this.options.origin, workstream: row.workstream, position: row.position, kind: row.kind, title: row.title, body: row.body, badge: (await this.pending(row.owner)).length })
    const done = [...row.done]
    let delivered = row.delivered
    let wait = 0
    let retry = false
    for (const subscription of subscriptions) {
      if (this.stopped) return
      // Answered, expired or withdrawn during the requests before: the rest are not sent.
      const left = await this.still(row)
      if (left === 0) return this.finish({ ...row, done, delivered }, delivered ? 'sent' : 'dropped')
      const host = hostOf(subscription.endpoint)
      let status = 0
      let retryAfter: string | null = null
      try {
        const details = generateRequestDetails({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, {
          TTL: left,
          urgency: 'high',
          topic: row.workstream.replaceAll('-', ''),
          contentEncoding: 'aes128gcm',
          vapidDetails: { subject: this.options.subject, publicKey: this.options.publicKey, privateKey: this.options.privateKey },
        })
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(details.headers)) headers[name] = String(value)
        ;({ status, retryAfter } = await this.send(subscription.endpoint, { headers, body: details.body ?? Buffer.alloc(0) }))
      } catch {
        status = 0
      }
      this.report({ workstream: row.workstream, position: row.position, host, status, outcome: status >= 200 && status < 300 ? 'succeeded' : 'failed', ...(status === 0 ? { errorClass: 'transport' } : {}) })
      if (status === 0 || status === 429 || status >= 500) {
        retry = true
        const seconds = retryAfter === null ? NaN : /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : (Date.parse(retryAfter) - Date.now()) / 1000
        if (Number.isFinite(seconds)) wait = Math.max(wait, seconds * 1000)
        continue
      }
      // Gone: the push service will take nothing more for it.
      if (status === 404 || status === 410) await this.db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [subscription.endpoint])
      const ok = status >= 200 && status < 300
      // Recorded before the next request: a failure here stops the attempt, and only this subscription may be sent again.
      await this.db.query('UPDATE push_notifications SET done = array_append(done, $3), delivered = delivered OR $4 WHERE workstream = $1 AND position = $2', [row.workstream, row.position, subscription.endpoint, ok])
      done.push(subscription.endpoint)
      delivered ||= ok
    }
    if (!retry) return this.finish({ ...row, done, delivered }, delivered ? 'sent' : 'dropped')
    const delays = this.options.retryMs ?? RETRY_MS
    const delay = Math.max(wait, delays[Math.min(row.attempts, delays.length - 1)] ?? 0)
    if (Date.now() + delay >= row.expires_at.getTime()) return this.finish({ ...row, done, delivered }, delivered ? 'sent' : 'dropped')
    await this.db.query('UPDATE push_notifications SET attempts = attempts + 1, next_at = $3 WHERE workstream = $1 AND position = $2', [row.workstream, row.position, new Date(Date.now() + delay)])
  }
}
