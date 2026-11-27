// docs/specs/preview.md, acceptance cases V2 to V6, V8 to V10, V12: the server started as a preview, and its client in a real
// browser (Playwright's Chromium) behind the headers of the previews' two gates.
//
// Two ways to run it:
// - from the log package, which provisions PostgreSQL (`npm run test:browser`): each case starts the server's
//   process from the repository, `PREVIEW=true`, on an empty database of its own whose one login owns it;
// - against the image (CI, `.github/workflows/preview.yml`): `PREVIEW_URL` is the running image, on an empty
//   database, `PREVIEW_CONTAINER` its container in a network that only lets its database through. The cases
//   that start a process of their own are skipped; V6 runs only there.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright'
import { freePort, provisioning, Relay, until } from '../../../../packages/log/test/support.ts'

const IMAGE_URL = process.env.PREVIEW_URL
const CONTAINER = process.env.PREVIEW_CONTAINER
const local = IMAGE_URL === undefined
const MAIN = new URL('../../../server/src/main.ts', import.meta.url).pathname
/** agora_gateway_previews, the gateway's client at Pocket-ID: what the gateway gate names (infra-k8s ADR 0017, 2026-10-27). */
const GATEWAY_CLIENT = 'client-f373fa14-edf1-435b-8949-537c02bb5d50'
const HOST = 'pr-1-agora.preview.bretagne.dev'
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

/** What the browser gate (oauth2-proxy, OIDC, `ALLOWED_GROUPS=admin`) passes the app, behind Traefik. */
const BROWSER_GATE = {
  'x-forwarded-email': 'person@example.org',
  'x-forwarded-user': 'b1f0c6a2-3f5e-4d8a-9c1e-2a7b9d4e6f10',
  'x-forwarded-preferred-username': 'person',
  'x-forwarded-groups': 'admin',
  authorization: basic('b1f0c6a2-3f5e-4d8a-9c1e-2a7b9d4e6f10', ''),
  'x-forwarded-proto': 'https',
  'x-forwarded-host': HOST,
}
/** What the gateway gate passes the app for Agora's gateway: its mark, `Basic client-<id>:none`, the client as the user. */
const GATEWAY_GATE = {
  'x-agora-gate': 'gateway',
  authorization: basic(GATEWAY_CLIENT, 'none'),
  'x-forwarded-email': GATEWAY_CLIENT,
  'x-forwarded-user': GATEWAY_CLIENT,
  'x-forwarded-proto': 'https',
  'x-forwarded-host': HOST,
}

/**
 * The conversations an empty database gets: each mark of the mock's history, the three real harnesses', a
 * delegation — its delegator listed, its delegate under it —, and two conversations waiting on a form.
 */
const SEEDED = { total: 15, listed: 14, mock: 11, harnesses: ['claude-code', 'codex', 'opencode'] }
/** The conversations waiting on a form: one question of options, and two questions. */
const FORMS = { select: 'Pick the service’s database', flow: 'Plan the release checks' }
/** The delegation's delegator, by its title. */
const DELEGATOR = 'Ship the release notes'

let browser: Browser
/**
 * The image reached on the loopback, as a gate forwards to it: a page served from the container's own address
 * over plain HTTP is no secure context, which a preview's HTTPS host is, and the client needs one (`crypto.randomUUID`).
 */
let relay: Relay | undefined
let imageUrl = ''

before(async () => {
  assert.ok(existsSync(new URL('../../dist/index.html', import.meta.url)) || !local, 'the client is built first: npm run build -w @agora/web')
  browser = await chromium.launch()
  if (!local) {
    relay = await new Relay(() => new URL(IMAGE_URL!).host).listen()
    imageUrl = `http://127.0.0.1:${String(relay.port)}`
  }
})
after(async () => {
  await browser?.close()
  await relay?.close()
})

