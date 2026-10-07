// docs/specs/assistant-ui.md, acceptance cases U16–U24 and U36–U39: the built client in a real browser (Playwright's
// Chromium), against the real server — the log on PostgreSQL, the mechanics on FakeKube, real bridges and
// the mock agent. Run from the log package, which provisions the database: `npm run test:browser`.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright'
import { claimName } from '../../../../packages/executions/src/manager.ts'
import { cluster, database, expire, Server, until, type Db } from '../../../../packages/log/test/support.ts'

let db: Db
let c: Awaited<ReturnType<typeof cluster>>
let server: Server
let browser: Browser

before(async () => {
  assert.ok(existsSync(new URL('../../dist/index.html', import.meta.url)), 'the client is built first: npm run build -w @agora/web')
  db = await database()
  c = await cluster()
  // As the pools in the cluster: every Session starts with full access.
  c.kube.sessionConfig['mock-test'] = 'mode=full-access'
  // A signer of its own and two repositories offered (docs/specs/credentials.md, "Offered profiles"); the
  // gateway is never reached.
  const grants = join(mkdtempSync(join(tmpdir(), 'grants-')), 'key.pem')
  writeFileSync(grants, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const credentials = { GATEWAY_PROXY: '127.0.0.1:9', GRANTS_KEY_FILE: grants, OFFERED_PROFILES: 'github:owner/a:write,github:owner/b:read' }
  // Room for every case's sandbox: a stopped one counts until its deadline.
  server = await Server.start({ db, api: c.api, keys: c.keys, env: { MAX_ACTIVE: '20', ...credentials } })
  // The Pods push their anchor to the server's receiver, as in the cluster.
  c.kube.anchorUrl = server.anchorUrl
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await server?.stop()
  await c?.close()
  await db?.drop()
})

/** A browser of its own: nothing kept from another case. */
async function fresh(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  return page
}

/** A phone's screen: an iPhone's, touch, its home indicator's 34 px emulated; `insets` changes them. */
async function phone(): Promise<{ page: Page; insets: (bottom: number) => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  const cdp = await context.newCDPSession(page)
  const insets = async (bottom: number) => {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom, left: 0, right: 0 } })
  }
  await insets(34)
  return { page, insets }
}

/** The pickers' texts that do not fit: cut short, or wrapped onto another line. */
const cut = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((elements) =>
    elements.flatMap((element) =>
      [element, ...element.querySelectorAll('span')]
        .filter((e) => e.getClientRects().length > 0 && e.textContent!.trim() !== '')
        .filter((e) => e.scrollWidth > e.clientWidth || e.getClientRects().length > 1 || (e === element && e.getBoundingClientRect().height > 40))
        .map((e) => e.textContent!.trim()),
    ),
  )

/**
 * What a phone's browser colours a bar with, as WebKit's LocalFrameView::fixedContainerEdges finds it:
 * the element 4 px inside the edge's middle, then its ancestors up to the first fixed or sticky one, the
 * first background on the way of one as wide as the screen along that edge; and whether that container
 * covers the whole screen, whose first colour WebKit keeps for good.
 */
const edge = (page: Page, side: 'top' | 'bottom' | 'left') =>
  page.evaluate((side) => {
    const [w, h] = [innerWidth, innerHeight]
    const [x, y] = side === 'top' ? [w / 2, 4] : side === 'bottom' ? [w / 2, h - 4] : [4, h / 2]
    const along = (r: DOMRect) => (side === 'left' ? r.height >= 0.9 * h : r.width >= 0.9 * w)
    let colour: string | null = null
    for (let e = document.elementFromPoint(x, y); e; e = e.parentElement) {
      const style = getComputedStyle(e)
      const box = e.getBoundingClientRect()
      if (colour === null && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && box.width > 10 && box.height > 10 && along(box)) colour = style.backgroundColor
      if (style.position === 'fixed' || style.position === 'sticky') return { whole: box.width >= 0.9 * w && box.height >= 0.9 * h, colour }
    }
    return null
  }, side)
/** The theme toggled, once the page has it. */
async function toggle(page: Page, to: 'light' | 'dark'): Promise<void> {
  await page.getByRole('button', { name: to === 'dark' ? 'Dark theme' : 'Light theme' }).click()
  await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark, to === 'dark')
}
const CREAM = 'rgb(250, 249, 245)'
const DARK = 'rgb(24, 23, 21)'

