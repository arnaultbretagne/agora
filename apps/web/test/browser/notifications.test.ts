// docs/specs/notifications.md, acceptance cases N12–N14: the built client in a real browser (Playwright's Chromium)
// against the real server with its VAPID keys — the log on PostgreSQL, the mechanics on FakeKube, real bridges and the
// mock agent. Headless Chromium reaches no push service and shows no notification: its PushManager, its permission and,
// in the service worker, its notifications' display stand in — the subscription's keys made here, the permission the
// one a person would give. A push is delivered to the real service worker through the DevTools protocol
// (`ServiceWorker.deliverPushMessage`); what the page reads of the notifications shown is the test's.
// Run from the log package, which provisions the database: `npm run test:browser`.
import assert from 'node:assert/strict'
import { createECDH, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { cluster, database, Server, until, type Db } from '../../../../packages/log/test/support.ts'
import { identity } from '../../../../packages/log/src/index.ts'

let db: Db
let c: Awaited<ReturnType<typeof cluster>>
let server: Server
let browser: Browser
/** The client's origin: the same across a restart of the server, as a browser keeps its storage by origin. */
let base: string
const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status
const command = (workstream: string, kind: string, target: unknown, body: unknown) => post(`/api/workstreams/${workstream}/commands`, { id: randomUUID(), kind, target, body })
const PERSON = 'person@example.org'
const OWNER = identity('owner', PERSON)
/** A VAPID key pair, P-256, base64url: the public key uncompressed, the private key its 32 bytes. */
function generateVAPIDKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') }
}
const env = (keys: { publicKey: string; privateKey: string }) => ({
  MAX_ACTIVE: '20',
  PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
  PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
  PUSH_SUBJECT: 'mailto:operator@example.org',
  PUBLIC_URL: 'http://127.0.0.1',
})

before(async () => {
  assert.ok(existsSync(new URL('../../dist/index.html', import.meta.url)), 'the client is built first: npm run build -w @agora/web')
  db = await database()
  c = await cluster()
  server = await Server.start({ db, api: c.api, keys: c.keys, env: env(generateVAPIDKeys()) })
  base = server.url
  c.kube.anchorUrl = server.anchorUrl
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await server?.stop()
  await c?.close()
  await db?.drop()
})

/**
 * A browser behind the proxy, its PushManager standing in for a push service it cannot reach: a subscription to an
 * FCM endpoint, with keys made here, kept in the page's storage as a browser keeps its own; each call counted. The
 * permission is the person's answer to the prompt; the notifications the page reads, those given.
 */