/** An empty database whose one login owns it and may create no role, as CloudNativePG's `initdb` makes it. */
async function emptyDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const admin = provisioning()
  const name = `agora_preview_${randomBytes(4).toString('hex')}`
  const password = randomBytes(12).toString('hex')
  await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '${password}'`)
  await admin.query(`CREATE DATABASE ${name} OWNER ${name}`)
  const url = new URL(String(process.env.LOG_TEST_ADMIN_URL))
  url.username = name
  url.password = password
  url.pathname = `/${name}`
  return {
    url: url.href,
    async drop() {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.query(`DROP ROLE IF EXISTS ${name}`)
      await admin.end()
    },
  }
}

/** The server's process as a preview: only what a preview is given, nothing of this process's environment. */
async function startPreview(env: Record<string, string>): Promise<{ url: string; child: ChildProcess; output: () => string; exited: Promise<number | null>; stop(): Promise<void> }> {
  const [port, anchorPort, mcpPort] = [await freePort(), await freePort(), await freePort()]
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: String(process.env.PATH), HOME: String(process.env.HOME), PREVIEW: 'true', PORT: String(port), ANCHOR_PORT: String(anchorPort), MCP_PORT: String(mcpPort), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  await until('the preview listening, or gone', () => output.includes('anchor receiver on') || child.exitCode !== null, 30_000)
  return {
    url: `http://127.0.0.1:${String(port)}`,
    child,
    output: () => output,
    exited,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM')
      await exited
    },
  }
}

/** The preview the browser cases run against: the image, or a process of the case's own on an empty database. */
async function target(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  if (!local) return imageUrl
  const db = await emptyDatabase()
  const preview = await startPreview({ PREVIEW_DATABASE_URL: db.url })
  t.after(async () => {
    await preview.stop()
    await db.drop()
  })
  assert.equal(preview.child.exitCode, null, preview.output())
  return preview.url
}

async function behind(gate: Record<string, string>): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light', extraHTTPHeaders: gate })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  return page
}

const rows = (page: Page) => page.locator('nav[aria-label="Workstreams"] button[title]')
const composer = (page: Page) => page.getByPlaceholder(/Describe the task|Write to the agent/)

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

/** A list read as the client reads it, through a gate: its rows' harness, state and title. */
async function listed(url: string, gate: Record<string, string>): Promise<{ id: string; harness: string; state: string; title: string }[]> {
  const response = await fetch(`${url}/api/workstreams/page`, { headers: gate })
  assert.equal(response.status, 200)
  return ((await response.json()) as { rows: { id: string; harness: string; state: string; title: string }[] }).rows
}

/**
 * The case itself, through one gate: the client on `/`, the conversations already there, a new one with the mock
 * agent, a message, and its answer arriving while the turn runs.
 */
async function converse(url: string, gate: Record<string, string>, text: string): Promise<string> {
  const page = await behind(gate)
  try {
    const home = await fetch(`${url}/`, { headers: gate })
    assert.equal(home.status, 200)
    assert.match(home.headers.get('content-type') ?? '', /^text\/html/)
    assert.match(await home.text(), /<div id="root">/)
    await page.goto(`${url}/`)
    // The conversations of the first start, before anything is done.
    await until('the conversations listed', async () => (await rows(page).count()) >= SEEDED.listed)
    const before = await listed(url, gate)
    assert.ok(before.length >= SEEDED.listed, `${String(before.length)} conversations`)
    // A new one, with the mock agent: its first answer, then a turn whose answer arrives second by second.
    await page.getByRole('button', { name: 'Harness' }).click()
    await page.getByRole('menuitem', { name: /Mock agent/ }).click()
    await send(page, text)
    await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
    await page.locator('main').getByText(`Echo #1: ${text}.`).waitFor()
    const id = /\/w\/([0-9a-f-]{36})$/.exec(new URL(page.url()).pathname)![1]!
    await send(page, '/sleep 4')
    await page.locator('main').getByText('… second 1/4').waitFor()
    // Live: the first second is on the screen while the turn still runs, the end arrives without a reload.
    assert.equal(await page.locator('main').getByText('Slept 4 s.').count(), 0, 'the turn still runs')
    await page.locator('main').getByText('Slept 4 s.').waitFor({ timeout: 20_000 })
    // In the list, through the same gate.
    const after = await listed(url, gate)
    const row = after.find((r) => r.id === id)
    assert.ok(row, 'the new conversation is listed')
    assert.equal(row.harness, 'mock')
    return id
  } finally {
    await page.context().close()
  }
}