/** How far the composer ends above the bottom of the screen. */
const composerMargin = (page: Page) => page.locator('main form').evaluate((form) => window.innerHeight - form.getBoundingClientRect().bottom)

/** The state the header shows, after the harness. */
const stateLabel = (page: Page, state: string) => page.locator(`header [data-state="${state}"]`)
const idOf = (page: Page): string => /\/w\/([0-9a-f-]{36})$/.exec(new URL(page.url()).pathname)![1]!
const thread = (page: Page) => page.locator('main')
const composerInput = (page: Page) => page.getByPlaceholder(/Describe the task|Write to the agent/)

async function pickHarness(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Harness' }).click()
  await page.getByRole('menuitem', { name: new RegExp(name) }).click()
}

async function send(page: Page, text: string): Promise<void> {
  await composerInput(page).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

/** A Workstream started from the draft with the mock agent, once the agent answered its first message. */
async function started(page: Page, text: string): Promise<string> {
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await send(page, text)
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText(`Echo #1: ${text}.`).waitFor()
  return idOf(page)
}

const entriesOf = async (id: string) => (await (await fetch(`${server.url}/api/workstreams/${id}/entries`)).json()) as { kind: string; content: Record<string, unknown> }[]
const modelPicker = (page: Page) => page.getByRole('button', { name: 'Model', exact: true })
const accessPicker = (page: Page) => page.getByRole('button', { name: 'Access', exact: true })
/** One choice in the access menu, the menu open: it stays open. */
const accessChoice = (page: Page, repository: string, choice: string) => page.getByRole('group', { name: repository }).getByRole('menuitemradio', { name: choice })

const workstreams = async () => ((await (await fetch(`${server.url}/api/workstreams`)).json()) as { workstreams: { id: string }[] }).workstreams

test('U16 New workstream from an open one: the draft, empty, at /; Back: the Workstream again', async () => {
  const page = await fresh()
  const id = await started(page, 'the first workstream')
  await page.getByRole('button', { name: 'New workstream' }).click()
  await page.waitForURL(`${server.url}/`)
  await page.getByText('What shall we work on?').waitFor()
  assert.equal(await thread(page).getByText('Echo #1: the first workstream.').count(), 0, 'no message of the previous Workstream')
  assert.equal(await page.locator('header').getByText('New workstream').count(), 1)
  await page.goBack()
  await page.waitForURL(`${server.url}/w/${id}`)
  await thread(page).getByText('Echo #1: the first workstream.').waitFor()
})

test('U17 two Workstreams switched in the list: each shows its own messages only, the open one marked', async () => {
  const page = await fresh()
  const alpha = await started(page, 'alpha task')
  const beta = await started(page, 'beta task')
  const list = page.getByRole('navigation', { name: 'Workstreams' })
  await list.getByText('alpha task').click()
  await page.waitForURL(`${server.url}/w/${alpha}`)
  await thread(page).getByText('Echo #1: alpha task.').waitFor()
  assert.equal(await thread(page).getByText('beta task').count(), 0)
  assert.equal(await list.locator('[aria-current="page"]').innerText(), 'alpha task')
  await list.getByText('beta task').click()
  await page.waitForURL(`${server.url}/w/${beta}`)
  await thread(page).getByText('Echo #1: beta task.').waitFor()
  assert.equal(await thread(page).getByText('alpha task').count(), 0)
})

test('U18 a first message: nothing on the server before it; then shown at once, the address /w/<id>, the answer, the list', async () => {
  const page = await fresh()
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await composerInput(page).fill('a brand new task')
  const before = (await workstreams()).length
  assert.equal((await workstreams()).length, before, 'opening the draft and picking a harness create nothing')
  await page.getByRole('button', { name: 'Send' }).click()
  await thread(page).getByText('a brand new task', { exact: true }).waitFor({ timeout: 1000 })
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText('Echo #1: a brand new task.').waitFor()
  assert.equal((await workstreams()).length, before + 1)
  await page.getByRole('navigation', { name: 'Workstreams' }).getByText('a brand new task').waitFor()
})

test('U19 a permission: the card with the agent options; Allow: the agent goes on, the card gone, sending open again', async () => {
  const page = await fresh()
  await started(page, 'before the permission')
  await send(page, '/permission')
  await page.getByText('asks before it goes on').waitFor()
  assert.deepEqual(await page.locator('main button').filter({ hasText: /^(Allow|Reject)$/ }).allInnerTexts(), ['Allow', 'Reject'])
  await page.getByText('Answer the permission request above.').waitFor()
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await thread(page).getByText('Permission: allow-once.').waitFor()
  assert.equal(await page.getByText('asks before it goes on').count(), 0)
  await composerInput(page).fill('after the permission')
  assert.equal(await page.getByRole('button', { name: 'Send' }).isEnabled(), true)
})

test('U20 a reload on a Workstream: the same messages', async () => {
  const page = await fresh()
  const id = await started(page, 'kept across a reload')
  await page.reload()
  await page.waitForURL(`${server.url}/w/${id}`)
  await thread(page).getByText('Echo #1: kept across a reload.').waitFor()
  assert.equal(await thread(page).getByText('kept across a reload', { exact: true }).count(), 1, 'the message once')
})

test('U21 Stop: the state stopped, Stop gone, sending closed with its reason', async () => {
  const page = await fresh()
  await started(page, 'a task to end')
  await page.locator('header').getByRole('button', { name: /Stop/ }).click()
  await stateLabel(page, 'stopped').waitFor()
  assert.equal(await page.locator('header').getByRole('button', { name: /Stop/ }).count(), 0)
  await page.getByText('Stopped. The sandbox ends at its deadline.').waitFor()
  await composerInput(page).fill('refused')
  assert.equal(await page.getByRole('button', { name: 'Send' }).isEnabled(), false)
})

test('U22 the theme: dark when toggled, kept after a reload; light in another browser', async () => {
  const page = await fresh()
  await page.goto(`${server.url}/`)
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), false)
  await page.getByRole('button', { name: 'Dark theme' }).click()
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true)
  await page.reload()
  await page.getByText('What shall we work on?').waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true)
  const other = await fresh()
  await other.goto(`${server.url}/`)
  assert.equal(await other.evaluate(() => document.documentElement.classList.contains('dark')), false)
})