async function browserWith(permission: 'granted' | 'denied', shown: { workstream: string; position: string }[] = [], failing = false): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, extraHTTPHeaders: { 'x-forwarded-email': PERSON } })
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }
  await context.addInitScript(
    ({ keys, permission, shown, failing }) => {
      const KEY = 'agora-test:subscription'
      const GIVEN = 'agora-test:permission'
      const w = window as unknown as { pushCalls: string[]; badges: number[]; closedCards: string[] }
      w.pushCalls = []
      w.badges = []
      w.closedCards = []
      // The person's answer to the prompt, kept as a browser keeps it.
      Object.defineProperty(Notification, 'permission', { get: () => (permission === 'denied' ? 'denied' : (localStorage.getItem(GIVEN) ?? 'default')) })
      Notification.requestPermission = async () => {
        w.pushCalls.push('permission')
        if (permission === 'granted') localStorage.setItem(GIVEN, 'granted')
        return permission
      }
      // The notifications shown, as the page reads them: each closed, recorded.
      ServiceWorkerRegistration.prototype.getNotifications = async () =>
        shown.map((data) => ({ data, close: () => void w.closedCards.push(`${data.workstream}:${data.position}`) }) as unknown as Notification)
      const bytes = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0)).buffer
      const make = (json: { endpoint: string }, key: ArrayBuffer) => ({
        endpoint: json.endpoint,
        options: { applicationServerKey: key, userVisibleOnly: true },
        toJSON: () => json,
        unsubscribe: async () => {
          w.pushCalls.push('unsubscribe')
          // A browser failing to drop its subscription keeps it.
          if (failing) throw new DOMException('unsubscribe failed', 'InvalidStateError')
          localStorage.removeItem(KEY)
          return true
        },
      })
      PushManager.prototype.getSubscription = async function () {
        const held = localStorage.getItem(KEY)
        if (held === null) return null
        const { json, key } = JSON.parse(held) as { json: { endpoint: string }; key: string }
        return make(json, bytes(key)) as unknown as PushSubscription
      }
      PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
        const key = new Uint8Array(options!.applicationServerKey as ArrayBuffer)
        w.pushCalls.push(`subscribe:${String(options!.userVisibleOnly)}`)
        const json = { endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`, expirationTime: null, keys }
        localStorage.setItem(KEY, JSON.stringify({ json, key: btoa(String.fromCharCode(...key)) }))
        return make(json, key.buffer) as unknown as PushSubscription
      }
      navigator.setAppBadge = async (n?: number) => void w.badges.push(n ?? 0)
      navigator.clearAppBadge = async () => void w.badges.push(0)
    },
    { keys, permission, shown, failing },
  )
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  return { context, page }
}

const stored = async () => (await db.admin.query('SELECT endpoint, owner FROM push_subscriptions ORDER BY created_at')).rows as { endpoint: string; owner: string }[]
const item = (page: Page) => page.locator('[data-notifications]')
async function openMenu(page: Page): Promise<void> {
  await page.goto(`${base}/`)
  await page.getByRole('button', { name: 'Account' }).click()
}

test('N12 Notifications turned on, the permission granted: subscribed with the server’s key; the key changed, the client started again: replaced; turned off: removed; the permission denied: blocked, nothing stored', async () => {
  await db.admin.query('DELETE FROM push_subscriptions')
  const { context, page } = await browserWith('granted')
  await openMenu(page)
  await until('off', async () => (await item(page).getAttribute('data-notifications')) === 'off')
  assert.equal(await item(page).textContent(), 'Notifications: off')
  await item(page).click()
  await until('on', async () => (await item(page).getAttribute('data-notifications')) === 'on')
  assert.equal(await item(page).textContent(), 'Notifications: on')
  const [first] = await stored()
  assert.equal((await stored()).length, 1)
  assert.equal(first!.owner, OWNER)
  assert.ok(first!.endpoint.startsWith('https://fcm.googleapis.com/fcm/send/'))
  assert.deepEqual(await page.evaluate(() => (window as unknown as { pushCalls: string[] }).pushCalls), ['permission', 'subscribe:true'])
  // Another key: the server started again with it, on the same address, the client too.
  await server.stop()
  server = await Server.start({ db, api: c.api, keys: c.keys, env: { ...env(generateVAPIDKeys()), PORT: new URL(base).port } })
  c.kube.anchorUrl = server.anchorUrl
  await page.goto(`${base}/`)
  await until('replaced', async () => {
    const now = await stored()
    return now.length === 1 && now[0]!.endpoint !== first!.endpoint
  })
  assert.deepEqual(await page.evaluate(() => (window as unknown as { pushCalls: string[] }).pushCalls), ['unsubscribe', 'subscribe:true'])
  await page.getByRole('button', { name: 'Account' }).click()
  await until('on again', async () => (await item(page).getAttribute('data-notifications')) === 'on')
  await item(page).click()
  await until('off again', async () => (await item(page).getAttribute('data-notifications')) === 'off')
  assert.equal((await stored()).length, 0)
  await context.close()
  const denied = await browserWith('denied')
  await openMenu(denied.page)
  await until('blocked', async () => (await item(denied.page).getAttribute('data-notifications')) === 'blocked')
  assert.equal(await item(denied.page).textContent(), 'Notifications are blocked in this browser’s settings')
  assert.equal(await item(denied.page).getAttribute('data-disabled'), '')
  assert.equal((await stored()).length, 0)
  await denied.context.close()
})

/** A Workstream of the person's whose agent asks a form: its id, once its card is pending. */
async function asking(): Promise<{ id: string; position: string }> {
  const id = randomUUID()
  assert.equal(await post('/api/workstreams', { id, owner: OWNER }), 200)
  assert.equal(await command(id, 'Create', {}, { pool: 'mock-test', prompt: [{ type: 'text', text: '/question' }] }), 200)
  return until(
    'its form pending',
    async () => {
      const r = await fetch(`${base}/api/push/pending?owner=${OWNER}`)
      const cards = ((await r.json()) as { cards: { workstream: string; position: string }[] }).cards
      const card = cards.find((c) => c.workstream === id)
      return card ? { id, position: card.position } : null
    },
    30_000,
  )
}

/**
 * The service worker's notifications' display and badge, standing in: what it shows and sets, recorded there. The
 * headless shell has neither, and its worker ends on a badge set.
 */
async function displayed(context: BrowserContext, page: Page): Promise<() => Promise<Record<string, unknown>[]>> {
  await page.evaluate(() => navigator.serviceWorker.ready)
  const worker = context.serviceWorkers().find((w) => w.url().endsWith('/sw.js')) ?? (await context.waitForEvent('serviceworker'))
  await worker.evaluate(() => {
    const g = self as unknown as { shown: unknown[]; registration: ServiceWorkerRegistration; navigator: { setAppBadge: (n?: number) => Promise<void>; clearAppBadge: () => Promise<void> } }
    g.shown = []
    g.registration.showNotification = async (title: string, options?: NotificationOptions) => void g.shown.push({ title, body: options?.body, tag: options?.tag, data: options?.data })
    g.navigator.setAppBadge = async (n?: number) => void g.shown.push({ badge: n ?? 0 })
    g.navigator.clearAppBadge = async () => void g.shown.push({ badge: 0 })
  })
  // Through JSON: what is not set is left out.
  return async () => JSON.parse(await worker.evaluate(() => JSON.stringify((self as unknown as { shown: unknown[] }).shown))) as Record<string, unknown>[]
}

/** Pushes delivered to the page's service worker, as a push service delivers them; the DevTools protocol attached first. */
async function pusher(context: BrowserContext, page: Page): Promise<(message: unknown) => Promise<void>> {
  const cdp = await context.newCDPSession(page)
  const registrations: { registrationId: string; scopeURL: string }[] = []
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: { registrationId: string; scopeURL: string }[] }) => registrations.push(...e.registrations))
  await cdp.send('ServiceWorker.enable')
  const registration = await until('the registration', () => registrations.find((r) => r.scopeURL === `${base}/`))
  return async (message) => void (await cdp.send('ServiceWorker.deliverPushMessage', { origin: base, registrationId: registration.registrationId, data: JSON.stringify(message) }))
}
const message = (workstream: string, position: string, badge: number) => ({
  web_push: 8030,
  notification: {
    title: 'Pick a database',
    body: 'Question · Which database should the service use?',
    navigate: `${base}/w/${workstream}`,
    tag: workstream,
    data: { workstream, position, kind: 'form' },
    app_badge: String(badge),
  },
})

test('N13 a push for a Workstream: the badge, then the notification shown with its title, body and tag, its data; a payload not Agora’s: “Agora”', async () => {
  const { context, page } = await browserWith('granted')
  await page.goto(`${base}/`)
  await page.evaluate(() => navigator.serviceWorker.ready)
  const deliver = await pusher(context, page)
  const shown = await displayed(context, page)
  const ws = randomUUID()
  await deliver(message(ws, '7', 1))
  const first = await until('shown', async () => ((await shown()).length === 2 ? shown() : null))
  assert.deepEqual(first, [
    { badge: 1 },
    { title: 'Pick a database', body: 'Question · Which database should the service use?', tag: ws, data: { workstream: ws, position: '7', kind: 'form', navigate: `${base}/w/${ws}` } },
  ])
  await deliver({ hello: 'world' })
  await until('the other shown', async () => ((await shown()).length === 3 ? true : null))
  assert.deepEqual((await shown())[2], { title: 'Agora' })
  await context.close()
})

test('N14 two notifications shown, one card answered elsewhere; the client opened: that one closed, the other kept, the badge the cards pending', async () => {
  const [one, two] = [await asking(), await asking()]
  const { context, page } = await browserWith('granted', [
    { workstream: one.id, position: one.position },
    { workstream: two.id, position: two.position },
  ])
  await page.goto(`${base}/`)
  await until('the badge set while both wait', async () => ((await page.evaluate(() => (window as unknown as { badges: number[] }).badges)).length > 0 ? true : null))
  assert.deepEqual(await page.evaluate(() => (window as unknown as { closedCards: string[] }).closedCards), [])
  // Answered from another device: the form's answer, as any client sends it.
  const state = (await (await fetch(`${base}/api/push/pending?owner=${OWNER}`)).json()) as { cards: unknown[] }
  const pendingBefore = state.cards.length
  const entries = (await (await fetch(`${base}/api/workstreams/${one.id}/entries`)).json()) as { position: string; execution: string; session: string; rpc_id: unknown }[]
  const form = entries.find((e) => e.position === one.position)!
  assert.equal(await command(one.id, 'RespondElicitation', { execution: form.execution, session: form.session, requestPosition: form.position }, { requestId: form.rpc_id, action: 'decline' }), 200)
  await until('its card answered', async () => {
    const r = (await (await fetch(`${base}/api/push/pending?owner=${OWNER}`)).json()) as { cards: unknown[] }
    return r.cards.length === pendingBefore - 1 ? true : null
  })
  await page.reload()
  await until('the answered one closed', async () => ((await page.evaluate(() => (window as unknown as { closedCards: string[] }).closedCards)).length > 0 ? true : null))
  assert.deepEqual(await page.evaluate(() => (window as unknown as { closedCards: string[] }).closedCards), [`${one.id}:${one.position}`])
  assert.equal((await page.evaluate(() => (window as unknown as { badges: number[] }).badges)).at(-1), pendingBefore - 1)
  await context.close()
})

test('N20 Notifications turned off while the browser fails to drop its subscription: off, removed from the server; the client started again: still off, nothing posted; turned on again: on', async () => {
  await db.admin.query('DELETE FROM push_subscriptions')
  const { context, page } = await browserWith('granted', [], true)
  await openMenu(page)
  await until('off', async () => ((await item(page).getAttribute('data-notifications')) === 'off' ? true : null))
  await item(page).click()
  await until('on', async () => ((await item(page).getAttribute('data-notifications')) === 'on' ? true : null))
  assert.equal((await stored()).length, 1)
  await item(page).click()
  await until('off', async () => ((await item(page).getAttribute('data-notifications')) === 'off' ? true : null))
  assert.equal((await stored()).length, 0)
  const posts: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/push/subscriptions') posts.push(r.url())
  })
  await openMenu(page)
  await until('off after the start', async () => ((await item(page).getAttribute('data-notifications')) === 'off' ? true : null))
  assert.equal(await item(page).textContent(), 'Notifications: off')
  // Started again: the subscription the browser kept is dropped again, never posted.
  await until('dropped again', async () => ((await page.evaluate(() => (window as unknown as { pushCalls: string[] }).pushCalls)).includes('unsubscribe') ? true : null))
  assert.deepEqual(posts, [])
  assert.equal((await stored()).length, 0)
  // The switch alone turns them on again.
  await item(page).click()
  await until('on again', async () => ((await item(page).getAttribute('data-notifications')) === 'on' ? true : null))
  assert.equal((await stored()).length, 1)
  await context.close()
})