test('V2 a preview given anything of production, or no database, does not start', { skip: !local }, async () => {
  const none = await startPreview({})
  assert.equal(await none.exited, 1)
  assert.match(none.output(), /PREVIEW_DATABASE_URL is required/)
  for (const [name, value] of [
    ['SANDBOX_NAMESPACE', 'agora-sandboxes'],
    ['SIGNING_KEY_FILE', '/etc/agora/signing/private.pem'],
    ['LOG_WRITER_URL', 'postgresql://writer@agora-pg-rw/agora'],
    ['FILES_ACCESS_KEY_ID', 'key'],
    ['GATEWAY_PROXY', 'gateway.agora-gateway.svc.cluster.local:3000'],
    ['GRANTS_KEY_FILE', '/etc/agora/grants/private.pem'],
  ] as const) {
    const refused = await startPreview({ PREVIEW_DATABASE_URL: 'postgresql://agora:agora@127.0.0.1:1/agora', [name]: value })
    assert.equal(await refused.exited, 1, name)
    assert.match(refused.output(), new RegExp(`PREVIEW excludes ${name}`))
    assert.ok(!refused.output().includes('server ready'), name)
  }
})

test('V3 the first start on an empty database writes the conversations once: every mark of the mock history, the three harnesses', { skip: !local }, async (t) => {
  const db = await emptyDatabase()
  t.after(() => db.drop())
  const first = await startPreview({ PREVIEW_DATABASE_URL: db.url })
  assert.equal(first.child.exitCode, null, first.output())
  assert.match(first.output(), new RegExp(`- preview: ${String(SEEDED.total)} conversations written`))
  const rowsOf = await until('the list', async () => {
    const r = await listed(first.url, BROWSER_GATE)
    return r.length === SEEDED.listed ? r : undefined
  })
  const mock = rowsOf.filter((r) => r.harness === 'mock')
  assert.equal(mock.length, SEEDED.mock)
  // The states the mock history went through (its marks), as the list shows them.
  assert.deepEqual([...new Set(mock.map((r) => r.state))].sort(), ['ended', 'interrupted', 'lost', 'ready', 'stopped'])
  assert.deepEqual(rowsOf.filter((r) => r.harness !== 'mock').map((r) => r.harness).sort(), SEEDED.harnesses)
  // Through the other gate: the same conversations, everyone's.
  assert.deepEqual((await listed(first.url, GATEWAY_GATE)).map((r) => r.id).sort(), rowsOf.map((r) => r.id).sort())
  await first.stop()
  // A second start on the same database: nothing written again, nothing lost.
  const second = await startPreview({ PREVIEW_DATABASE_URL: db.url })
  t.after(() => second.stop())
  assert.equal(second.child.exitCode, null, second.output())
  assert.ok(!second.output().includes('conversations written'))
  assert.deepEqual((await listed(second.url, BROWSER_GATE)).map((r) => r.id).sort(), rowsOf.map((r) => r.id).sort())
})

test('V4 behind the browser gate: the client on /, the conversations listed, a new one with the mock agent answered live', async (t) => {
  const url = await target(t)
  await converse(url, BROWSER_GATE, 'Hello from the browser gate')
})

test('V5 behind the gateway gate: the same, and what one gate made is listed through the other', async (t) => {
  const url = await target(t)
  const id = await converse(url, GATEWAY_GATE, 'Hello from the gateway gate')
  assert.ok((await listed(url, BROWSER_GATE)).some((r) => r.id === id), 'listed through the browser gate')
})