test('U23 an ended Workstream: a message continues it from its anchor, the agent remembering', async () => {
  const page = await fresh()
  const id = await started(page, 'remember mirabelle')
  const view = (await workstreams()).find((w) => w.id === id) as unknown as { execution: string }
  await page.locator('header').getByRole('button', { name: /Stop/ }).click()
  await expire(c.kube, claimName(view.execution))
  await stateLabel(page, 'ended').waitFor()
  await page.getByRole('button', { name: 'Harness' }).click()
  await page.getByRole('menuitem', { name: /continues its saved session/ }).waitFor()
  await page.keyboard.press('Escape')
  await send(page, 'what did I say')
  await thread(page).getByText('Session restored with Mock agent: the agent remembers the history above.').waitFor()
  await thread(page).getByText(/Before, you told me "remember mirabelle"/).waitFor()
})

test('U36 an ended Workstream whose Pod left no anchor: said before sending; sent, the agent is given the exchanges above', async () => {
  const page = await fresh()
  const id = await started(page, 'remember quetsche')
  const view = (await workstreams()).find((w) => w.id === id) as unknown as { execution: string }
  await page.locator('header').getByRole('button', { name: /Stop/ }).click()
  // The Pod's push never reaches the server, as when the node dies.
  const url = c.kube.anchorUrl
  c.kube.anchorUrl = ''
  await expire(c.kube, claimName(view.execution))
  await stateLabel(page, 'ended').waitFor()
  c.kube.anchorUrl = url
  await page.getByText('No saved Mock agent session: the 1 exchange above goes to the agent as text.').waitFor()
  await send(page, 'what did I say')
  await thread(page).getByText('New session with Mock agent. The 1 exchange above goes to the agent with your next message.').waitFor()
  // The prompt sent: the exchange above, then the message; the user's bubble shows the message only.
  const prompt = await until('the prompt with the catch-up', async () => {
    const prompts = (await entriesOf(id)).flatMap((e) => {
      const blocks = (e.content.params as { prompt?: { text?: string }[] } | undefined)?.prompt
      return blocks === undefined ? [] : [blocks]
    })
    return prompts.at(-1)?.length === 2 ? prompts.at(-1)! : null
  })
  assert.match(String(prompt[0]!.text), /<user>\nremember quetsche\n<\/user>/)
  assert.equal(prompt[1]!.text, 'what did I say')
  await thread(page).getByText('what did I say', { exact: true }).waitFor()
})

