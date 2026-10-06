// docs/specs/assistant-ui.md, acceptance cases U16–U24 and U36: the built client in a real browser (Playwright's
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