test('V8 the delegation among the conversations: its delegator waiting for you, its delegate waiting for you under it, Agora’s message naming its request; a permission the mock agent asks: its row waiting for you, its card; Allow: answered, waiting no more', async (t) => {
  const url = await target(t)
  const page = await behind(BROWSER_GATE)
  try {
    await page.goto(`${url}/`)
    const nav = page.getByRole('navigation', { name: 'Workstreams' })
    const delegator = nav.locator('button[title]').filter({ hasText: DELEGATOR })
    await delegator.getByText('waiting for you').waitFor()
    await delegator.click()
    // The delegate's last message, come during a command of its delegator's: folded with it.
    await page.locator('main [data-tool-fold]').getByText('1 command, 1 message', { exact: true }).waitFor()
    // Agora's message, a line of the delegator's response: opened, what it says.
    const agora = page.locator('main [data-agora]').last()
    await agora.getByText(/^From Agora · /).waitFor()
    await agora.locator('button[aria-expanded]').first().click()
    await agora.locator('[data-message-text]').getByText(/it waits for an answer to its request \d+: a permission\./).waitFor()
    assert.match(await agora.locator('[data-message-text]').innerText(), /allow-once: Allow \(allow_once\)/)
    // Its lines naming the delegate — its `spawn_agent`, then its `send_message` —, each waiting for you.
    await page.locator('main [data-delegate]').first().getByText('waiting for you').waitFor()
    assert.equal(await page.locator('main [data-delegate]').getByText('waiting for you').count(), 2)
    await nav.getByRole('button', { name: 'Unfold' }).click()
    await nav.getByRole('group').locator('button[title]').getByText('waiting for you').waitFor()
    // A permission asked live, in a conversation of the person's.
    await page.goto(`${url}/`)
    await page.getByRole('button', { name: 'Harness' }).click()
    await page.getByRole('menuitem', { name: /Mock agent/ }).click()
    await send(page, '/permission')
    await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
    await page.getByText('asks before it goes on').waitFor()
    const mine = nav.locator('button[aria-current="page"]')
    await mine.getByText('waiting for you').waitFor()
    await page.getByRole('button', { name: 'Allow', exact: true }).click()
    await page.locator('main').getByText('Permission: allow-once.').waitFor()
    await until('waiting no more', async () => (await mine.getByText('waiting for you').count()) === 0)
    assert.equal(await page.getByText('asks before it goes on').count(), 0)
  } finally {
    await page.context().close()
  }
})

test('V9 the forms among the conversations: one waiting on a question of options, its select card; one waiting on two questions, its Question Flow; a form the mock agent asks live, answered through its card', async (t) => {
  const url = await target(t)
  const page = await behind(BROWSER_GATE)
  try {
    await page.goto(`${url}/`)
    const nav = page.getByRole('navigation', { name: 'Workstreams' })
    for (const [shape, title] of Object.entries(FORMS)) {
      const row = nav.locator('button[title]').filter({ hasText: title })
      await row.getByText('waiting for you').waitFor()
      await row.click()
      const card = page.locator(`main [data-form="${shape}"][data-form-status="pending"]`)
      await card.getByText('waiting for you').waitFor()
      assert.match(await card.innerText(), /Which database should the service use\?[\s\S]*PostgreSQL[\s\S]*SQLite/)
      if (shape === 'flow') await card.getByText('1 of 2').waitFor()
    }
    // A form asked live, in a conversation of the person's.
    await page.goto(`${url}/`)
    await page.getByRole('button', { name: 'Harness' }).click()
    await page.getByRole('menuitem', { name: /Mock agent/ }).click()
    await send(page, '/question')
    await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
    const card = page.locator('main [data-form="select"]')
    await card.getByText('waiting for you').waitFor()
    await card.getByRole('radio', { name: /PostgreSQL/ }).click()
    await card.getByRole('button', { name: 'Answer' }).click()
    await page.locator('main').getByText('Elicitation: accept {"question_0":"PostgreSQL"}.').waitFor()
    await page.locator('main [data-form="select"][data-form-status="answered"]').waitFor()
  } finally {
    await page.context().close()
  }
})