test('U24 a tool with a diff: its line labelled and noted; opened, the diff', async () => {
  const page = await fresh()
  await started(page, 'before the tool')
  await send(page, '/tool')
  const line = page.getByRole('button', { name: /Edit demo\.txt/ })
  await line.waitFor()
  assert.match(await line.innerText(), /\+1 −1/)
  await line.click()
  await page.locator('.aui-diff-viewer').getByText('after').first().waitFor()
})

test('U27 a model and an effort picked in the draft: carried by the Create, shown once the Session is ready', async () => {
  const page = await fresh()
  // A Session in the pool first: the draft offers what it gave.
  await started(page, 'a session for the catalogue')
  await page.getByRole('button', { name: 'New workstream' }).click()
  await pickHarness(page, 'Mock agent')
  await modelPicker(page).click()
  assert.deepEqual(await page.getByRole('menuitem').allInnerTexts(), ['mock-small', 'mock-large', 'mock-broken', 'low', 'high'], 'no default offered')
  await page.getByRole('menuitem', { name: 'mock-large' }).click()
  await modelPicker(page).click()
  await page.getByRole('menuitem', { name: 'high' }).click()
  assert.match(await modelPicker(page).innerText(), /mock-large\s*·\s*high/)
  await send(page, 'with a chosen model')
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText('Echo #1: with a chosen model.').waitFor()
  const create = (await entriesOf(idOf(page))).find((e) => e.kind === 'command' && e.content.kind === 'Create')!
  assert.deepEqual((create.content.body as { settings: unknown }).settings, [
    { id: 'mode', value: 'full-access' },
    { id: 'model', value: 'mock-large' },
    { id: 'effort', value: 'high' },
  ])
  assert.match(await modelPicker(page).innerText(), /mock-large\s*·\s*high/)
})

test('U28 another model picked in an open Workstream: Configure sent, the picker shows it once answered', async () => {
  const page = await fresh()
  const id = await started(page, 'before the switch')
  await modelPicker(page).click()
  await page.getByRole('menuitem', { name: 'mock-small' }).click()
  await page.waitForFunction(() => /mock-small/.test(document.querySelector('[aria-label="Model"]')?.textContent ?? ''))
  const configure = (await entriesOf(id)).filter((e) => e.kind === 'command' && e.content.kind === 'Configure')
  assert.deepEqual(configure.map((e) => e.content.body), [{ configId: 'model', value: 'mock-small' }])
  await send(page, 'after the switch')
  await thread(page).getByText('Echo #2: after the switch.').waitFor()
})

test('U29 / in the composer: the commands listed; one chosen with the keyboard; sent, the agent receives it', async () => {
  const page = await fresh()
  await started(page, 'before the command')
  await composerInput(page).fill('/')
  const list = page.getByRole('listbox', { name: 'Commands' })
  await list.waitFor()
  assert.deepEqual(await list.getByRole('option').allInnerTexts().then((t) => t.map((x) => x.split(/\s/)[0])), ['/recall', '/review'])
  await composerInput(page).fill('/re')
  await composerInput(page).press('ArrowDown')
  await composerInput(page).press('Enter')
  assert.equal(await composerInput(page).inputValue(), '/review ')
  assert.equal(await list.count(), 0)
  await composerInput(page).pressSequentially('the code')
  await page.getByRole('button', { name: 'Send' }).click()
  await thread(page).getByText('Echo #2: /review the code.').waitFor()
})

test('U34 an access picked in the draft: carried by the Create, shown once the Session is ready', async () => {
  const config = (await (await fetch(`${server.url}/api/config`)).json()) as { credentials: { offered: string[] } }
  assert.deepEqual(config.credentials.offered, ['github:owner/a:write', 'github:owner/b:read'])
  const page = await fresh()
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  assert.equal(await accessPicker(page).innerText(), 'No access')
  await accessPicker(page).click()
  assert.deepEqual(await page.getByRole('group', { name: 'owner/a' }).getByRole('menuitemradio').allInnerTexts(), ['None', 'Read', 'Write'])
  assert.deepEqual(await page.getByRole('group', { name: 'owner/b' }).getByRole('menuitemradio').allInnerTexts(), ['None', 'Read'])
  await accessChoice(page, 'owner/a', 'Write').click()
  // The menu, still open, hides the rest of the page from the accessibility tree.
  await page.keyboard.press('Escape')
  assert.equal(await accessPicker(page).innerText(), 'a · Write')
  await send(page, 'with an access')
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText('Echo #1: with an access.').waitFor()
  const create = (await entriesOf(idOf(page))).find((e) => e.kind === 'command' && e.content.kind === 'Create')!
  assert.deepEqual((create.content.body as { profiles: unknown }).profiles, ['github:owner/a:write'])
  assert.equal(await accessPicker(page).innerText(), 'a · Write')
})

test('U35 another access picked in an open Workstream: Scope sent with the whole set, shown at once and once the view has it', async () => {
  const page = await fresh()
  const id = await started(page, 'before the access')
  await accessPicker(page).click()
  await accessChoice(page, 'owner/b', 'Read').click()
  // The menu stays open: a second choice, from what the first gave.
  await accessChoice(page, 'owner/a', 'Read').click()
  await page.keyboard.press('Escape')
  assert.equal(await accessPicker(page).innerText(), '2 repos')
  await until('both Scopes', async () => (await entriesOf(id)).filter((e) => e.kind === 'command' && e.content.kind === 'Scope').length === 2)
  const scopes = (await entriesOf(id)).filter((e) => e.kind === 'command' && e.content.kind === 'Scope').map((e) => e.content.body)
  assert.deepEqual(scopes, [{ profiles: ['github:owner/b:read'] }, { profiles: ['github:owner/a:read', 'github:owner/b:read'] }])
  await send(page, 'after the access')
  await thread(page).getByText('Echo #2: after the access.').waitFor()
  assert.equal(await accessPicker(page).innerText(), '2 repos')
})

test('U37 a phone: the pickers as marks, nothing cut, the composer above the home indicator; wide: their names', async () => {
  const { page, insets } = await phone()
  // A Session in the pool first, so the draft offers its models and efforts.
  const id = await started(page, 'a session for the phone, its title long enough to be cut short in the header')
  assert.equal(await composerMargin(page), 34, 'above the home indicator')
  // The check sees a text cut short: the header's title is.
  assert.equal((await cut(page, 'header span.truncate')).length, 1, 'the title cut')
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await modelPicker(page).click()
  await page.getByRole('menuitem', { name: 'mock-large' }).click()
  await modelPicker(page).click()
  await page.getByRole('menuitem', { name: 'high' }).click()
  const harness = page.getByRole('button', { name: 'Harness' })
  assert.equal(await accessPicker(page).locator('[data-granted]').count(), 0, 'no dot while nothing is granted')
  await accessPicker(page).click()
  await accessChoice(page, 'owner/a', 'Read').click()
  await page.keyboard.press('Escape')
  assert.equal((await harness.innerText()).trim(), '', 'the harness without its name')
  assert.equal(await harness.locator('svg').first().isVisible(), true, 'its mark')
  assert.equal(await harness.getAttribute('title'), 'Mock agent')
  assert.equal((await modelPicker(page).innerText()).trim(), 'mock-large', 'the model alone')
  assert.equal(await modelPicker(page).getByLabel('high').isVisible(), true, 'the effort as bars')
  assert.equal((await accessPicker(page).innerText()).trim(), '', 'the key without what is granted')
  assert.equal(await accessPicker(page).getAttribute('title'), 'a · Read')
  assert.equal(await accessPicker(page).locator('[data-granted]').isVisible(), true, 'its dot')
  assert.deepEqual(await cut(page, 'main form button'), [], 'no picker cut')
  await page.setViewportSize({ width: 1400, height: 900 })
  assert.equal((await harness.innerText()).trim(), 'Mock agent')
  assert.match(await modelPicker(page).innerText(), /mock-large\s*·\s*high/)
  assert.equal((await accessPicker(page).innerText()).trim(), 'a · Read')
  assert.equal(await accessPicker(page).locator('[data-granted]').isVisible(), false, 'no dot beside the name')
  await insets(0)
  await page.goto(`${server.url}/w/${id}`)
  await thread(page).getByText('Echo #1: a session for the phone').waitFor()
  assert.equal(await composerMargin(page), 20, 'without a home indicator, the usual margin')
})