test('V10 the fixed offer: GET /api/config offers what each entry of the access picker folds, no base profile, and signs for none; the picker shows them, no harness’s service, an entry ticked in its menu', async (t) => {
  const url = await target(t)
  const config = (await (await fetch(`${url}/api/config`, { headers: BROWSER_GATE })).json()) as { credentials: { proxy: unknown; offered: unknown } }
  assert.equal(config.credentials.proxy, null, 'no gateway')
  assert.deepEqual(config.credentials.offered, ['internet', 'github:example/app:write', 'github:example/docs:write', 'github:example/site:read', 'vault:write', 'kubernetes:read', 'agora:delegate'])
  // Nothing is sent: against the image, the cases before this one hold every place a Create may take (MAX_ACTIVE).
  const page = await behind(BROWSER_GATE)
  try {
    await page.goto(`${url}/`)
    await page.getByRole('button', { name: 'Harness' }).click()
    await page.getByRole('menuitem', { name: /Mock agent/ }).click()
    // The key alone on the composer, the Internet granted by default.
    await page.getByRole('button', { name: 'Access: Internet', exact: true }).click()
    const menu = page.getByRole('menu', { name: 'Access' })
    // The Internet the one service: no harness's or model's (docs/specs/credentials.md, "Base profiles").
    assert.deepEqual(await menu.getByRole('menuitemcheckbox').allInnerTexts(), [
      'Internet',
      'GitHub\nexample/app, example/docs, example/site (read)',
      'vault',
      'k8s',
      'agora',
    ])
    await menu.getByRole('menuitemcheckbox', { name: /^GitHub/ }).click()
    await menu.getByRole('menuitemcheckbox', { name: /^GitHub/, checked: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Access: Internet, GitHub', exact: true }).waitFor()
  } finally {
    await page.context().close()
  }
})

test('V12 the fixed limits: GET /api/limits answers four invented subscriptions, their resets counted from the request; the header\'s gauge shows them', async (t) => {
  const url = await target(t)
  const asked = Date.now()
  const response = await fetch(`${url}/api/limits`, { headers: BROWSER_GATE })
  assert.equal(response.status, 200)
  const { limits } = (await response.json()) as { limits: Record<string, { windows: { kind: string; usedPercent: number; resetsAt: string }[]; plan: string | null; checkedAt: string; stale: boolean; error: string | null }> }
  const answered = Date.now()
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR
  // Each instant counted from the request: between when it was asked and when it was answered.
  const from = (at: string, offset: number) => {
    const ms = Date.parse(at) - offset
    assert.ok(ms >= asked - 1000 && ms <= answered + 1000, `${at}: ${String(offset)} ms from the request`)
  }
  assert.deepEqual(Object.keys(limits), ['anthropic', 'antigravity', 'chatgpt', 'zai'])
  const expected = {
    anthropic: { plan: null, stale: false, error: null, checked: 0, windows: [['five_hour', 42, 2 * HOUR + 10 * MINUTE], ['weekly', 68, 3 * DAY + 4 * HOUR]] },
    antigravity: { plan: null, stale: false, error: null, checked: 0, windows: [['five_hour', 20, 3 * HOUR + 5 * MINUTE], ['weekly', 35, 6 * DAY + 2 * HOUR]] },
    chatgpt: { plan: 'pro', stale: false, error: null, checked: 0, windows: [['five_hour', 12, 4 * HOUR + 25 * MINUTE], ['weekly', 88, DAY + 6 * HOUR]] },
    zai: { plan: 'lite', stale: true, error: 'api.z.ai answered 503', checked: -40 * MINUTE, windows: [['five_hour', 30, HOUR + 45 * MINUTE], ['weekly', 55, 5 * DAY]] },
  } as const
  for (const [profile, want] of Object.entries(expected)) {
    const account = limits[profile]!
    assert.deepEqual([account.plan, account.stale, account.error], [want.plan, want.stale, want.error], profile)
    from(account.checkedAt, want.checked)
    assert.deepEqual(account.windows.map((w) => [w.kind, w.usedPercent]), want.windows.map(([kind, used]) => [kind, used]), profile)
    for (const [i, w] of account.windows.entries()) from(w.resetsAt, want.windows[i]![2])
  }
  const page = await behind(BROWSER_GATE)
  try {
    await page.goto(`${url}/`)
    await page.locator('header').getByRole('button', { name: 'Limits' }).click()
    const popover = page.locator('[data-slot=limits-popover]')
    await popover.getByRole('region', { name: 'z.ai' }).waitFor()
    const sections = await popover.locator('section').evaluateAll((s) => s.map((e) => [e.getAttribute('aria-label'), (e as HTMLElement).innerText.trim()]))
    assert.deepEqual(sections.map(([name]) => name), ['Claude', 'Gemini', 'ChatGPT', 'z.ai'])
    assert.match(sections[0]![1]!, /^Claude\s+5-hour\s+42% · resets in 2h 10m\s+Weekly\s+68% · resets in 3d 4h$/)
    assert.match(sections[1]![1]!, /^Gemini\s+5-hour\s+20% · resets in 3h 5m\s+Weekly\s+35% · resets in 6d 2h$/)
    assert.match(sections[2]![1]!, /^ChatGPT\s+pro\s+5-hour\s+12% · resets in 4h 25m\s+Weekly\s+88% · resets in 1d 6h$/i)
    assert.match(sections[3]![1]!, /^z\.ai\s+lite\s+5-hour\s+30% · resets in 1h 45m\s+Weekly\s+55% · resets in 5d\s+Not updated since \d{1,2}:\d{2}/i)
  } finally {
    await page.context().close()
  }
})

test('V6 the image in a network that only lets its database through: no Internet, no Kubernetes API, no secret', { skip: CONTAINER === undefined }, () => {
  const exec = (code: string) => spawnSync('docker', ['exec', CONTAINER!, 'node', '-e', code], { encoding: 'utf8', timeout: 60_000 })
  // Positive control: what the preview is given, it reaches — its database.
  const database = exec(`const u=new URL(process.env.PREVIEW_DATABASE_URL);require('net').connect(Number(u.port||5432),u.hostname).on('connect',()=>{console.log('reached');process.exit(0)}).on('error',(e)=>{console.log(e.code);process.exit(1)})`)
  assert.equal(database.stdout.trim(), 'reached', database.stderr)
  // The Internet, by name and by address: refused or unresolved.
  for (const address of ['https://github.com/', 'https://1.1.1.1/', 'https://kubernetes.default.svc/']) {
    const out = exec(`fetch(${JSON.stringify(address)},{signal:AbortSignal.timeout(10000)}).then(()=>{console.log('reached');process.exit(0)},(e)=>{console.log(String(e.cause?.code??e.name));process.exit(1)})`)
    assert.notEqual(out.stdout.trim(), 'reached', address)
    assert.notEqual(out.status, 0, address)
  }
  // No ServiceAccount token, no Kubernetes service in its environment, nothing of production's.
  const environment = exec(`const fs=require('fs');console.log(JSON.stringify({token:fs.existsSync('/var/run/secrets/kubernetes.io'),kube:process.env.KUBERNETES_SERVICE_HOST??null,names:Object.keys(process.env).sort()}))`)
  const seen = JSON.parse(environment.stdout) as { token: boolean; kube: string | null; names: string[] }
  assert.equal(seen.token, false)
  assert.equal(seen.kube, null)
  for (const name of ['SANDBOX_NAMESPACE', 'SIGNING_KEY_FILE', 'LOG_WRITER_URL', 'FILES_ACCESS_KEY_ID', 'GATEWAY_PROXY', 'GRANTS_KEY_FILE']) assert.ok(!seen.names.includes(name), name)
  const network = spawnSync('docker', ['inspect', CONTAINER!, '--format', '{{json .NetworkSettings.Networks}}'], { encoding: 'utf8' })
  const networks = Object.keys(JSON.parse(network.stdout) as Record<string, unknown>)
  assert.equal(networks.length, 1)
  const internal = spawnSync('docker', ['network', 'inspect', networks[0]!, '--format', '{{.Internal}}'], { encoding: 'utf8' })
  assert.equal(internal.stdout.trim(), 'true')
})