test('U38 the home-screen frame: the manifest and icon, an opaque status bar, the page covering the display, the status bar in the theme colour', async () => {
  const manifest = await fetch(`${server.url}/manifest.webmanifest`)
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json')
  const declared = (await manifest.json()) as Record<string, unknown>
  assert.deepEqual([declared.name, declared.display, declared.start_url], ['Agora', 'standalone', '/'])
  const icon = await fetch(`${server.url}/apple-touch-icon.png`)
  assert.equal(icon.headers.get('content-type'), 'image/png')
  const png = Buffer.from(await icon.arrayBuffer())
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [180, 180], 'a 180 px icon')
  const page = await fresh()
  await page.goto(`${server.url}/`)
  await page.getByText('What shall we work on?').waitFor()
  const content = (selector: string, attribute = 'content') => page.locator(selector).getAttribute(attribute)
  assert.equal(await content('link[rel="manifest"]', 'href'), '/manifest.webmanifest')
  assert.equal(await content('link[rel="apple-touch-icon"]', 'href'), '/apple-touch-icon.png')
  assert.equal(await content('meta[name="apple-mobile-web-app-status-bar-style"]'), 'default', 'an opaque status bar')
  assert.match((await content('meta[name="viewport"]'))!, /viewport-fit=cover/)
  const colours = () => page.locator('meta[name="theme-color"]').evaluateAll((metas) => metas.map((m) => m.getAttribute('content')))
  const background = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
  assert.deepEqual(await colours(), ['#faf9f5', '#faf9f5'], 'the light page, as the system')
  assert.equal(await background(), 'rgb(250, 249, 245)')
  await page.getByRole('button', { name: 'Dark theme' }).click()
  assert.deepEqual(await colours(), ['#181715', '#181715'], 'the dark theme, against the light system')
  assert.equal(await background(), 'rgb(24, 23, 21)')
})

test('U39 a phone: each bar coloured by an edge of its own, in the theme, as it changes; the theme set before the client runs', async () => {
  const { page } = await phone()
  const id = await started(page, 'a workstream for the bars')
  await page.goto(`${server.url}/`)
  await page.getByText('What shall we work on?').waitFor()
  const both = async () => [await edge(page, 'top'), await edge(page, 'bottom')]
  assert.deepEqual(await both(), [{ whole: false, colour: CREAM }, { whole: false, colour: CREAM }], 'the draft: its own edges, the light page')
  // The check sees a container covering the whole screen: at the left edge, the frame is the one found.
  assert.deepEqual(await edge(page, 'left'), { whole: true, colour: CREAM })
  await toggle(page, 'dark')
  assert.deepEqual(await both(), [{ whole: false, colour: DARK }, { whole: false, colour: DARK }], 'toggled: the dark page')
  await page.getByRole('button', { name: 'Show the workstreams' }).first().click()
  assert.equal((await edge(page, 'top'))!.whole, true, 'the drawer open: it covers the screen')
  await page.getByRole('navigation', { name: 'Workstreams' }).getByRole('button', { name: /a workstream for the bars/ }).click()
  await page.waitForURL(`${server.url}/w/${id}`)
  await thread(page).getByText('Echo #1: a workstream for the bars.').waitFor()
  assert.deepEqual(await both(), [{ whole: false, colour: DARK }, { whole: false, colour: DARK }], 'the Workstream, the drawer closed: its own edges again')
  await toggle(page, 'light')
  assert.deepEqual(await both(), [{ whole: false, colour: CREAM }, { whole: false, colour: CREAM }], 'toggled back: the light page')
  // Dark again, then the page loaded without its client: the theme is already there.
  await toggle(page, 'dark')
  await page.route('**/assets/*.js', (route) => route.abort())
  await page.reload()
  assert.equal(await page.evaluate(() => document.querySelector('#root')!.childElementCount), 0, 'no client')
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), DARK)
})
