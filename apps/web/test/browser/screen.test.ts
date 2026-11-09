// docs/specs/assistant-ui.md, acceptance cases U16–U24, U27–U29, U34–U41, U43, U44, U46, U50–U59, U61–U65, U67, U69–U76, U78, U79: the built client in a real browser (Playwright's
// Chromium), against the real server — the log on PostgreSQL, the mechanics on FakeKube, real bridges and
// the mock agent. Run from the log package, which provisions the database: `npm run test:browser`.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server as HttpServer } from 'node:http'
import { crc32, deflateSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { mockBridge } from '@agora/testkit'
import { claimName } from '../../../../packages/executions/src/manager.ts'
import { cluster, database, expire, freePort, Server, until, view as viewOf, type Db } from '../../../../packages/log/test/support.ts'
import { folderOwner, identity } from '../../../../packages/log/src/index.ts'
import { NOBODY } from '../../src/agora/api.ts'

let db: Db
let c: Awaited<ReturnType<typeof cluster>>
let server: Server
let browser: Browser
// A stand-in for Prefect's API (docs/specs/flows.md, "Launching from Agora"): what it was asked.
const prefectAsked: { parameters: Record<string, unknown>; idempotency_key: string }[] = []
let prefect: HttpServer
const PERSON = 'person@example.org'
/** GitHub, standing in for the merge card (docs/specs/merge.md): each pull request's state, every merge asked. */
const pulls = new Map<number, { mergeable_state: string; merged: boolean }>()
const mergesAsked: { number: number; body: Record<string, unknown> }[] = []
let github: HttpServer

before(async () => {
  assert.ok(existsSync(new URL('../../dist/index.html', import.meta.url)), 'the client is built first: npm run build -w @agora/web')
  db = await database()
  // Agora's MCP server where the mock agent's `/delegate` calls it: the lab has no gateway (packages/mock-agent).
  const mcpPort = await freePort()
  process.env.AGORA_MOCK_MCP = `http://127.0.0.1:${String(mcpPort)}/mcp`
  c = await cluster()
  // As the pools in the cluster: every Session starts with full access.
  c.kube.sessionConfig['mock-test'] = 'mode=full-access'
  // A signer of its own, two repositories, the Internet and delegating offered, as in the cluster
  // (docs/specs/credentials.md, "Offered profiles"); the gateway is never reached.
  const grants = join(mkdtempSync(join(tmpdir(), 'grants-')), 'key.pem')
  writeFileSync(grants, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const credentials = { GATEWAY_PROXY: '127.0.0.1:9', GRANTS_KEY_FILE: grants, OFFERED_PROFILES: 'github:owner/a:write,github:owner/b:read,internet,agora:delegate' }
  prefect = createServer((req, res) => {
    const reply = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (req.url === '/api/deployments/name/lead/main') return reply(200, { id: 'deployment-1' })
    let text = ''
    req.on('data', (chunk: Buffer) => (text += chunk.toString()))
    req.on('end', () => {
      prefectAsked.push(JSON.parse(text) as (typeof prefectAsked)[number])
      reply(201, { id: `run-${String(prefectAsked.length)}`, name: 'a-run' })
    })
  })
  await new Promise<void>((resolve) => prefect.listen(0, '127.0.0.1', resolve))
  github = createServer((req, res) => {
    const reply = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    let text = ''
    req.on('data', (chunk: Buffer) => (text += chunk.toString()))
    req.on('end', () => {
      const m = /^\/repos\/owner\/a\/pulls\/([0-9]+)(\/reviews|\/merge)?/.exec(req.url ?? '')
      const pull = m ? pulls.get(Number(m[1])) : undefined
      if (!m || !pull) return reply(404, { message: 'Not Found' })
      const number = Number(m[1])
      if (m[2] === '/reviews') return reply(200, [])
      if (m[2] === '/merge') {
        mergesAsked.push({ number, body: JSON.parse(text) as Record<string, unknown> })
        pull.merged = true
        return reply(200, { merged: true, sha: 'f00d1234567890', message: 'Pull Request successfully merged' })
      }
      reply(200, { number, title: `Add feature ${String(number)}`, html_url: `https://github.com/owner/a/pull/${String(number)}`, state: pull.merged ? 'closed' : 'open', merged: pull.merged, draft: false, base: { ref: 'main' }, head: { ref: `feat/${String(number)}`, sha: `head${String(number)}` }, user: { login: 'agora-contributor[bot]' }, mergeable_state: pull.mergeable_state, merge_commit_sha: pull.merged ? 'f00d1234567890' : null })
    })
  })
  await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve))
  const merge = { GITHUB_TEST_API: `http://127.0.0.1:${String((github.address() as AddressInfo).port)}`, POD_IP: '127.0.0.1' }
  const team = { TEAM_PREFECT_API: `http://127.0.0.1:${String((prefect.address() as AddressInfo).port)}/api`, TEAM_DEPLOYMENT: 'lead/main' }
  // Room for every case's sandbox: a stopped one counts until its deadline.
  // Approvals of 12 s: one is answered at once, or left to expire (U61–U63).
  server = await Server.start({ db, api: c.api, keys: c.keys, env: { MAX_ACTIVE: '60', MCP_PORT: String(mcpPort), APPROVAL_SECONDS: '12', ...credentials, ...team, ...merge } })
  // The Pods push their anchor to the server's receiver, as in the cluster.
  c.kube.anchorUrl = server.anchorUrl
  browser = await chromium.launch()
})

after(async () => {
  prefect?.close()
  github?.close()
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

/** A wide screen behind the proxy: an identity passed with every request, as oauth2-proxy does. */
async function proxied(email = PERSON): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light', extraHTTPHeaders: { 'x-forwarded-email': email } })
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
/** The Internet's switch in the access menu, the menu open. */
const internetSwitch = (page: Page) => page.getByRole('menuitemcheckbox', { name: 'Internet' })

/** A Workstream of the mock agent's given agora:delegate (docs/specs/delegation.md), once it answered its first message. */
async function delegating(page: Page, text: string): Promise<string> {
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await accessPicker(page).click()
  await page.getByRole('menuitemcheckbox', { name: 'agora:delegate' }).click()
  await page.keyboard.press('Escape')
  await send(page, text)
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText(`Echo #1: ${text}.`).waitFor()
  return idOf(page)
}
/** What the mock agent is told to call `delegate` with (packages/mock-agent). */
const delegateCall = (args: Record<string, unknown>) => `/delegate ${JSON.stringify(args)}`
/** A `delegate` line of the thread, by its label. */
const delegateLine = (page: Page, label: string) => thread(page).locator('[data-delegate]').filter({ hasText: label })
/** The calls that need the person: a right beyond the caller's — a repository it was not given. */
const beyond = (instructions: string) => delegateCall({ instructions, harness: 'mock', rights: ['github:owner/b:read'] })

/** Every Workstream on the server, whoever owns it. */
const stored = async () => Number((await db.admin.query('SELECT count(*) AS n FROM workstreams')).rows[0].n)

test('U16 New workstream from an open one: the draft, empty, at /; Back: the Workstream again', async () => {
  const page = await fresh()
  const id = await started(page, 'the first workstream')
  await page.getByRole('button', { name: 'New workstream', exact: true }).click()
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
  const before = await stored()
  assert.equal(await stored(), before, 'opening the draft and picking a harness create nothing')
  await page.getByRole('button', { name: 'Send' }).click()
  await thread(page).getByText('a brand new task', { exact: true }).waitFor({ timeout: 1000 })
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText('Echo #1: a brand new task.').waitFor()
  assert.equal(await stored(), before + 1)
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
  const view = (await viewOf(server.url, id)) as { execution: string }
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
  const view = (await viewOf(server.url, id)) as { execution: string }
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
  await page.getByRole('button', { name: 'New workstream', exact: true }).click()
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
  assert.deepEqual(config.credentials.offered, ['github:owner/a:write', 'github:owner/b:read', 'internet', 'agora:delegate'])
  const page = await fresh()
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  assert.equal(await accessPicker(page).innerText(), 'Internet', 'on by default')
  await accessPicker(page).click()
  assert.equal(await internetSwitch(page).getAttribute('aria-checked'), 'true', 'a right among the others, on')
  assert.deepEqual(await page.getByRole('group', { name: 'owner/a' }).getByRole('menuitemradio').allInnerTexts(), ['None', 'Read', 'Review', 'Write'])
  assert.deepEqual(await page.getByRole('group', { name: 'owner/b' }).getByRole('menuitemradio').allInnerTexts(), ['None', 'Read'])
  await accessChoice(page, 'owner/a', 'Write').click()
  // The menu, still open, hides the rest of the page from the accessibility tree.
  await page.keyboard.press('Escape')
  assert.equal(await accessPicker(page).innerText(), 'Internet, a')
  assert.equal(await accessPicker(page).getAttribute('title'), 'Internet, a · Write')
  await send(page, 'with an access')
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText('Echo #1: with an access.').waitFor()
  const create = (await entriesOf(idOf(page))).find((e) => e.kind === 'command' && e.content.kind === 'Create')!
  assert.deepEqual((create.content.body as { profiles: unknown }).profiles, ['github:owner/a:write', 'internet'])
  assert.equal(await accessPicker(page).innerText(), 'Internet, a')
})

test('U35 another access picked in an open Workstream: Scope sent with the whole set, shown at once and once the view has it', async () => {
  const page = await fresh()
  const id = await started(page, 'before the access')
  await accessPicker(page).click()
  await accessChoice(page, 'owner/b', 'Read').click()
  // The menu stays open: a second choice, from what the first gave.
  await accessChoice(page, 'owner/a', 'Read').click()
  await page.keyboard.press('Escape')
  assert.equal(await accessPicker(page).innerText(), 'Internet, a, b')
  await until('both Scopes', async () => (await entriesOf(id)).filter((e) => e.kind === 'command' && e.content.kind === 'Scope').length === 2)
  const scopes = (await entriesOf(id)).filter((e) => e.kind === 'command' && e.content.kind === 'Scope').map((e) => e.content.body)
  assert.deepEqual(scopes, [{ profiles: ['github:owner/b:read', 'internet'] }, { profiles: ['github:owner/a:read', 'github:owner/b:read', 'internet'] }])
  await send(page, 'after the access')
  await thread(page).getByText('Echo #2: after the access.').waitFor()
  assert.equal(await accessPicker(page).innerText(), 'Internet, a, b')
})

test('U44 the Internet: a right among the others, on in a draft; off, the Create without it; on again in the open Workstream, Scope with the whole set', async () => {
  const page = await fresh()
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await accessPicker(page).click()
  const rights = await page.getByRole('menu').getByRole('menuitemcheckbox').or(page.getByRole('menu').getByRole('group')).all()
  assert.deepEqual(await Promise.all(rights.map(async (r) => (await r.getAttribute('aria-label')) ?? (await r.innerText()).trim())), ['Internet', 'agora:delegate', 'owner/a', 'owner/b'], 'the Internet first, then the other services, then the repositories')
  assert.equal(await internetSwitch(page).getAttribute('aria-checked'), 'true', 'on by default')
  await internetSwitch(page).click()
  assert.equal(await internetSwitch(page).getAttribute('aria-checked'), 'false', 'the menu stays open')
  await accessChoice(page, 'owner/b', 'Read').click()
  await page.keyboard.press('Escape')
  assert.equal(await accessPicker(page).innerText(), 'b · Read')
  await send(page, 'without the internet')
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText('Echo #1: without the internet.').waitFor()
  const id = idOf(page)
  const create = (await entriesOf(id)).find((e) => e.kind === 'command' && e.content.kind === 'Create')!
  assert.deepEqual((create.content.body as { profiles: unknown }).profiles, ['github:owner/b:read'])
  await accessPicker(page).click()
  assert.equal(await internetSwitch(page).getAttribute('aria-checked'), 'false', 'the execution\'s own')
  await internetSwitch(page).click()
  assert.equal(await internetSwitch(page).getAttribute('aria-checked'), 'true', 'shown at once')
  await page.keyboard.press('Escape')
  await until('the Scope', async () => (await entriesOf(id)).some((e) => e.kind === 'command' && e.content.kind === 'Scope'))
  const scope = (await entriesOf(id)).find((e) => e.kind === 'command' && e.content.kind === 'Scope')!
  assert.deepEqual(scope.content.body, { profiles: ['github:owner/b:read', 'internet'] })
  await send(page, 'with the internet')
  await thread(page).getByText('Echo #2: with the internet.').waitFor()
  assert.equal(await accessPicker(page).innerText(), 'Internet, b', 'once the view has it')
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
  assert.equal(await accessPicker(page).locator('[data-granted]').isVisible(), true, 'a dot: the Internet, on by default')
  await accessPicker(page).click()
  await internetSwitch(page).click()
  await page.keyboard.press('Escape')
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

/** With SHOTS set to a directory, a picture of the page there: what a person checks by eye. */
async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SHOTS) return
  // The animations that end, ended: never a running line's shimmer, nor one a render cancels.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  )
  await page.screenshot({ path: join(process.env.SHOTS, `${name}.png`) })
}

/**
 * The account's limits as the server would read them through the gateway, which the tests never
 * reach: the mock's pool draws from Claude's account, 5-hour window 72 % used, the week 19 %.
 */
async function limitsOf(page: Page): Promise<void> {
  await page.route('**/api/pools', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { pools: { name: string; baseProfiles?: string[] }[] }
    for (const pool of body.pools) if (pool.name === 'mock-test') pool.baseProfiles = ['anthropic']
    await route.fulfill({ response, json: body })
  })
  const now = Date.now()
  const at = (ms: number) => new Date(now + ms).toISOString()
  await page.route('**/api/limits', (route) =>
    route.fulfill({
      json: {
        limits: {
          anthropic: {
            windows: [
              { kind: 'five_hour', usedPercent: 72, resetsAt: at(2 * 3_600_000 + 10 * 60_000 - 1000) },
              { kind: 'weekly', usedPercent: 19, resetsAt: at(3 * 86_400_000 + 4 * 3_600_000 - 1000) },
            ],
            plan: 'max',
            checkedAt: at(0),
            stale: false,
            error: null,
          },
        },
      },
    }),
  )
}

test('U43 the context and the limits: a gauge for the limits alone; once the agent has said, its ring; opened, the context, then the account\'s windows', async () => {
  const page = await fresh()
  await limitsOf(page)
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  const gauge = page.getByRole('button', { name: 'Limits' })
  await gauge.click()
  const popover = page.locator('[data-slot=context-display-popover]')
  await popover.getByText('Subscription').waitFor()
  assert.equal(await popover.getByText('of the context').count(), 0, 'a draft has no context')
  const draft = await popover.getByRole('region', { name: 'Subscription' }).innerText()
  assert.match(draft, /Subscription\s+max/i)
  assert.match(draft, /5-hour\s+72% · resets in 2h 10m/)
  assert.match(draft, /Weekly\s+19% · resets in 3d 4h/)
  await shot(page, 'u43-draft')
  await page.keyboard.press('Escape')
  await send(page, 'measure the context')
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText('Echo #1: measure the context.').waitFor()
  await gauge.waitFor()
  await send(page, '/usage 150000/200000')
  await thread(page).getByText('Context: 150000 of 200000.').waitFor()
  const ring = page.getByRole('button', { name: 'Context usage' })
  await ring.getByText('75%').waitFor()
  assert.equal(await gauge.count(), 0, 'the ring stands for both')
  await ring.click()
  await popover.getByText('75% of the context').waitFor()
  await popover.getByText('150k / 200k').waitFor()
  const windows = await popover.getByRole('region', { name: 'Subscription' }).innerText()
  assert.match(windows, /Subscription\s+max/i)
  assert.match(windows, /5-hour\s+72% · resets in 2h 10m/)
  assert.match(windows, /Weekly\s+19% · resets in 3d 4h/)
  await shot(page, 'u43-desktop')
  await page.keyboard.press('Escape')
  await toggle(page, 'dark')
  await ring.click()
  await popover.getByText('75% of the context').waitFor()
  await shot(page, 'u43-dark')
  await page.keyboard.press('Escape')
  // On a phone: the ring beside Send, nothing cut, opened by a touch.
  const { page: small } = await phone()
  await limitsOf(small)
  await small.goto(page.url())
  const touched = small.getByRole('button', { name: 'Context usage' })
  await touched.getByText('75%').waitFor()
  assert.deepEqual(await cut(small, 'main form button'), [])
  await touched.tap()
  await small.locator('[data-slot=context-display-popover]').getByText('75% of the context').waitFor()
  await shot(small, 'u43-phone')
})

/** How far the thread is scrolled from its last message, and how much taller than the screen it is; `top` scrolls it up first. */
const fromBottom = (page: Page, top = false) =>
  page.locator('main textarea').evaluate((input, top) => {
    let e = input.parentElement!
    while (getComputedStyle(e).overflowY !== 'auto') e = e.parentElement!
    if (top) e.scrollTop = 0
    return { gap: e.scrollHeight - e.scrollTop - e.clientHeight, taller: e.scrollHeight - e.clientHeight }
  }, top)
/** The thread on its last message, `last` shown, and still there once the Workstream has caught up. */
async function onLastMessage(page: Page, what: string, last: string): Promise<void> {
  await thread(page).getByText(last).waitFor()
  await until(`${what}: on the last message`, async () => (await fromBottom(page)).gap <= 1, 3000)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const { gap, taller } = await fromBottom(page)
  assert.ok(taller > 400, `${what}: taller than the screen`)
  assert.ok(gap <= 1, `${what}: still on the last message (${String(gap)} px from it)`)
}
const composerFocused = (page: Page) => composerInput(page).evaluate((input) => document.activeElement === input)

test('U40 a phone: a Workstream opens on its last message, from the list, from another, by its address, nothing kept on a slow network; the composer not focused, nor after Scroll to the bottom; wide: focused', async () => {
  const { page } = await phone()
  const taller = (name: string) => `long ${name} task, taller than the screen: ${'and so on, '.repeat(150)}the end`
  const alpha = await started(page, taller('alpha'))
  for (const n of [2, 3]) {
    await send(page, taller(`alpha ${String(n)}`))
    await thread(page).getByText(`Echo #${String(n)}: long alpha ${String(n)} task`).waitFor()
  }
  const beta = await started(page, taller('beta'))
  const lastOf = { alpha: 'Echo #3: long alpha 3 task', beta: 'Echo #1: long beta task' }
  const fromList = async (on: Page, name: 'alpha' | 'beta', id: string) => {
    await on.getByRole('button', { name: 'Show the workstreams' }).first().click()
    await on.getByRole('navigation', { name: 'Workstreams' }).getByRole('button', { name: new RegExp(`^long ${name} task`) }).click()
    await on.waitForURL(`${server.url}/w/${id}`)
    await onLastMessage(on, `${name} from the list`, lastOf[name])
    assert.equal(await composerFocused(on), false, `${name} from the list: the composer not focused`)
  }
  await fromList(page, 'alpha', alpha)
  await fromList(page, 'beta', beta)
  await page.goto(`${server.url}/w/${alpha}`)
  await onLastMessage(page, 'alpha by its address', lastOf.alpha)
  assert.equal(await composerFocused(page), false, 'by its address: the composer not focused')
  assert.ok((await fromBottom(page, true)).gap > 400, 'scrolled up')
  const button = page.getByRole('button', { name: 'Scroll to the bottom' })
  await until('Scroll to the bottom offered', () => button.isEnabled())
  await button.tap()
  await onLastMessage(page, 'Scroll to the bottom', lastOf.alpha)
  assert.equal(await composerFocused(page), false, 'after the button: the composer not focused')
  // Another phone, nothing kept, the network slow: the thread arrives in pieces.
  const { page: other } = await phone()
  await other.goto(`${server.url}/`)
  await other.getByText('What shall we work on?').waitFor()
  const cdp = await other.context().newCDPSession(other)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 4096, uploadThroughput: 4096 })
  await fromList(other, 'alpha', alpha)
  const wide = await fresh()
  await wide.goto(`${server.url}/w/${alpha}`)
  await thread(wide).getByText(lastOf.alpha).waitFor()
  await until('wide: the composer focused', () => composerFocused(wide))
})

test('U41 a Workstream answered, then reloaded: kept once read whole; read with EventSource from that cursor, not from zero', async () => {
  const page = await fresh()
  const id = await started(page, 'a thread read as an event source')
  // Kept only once its snapshot has ended: an iPhone that never saw the end read every Workstream from zero.
  const kept = await until('kept in the browser', () =>
    page.evaluate((id) => (JSON.parse(localStorage.getItem(`agora:thread:${id}`) ?? 'null') as { cursor: string } | null)?.cursor, id),
  )
  const reads: { type: string; after: string }[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/api/workstreams/${id}/thread`) reads.push({ type: request.resourceType(), after: url.searchParams.get('after')! })
  })
  await page.reload()
  await thread(page).getByText('Echo #1: a thread read as an event source.').waitFor()
  await until('the thread read again', () => reads.length > 0)
  assert.deepEqual(reads[0], { type: 'eventsource', after: kept })
  assert.notEqual(kept, '0')
  await page.locator('main').getByText('Loading…').waitFor({ state: 'detached' })
})

test('U46 attachments: a photo and a Markdown file attached in a draft, a binary refused; sent, the agent given a JPEG 2048 px wide and the file; reloaded, both above the message', async (t) => {
  const page = await fresh()
  // A Session in the mock's pool first: the draft offers what its agent accepted.
  await started(page, 'before the attachments')
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  const paperclip = page.getByRole('button', { name: 'Attach files' })
  await paperclip.waitFor()
  // A 3000 × 2000 photo, drawn by the browser itself.
  const png = Buffer.from(
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 3000
      canvas.height = 2000
      const c = canvas.getContext('2d')!
      const g = c.createLinearGradient(0, 0, 3000, 2000)
      g.addColorStop(0, '#cc785c')
      g.addColorStop(1, '#141413')
      c.fillStyle = g
      c.fillRect(0, 0, 3000, 2000)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    }),
  )
  const plan = '# Plan\n\n- one\n'
  const choose = async (files: { name: string; mimeType: string; buffer: Buffer }[]) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), paperclip.click()])
    assert.equal(chooser.isMultiple(), true, 'several files at once')
    await chooser.setFiles(files)
  }
  // One after the other: the prompt follows the order the tiles show.
  const composer = page.locator('main form')
  await choose([{ name: 'photo.png', mimeType: 'image/png', buffer: png }])
  await composer.locator('[title="photo.png"] img').waitFor()
  await choose([{ name: 'plan.md', mimeType: 'text/markdown', buffer: Buffer.from(plan) }])
  await composer.locator('[title="plan.md"]').getByText('plan.md').waitFor()
  await choose([{ name: 'blob.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0x25, 0x00, 0xff, 0x01]) }])
  const alert = page.getByRole('alert').getByText("blob.bin can't be attached: only images and text files can be attached.")
  await alert.waitFor()
  t.diagnostic(`refused: ${await alert.innerText()}`)
  assert.equal(await composer.locator('[title="blob.bin"]').count(), 0, 'not attached')
  assert.equal(await composer.locator('[title="photo.png"], [title="plan.md"]').count(), 2, 'two tiles')
  await shot(page, 'U46-composer')
  await send(page, 'what is in these?')
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  const id = idOf(page)
  const received = thread(page).getByText(/Received an image, image\/jpeg, 2048 × 1365, \d+ bytes, sha256 [0-9a-f]{12}; plan\.md, text\/markdown, 14 characters\./)
  await received.waitFor()
  await thread(page).getByText('Echo #1: what is in these?.').waitFor()
  t.diagnostic(`the agent: ${(await received.innerText()).split('\n')[0]}`)
  const prompt = (await entriesOf(id))
    .filter((e) => e.kind === 'command' && e.content.kind === 'Write')
    .map((e) => (e.content.body as { prompt: Record<string, unknown>[] }).prompt)[0]!
  t.diagnostic(`the Write's prompt: ${JSON.stringify(prompt.map((b) => (b.data === undefined ? b : { ...b, data: `${String(b.data).length} base64 characters` })))}`)
  assert.deepEqual(prompt.map((b) => b.type), ['text', 'image', 'resource'])
  assert.deepEqual(prompt[0], { type: 'text', text: 'what is in these?' })
  assert.equal(prompt[1]!.mimeType, 'image/jpeg')
  assert.equal(prompt[1]!.uri, 'photo.png')
  assert.deepEqual(prompt[2], { type: 'resource', resource: { uri: 'plan.md', mimeType: 'text/markdown', text: plan } })
  await shot(page, 'U46-sent')
  // Reloaded: from the log, both above the message, the image opening whole.
  await page.reload()
  const user = thread(page).locator('[data-role="user"]').filter({ hasText: 'what is in these?' })
  await user.locator('[title="photo.png"] img').waitFor()
  await user.locator('[title="plan.md"]').getByText('plan.md').waitFor()
  await user.getByRole('button', { name: 'Preview photo.png' }).click()
  const whole = page.getByRole('dialog').locator('img[alt="photo.png"]')
  await whole.waitFor()
  const size = await whole.evaluate((img) => [(img as HTMLImageElement).naturalWidth, (img as HTMLImageElement).naturalHeight])
  t.diagnostic(`the image opened: ${size.join(' × ')}`)
  assert.deepEqual(size, [2048, 1365])
  await shot(page, 'U46-opened')
})

/** A PNG of noise, `width` × `height`: its bytes do not compress, so it weighs what it shows. */
function noisePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  // Each row: its filter byte, none, then random pixels.
  const rows = randomBytes((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

test('U79 an image the log keeps in R2: its tile and the image opened read from /api/files, no base64 in the thread', async (t) => {
  const page = await fresh()
  const id = randomUUID()
  assert.equal((await server.post('/api/workstreams', { id, owner: NOBODY })).status, 200)
  assert.equal((await server.command(id, 'Create', {}, { pool: 'mock-test' })).status, 200)
  const view = await until('ready', async () => {
    const v = (await viewOf(server.url, id)) as { state: string; execution: string; session: string } | undefined
    return v?.state === 'ready' ? v : undefined
  })
  const png = noisePng(200, 120)
  const data = png.toString('base64')
  assert.ok(data.length >= 65_536, 'a file by the contract')
  const write = await server.command(id, 'Write', { execution: view.execution, session: view.session }, { prompt: [{ type: 'text', text: 'this one' }, { type: 'image', mimeType: 'image/png', data, uri: 'noise.png' }] })
  assert.equal(write.status, 200)
  await until('its answer', async () => (await entriesOf(id)).some((e) => (e as { direction?: string; correlated_method?: string }).direction === 'in' && (e as { correlated_method?: string }).correlated_method === 'session/prompt'))
  const files: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/files/')) files.push(new URL(r.url()).pathname + new URL(r.url()).search)
  })
  await page.goto(`${server.url}/w/${id}`)
  const user = thread(page).locator('[data-role="user"]').filter({ hasText: 'this one' })
  const tile = user.locator('[title="noise.png"] img')
  await tile.waitFor()
  await until('the tile drawn', async () => ((await tile.evaluate((img) => (img as HTMLImageElement).naturalWidth)) > 0 ? true : undefined))
  const src = await tile.getAttribute('src')
  t.diagnostic(`the tile: ${String(src)}`)
  assert.match(String(src), /^\/api\/files\/[0-9a-f]{64}\?type=image%2Fpng&owner=/)
  await user.getByRole('button', { name: 'Preview noise.png' }).click()
  const whole = page.getByRole('dialog').locator('img[alt="noise.png"]')
  await whole.waitFor()
  const size = await whole.evaluate((img) => [(img as HTMLImageElement).naturalWidth, (img as HTMLImageElement).naturalHeight])
  t.diagnostic(`the image opened: ${size.join(' × ')}, from ${String(await whole.getAttribute('src'))}`)
  assert.deepEqual(size, [200, 120])
  assert.equal(await whole.getAttribute('src'), src)
  assert.ok(files.length >= 1 && files.every((f) => f.startsWith('/api/files/')), 'the image read from Agora')
  const received = await (async () => {
    // The thread as the client received it: no base64 of the image in it.
    const response = await fetch(`${server.url}/api/workstreams/${id}/thread?after=0`)
    const reader = response.body!.getReader()
    let text = ''
    while (!text.includes('snapshot-end')) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    await reader.cancel()
    return text
  })()
  t.diagnostic(`the thread: ${String(received.length)} characters`)
  assert.ok(!received.includes(data.slice(0, 200)), 'no base64 of the image in the thread')
  assert.match(received, /agora-file:sha256:[0-9a-f]{64}/)
})

test('U50 a question: one box, its text and options; waiting in the list; a note and an option chosen: Answer sent, the options gone, sending open', async () => {
  const page = await fresh()
  const id = randomUUID()
  // Its owner the one the client lists without the proxy.
  assert.equal((await server.post('/api/workstreams', { id, owner: NOBODY })).status, 200)
  const options = [
    { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
    { optionId: 'revise', name: 'Revise', kind: 'reject_once' },
  ]
  const asked = await server.command(id, 'Ask', {}, { title: 'Approve the envelope', text: 'One feature, **one** dev.', options, note: true })
  assert.equal(asked.status, 200)
  await page.goto(`${server.url}/w/${id}`)
  await thread(page).getByText('Approve the envelope').first().waitFor()
  await thread(page).getByText('One feature,').waitFor()
  assert.equal(await thread(page).locator('strong', { hasText: 'one' }).count(), 1, 'the text as Markdown')
  // One box: the question's text and the options that answer it.
  const box = thread(page).locator('[data-question="pending"]')
  await box.getByText('waiting for you').waitFor()
  await box.getByText('One feature,').waitFor()
  await box.getByLabel('Note').waitFor()
  assert.deepEqual(await box.locator('button').filter({ hasText: /^(Approve|Revise)$/ }).allInnerTexts(), ['Approve', 'Revise'])
  await page.getByRole('button', { name: 'New workstream waiting for you' }).waitFor()
  await page.getByText('Answer the question above.').waitFor()
  assert.equal(await page.getByText('asks before it goes on').count(), 0)
  assert.deepEqual(await thread(page).locator('button').filter({ hasText: /^(Approve|Revise)$/ }).allInnerTexts(), ['Approve', 'Revise'])
  await page.getByLabel('Note').fill('One criterion per behaviour.')
  await page.getByRole('button', { name: 'Revise', exact: true }).click()
  await thread(page).locator('[data-question="answered"]').getByText('Revise — One criterion per behaviour.').waitFor()
  assert.equal(await page.getByLabel('Note').count(), 0)
  const answer = (await entriesOf(id)).find((e) => e.kind === 'command' && e.content.kind === 'Answer')!
  assert.deepEqual([answer.content.target, answer.content.body], [{ question: String(asked.body.position) }, { optionId: 'revise', note: 'One criterion per behaviour.' }])
  assert.equal(await page.getByText('Answer the question above.').count(), 0)
  await composerInput(page).fill('after the answer')
  assert.equal(await page.getByRole('button', { name: 'Send' }).isEnabled(), true)
})

test('U51 a team: Team in the harness picker, no model or access; the goal sent, the run asked of Prefect, its lead\'s Workstream open, waiting for it', async () => {
  const page = await proxied()
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Team')
  await page.getByPlaceholder('Describe the goal for the team…').waitFor()
  assert.equal(await modelPicker(page).count(), 0)
  assert.equal(await accessPicker(page).count(), 0)
  const asked = prefectAsked.length
  await page.getByPlaceholder('Describe the goal for the team…').fill('Make uploads reliable')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  const id = idOf(page)
  await until('the run asked', () => prefectAsked.length > asked)
  const run = prefectAsked.at(-1)!
  assert.deepEqual([run.parameters.goal, run.parameters.lead_workstream, run.parameters.owner, run.parameters.members_owner, run.idempotency_key], [
    'Make uploads reliable',
    id,
    identity('owner', PERSON),
    folderOwner('agents', PERSON),
    `agora-team-${id}`,
  ])
  await page.getByText('The team is starting…').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Send' }).isEnabled(), false)
})

test('U52 the account at the sidebar\'s foot, Sign out; the agents\' folder below the list, closed, opened, remembered', async () => {
  const page = await proxied()
  // The person's Workstream, one of their folder's, one of someone else's folder's; listed for the question each waits on.
  const ask = { title: 'Listed', text: '', options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { optionId: 'b', name: 'B', kind: 'reject_once' }] }
  const owners = { own: identity('owner', PERSON), folder: folderOwner('agents', PERSON), other: folderOwner('agents', 'someone@example.org') }
  const made: Record<string, string> = {}
  for (const [name, owner] of Object.entries(owners)) {
    const id = crypto.randomUUID()
    assert.equal((await server.post('/api/workstreams', { id, owner })).status, 200)
    assert.equal((await server.command(id, 'Ask', {}, ask)).status, 200)
    made[name] = id
  }
  await page.goto(`${server.url}/`)
  const account = page.getByRole('button', { name: 'Account' })
  await account.getByText(PERSON).waitFor()
  await account.click()
  assert.equal(await page.getByRole('menuitem', { name: 'Sign out' }).getAttribute('href'), '/oauth2/sign_out?rd=%2F')
  assert.equal(await page.getByRole('menuitem').count(), 1)
  await page.keyboard.press('Escape')
  // The folder: closed at first, the person's own only; its Workstream out of the list.
  const folder = page.getByRole('region', { name: 'Agents' })
  const toggle = folder.getByRole('button', { name: /Agents/ })
  await toggle.waitFor()
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(await toggle.getByText('1', { exact: true }).count(), 1)
  assert.equal(await page.locator('nav[aria-label="Workstreams"] button[title]').count(), 1)
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  await folder.locator('button[title]').click()
  await page.waitForURL(new RegExp(`/w/${made.folder!}$`))
  // Opened it stays, across a reload.
  await page.reload()
  await page.getByRole('region', { name: 'Agents' }).locator('button[title]').waitFor()
  assert.equal(await page.getByRole('region', { name: 'Agents' }).getByRole('button', { name: /Agents/ }).getAttribute('aria-expanded'), 'true')
  await page.context().close()
})

/** A question that keeps a Workstream with no execution in the list: one row of it. */
const listed = { title: 'Listed', text: '', options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { optionId: 'b', name: 'B', kind: 'reject_once' }] }

/** Workstreams of an owner, each with a question, one after the other: the last the most recent. */
async function asked(owner: string, count: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = randomUUID()
    assert.equal((await server.post('/api/workstreams', { id, owner })).status, 200)
    assert.equal((await server.command(id, 'Ask', {}, listed)).status, 200)
    ids.push(id)
  }
  return ids
}

const listItems = (page: Page) => page.locator('nav[aria-label="Workstreams"] button[title]')
/** The lists' requests, by what they read: the person's list, the agents' folder, a page. */
const listReads = (page: Page): string[] => {
  const reads: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/workstreams/list') reads.push(url.searchParams.has('folder') ? 'folder' : 'list')
    else if (url.pathname === '/api/workstreams/page') reads.push('page')
  })
  return reads
}

test('U53 sixty Workstreams: the 50 most recent listed; the end of the list in view, the 10 older below them', async () => {
  const email = 'pages@example.org'
  const ids = await asked(identity('owner', email), 60)
  const page = await proxied(email)
  const reads = listReads(page)
  await page.goto(`${server.url}/`)
  await until('the 50 most recent', async () => (await listItems(page).count()) === 50)
  assert.equal(reads.filter((r) => r === 'page').length, 0, 'no page read while the end is out of view')
  // The last of them: the 50th most recent.
  await listItems(page).nth(49).click()
  await page.waitForURL(new RegExp(`/w/${ids[10]!}$`))
  await page.locator('nav[aria-label="Workstreams"]').evaluate((nav) => nav.scrollTo(0, nav.scrollHeight))
  await until('the 10 older below', async () => (await listItems(page).count()) === 60)
  await listItems(page).nth(59).click()
  await page.waitForURL(new RegExp(`/w/${ids[0]!}$`))
  assert.deepEqual([...reads].sort(), ['folder', 'list', 'page'])
  await page.context().close()
})

test('U54 a Workstream of the list changed by another client: at the top without a reload; nothing reads the list again whole', async (t) => {
  const email = 'live@example.org'
  const owner = identity('owner', email)
  const older = randomUUID()
  assert.equal((await server.post('/api/workstreams', { id: older, owner })).status, 200)
  const question = (await server.command(older, 'Ask', {}, listed)).body.position
  await asked(owner, 1)
  const page = await proxied(email)
  const reads = listReads(page)
  await page.goto(`${server.url}/w/${older}`)
  // Open, it is marked: the second, the other one more recent.
  await until('both listed', async () => (await listItems(page).count()) === 2)
  assert.equal(await listItems(page).nth(1).getAttribute('aria-current'), 'page')
  assert.equal((await server.command(older, 'Answer', { question: String(question) }, { optionId: 'a' })).status, 200)
  await until('at the top', async () => (await listItems(page).nth(0).getAttribute('aria-current')) === 'page', 10_000)
  // Longer than the 10 s the list was read again in.
  await new Promise((resolve) => setTimeout(resolve, 15_000))
  t.diagnostic(`list reads: ${reads.join(' ')}`)
  assert.deepEqual([...reads].sort(), ['folder', 'list'])
  await page.context().close()
})

test('U55 the title of a Workstream not loaded typed in Search, in another case: listed; the box emptied, the list as before', async () => {
  const email = 'search@example.org'
  const owner = identity('owner', email)
  // An older Workstream titled by its first message, then 55 more recent ones.
  const titled = randomUUID()
  assert.equal((await server.post('/api/workstreams', { id: titled, owner })).status, 200)
  assert.equal((await server.command(titled, 'Create', {}, { pool: 'mock-test' })).status, 200)
  const view = await until('ready', async () => {
    const v = (await viewOf(server.url, titled)) as { state: string; execution: string; session: string } | undefined
    return v?.state === 'ready' ? v : undefined
  })
  const write = await server.command(titled, 'Write', { execution: view.execution, session: view.session }, { prompt: [{ type: 'text', text: 'Quarterly Kubernetes audit' }] })
  assert.equal(write.status, 200)
  await until('its answer', async () => (await entriesOf(titled)).some((e) => (e as { direction?: string; correlated_method?: string }).direction === 'in' && (e as { correlated_method?: string }).correlated_method === 'session/prompt'))
  await asked(owner, 55)
  const page = await proxied(email)
  await page.goto(`${server.url}/`)
  const nav = page.getByRole('navigation', { name: 'Workstreams' })
  await until('the 50 most recent', async () => (await listItems(page).count()) === 50)
  assert.equal(await nav.getByText('Quarterly Kubernetes audit').count(), 0, 'not loaded')
  await page.getByLabel('Search the workstreams').fill('kubernetes AUDIT')
  await nav.getByText('Quarterly Kubernetes audit', { exact: true }).waitFor()
  assert.equal(await listItems(page).count(), 1)
  await page.getByLabel('Search the workstreams').fill('')
  await until('the list as before', async () => (await listItems(page).count()) === 50)
  assert.equal(await nav.getByText('Quarterly Kubernetes audit').count(), 0)
  await page.context().close()
})

/** A Workstream of the tree, owned by `owner` or under `parent`, with a question that stays pending, or answered. */
async function grown(id: string, at: { owner?: string; parent?: string }, waiting = false): Promise<void> {
  assert.equal((await server.post('/api/workstreams', { id, ...at })).status, 200)
  const asked = await server.command(id, 'Ask', {}, listed)
  assert.equal(asked.status, 200)
  if (!waiting) assert.equal((await server.command(id, 'Answer', { question: String(asked.body.position) }, { optionId: 'a' })).status, 200)
}

test('U56 a root whose sub-stream two levels down waits: folded, a chevron and "waiting for you"; unfolded, its sub-streams, then the one under the first', async () => {
  const email = 'tree@example.org'
  const [root, first, second, under] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  await grown(root, { owner: identity('owner', email) })
  await grown(first, { parent: root })
  await grown(second, { parent: root })
  await grown(under, { parent: first }, true)
  const page = await proxied(email)
  await page.goto(`${server.url}/`)
  const nav = page.getByRole('navigation', { name: 'Workstreams' })
  await until('the root alone', async () => (await listItems(page).count()) === 1)
  await nav.getByText('waiting for you').waitFor()
  assert.equal(await nav.getByRole('button', { name: 'Unfold' }).getAttribute('aria-expanded'), 'false')
  await nav.getByRole('button', { name: 'Unfold' }).click()
  await until('its two sub-streams', async () => (await listItems(page).count()) === 3)
  // The first's own sub-stream behind its chevron, still waiting.
  const inner = nav.getByRole('group').getByRole('button', { name: 'Unfold' })
  assert.equal(await inner.count(), 1)
  await inner.click()
  await until('the one under the first', async () => (await listItems(page).count()) === 4)
  assert.equal(await nav.getByRole('group').getByRole('group').locator('button[title]').count(), 1)
  await nav.getByRole('group').getByRole('group').getByText('waiting for you').waitFor()
  await page.context().close()
})

test('U57 a sub-stream under a folded root asks a question from another client: the root first, waiting for you, without a reload', async () => {
  const email = 'tree-live@example.org'
  const [root, sub, other] = [randomUUID(), randomUUID(), randomUUID()]
  await grown(root, { owner: identity('owner', email) })
  await grown(sub, { parent: root })
  // Another root, more recent, its question pending: listed, first.
  await grown(other, { owner: identity('owner', email) }, true)
  const page = await proxied(email)
  const reads = listReads(page)
  await page.goto(`${server.url}/w/${root}`)
  await until('both roots', async () => (await listItems(page).count()) === 2)
  assert.equal(await listItems(page).nth(1).getAttribute('aria-current'), 'page')
  const waiting = page.getByRole('navigation', { name: 'Workstreams' }).getByText('waiting for you')
  assert.equal(await waiting.count(), 1)
  assert.equal((await server.command(sub, 'Ask', {}, listed)).status, 200)
  await until('the root first', async () => (await listItems(page).nth(0).getAttribute('aria-current')) === 'page', 10_000)
  await until('the folded root waiting', async () => (await waiting.count()) === 2)
  assert.deepEqual([...reads].sort(), ['folder', 'list'])
  await page.context().close()
})

test('U58 a sub-stream two levels down opened by its address: its line unfolds; the header names its two parents, each opening its Workstream', async () => {
  const email = 'tree-open@example.org'
  const [root, first, under] = [randomUUID(), randomUUID(), randomUUID()]
  await grown(root, { owner: identity('owner', email) })
  await grown(first, { parent: root })
  await grown(under, { parent: first })
  const page = await proxied(email)
  await page.goto(`${server.url}/w/${under}`)
  await until('its line unfolded', async () => (await listItems(page).count()) === 3)
  const nav = page.getByRole('navigation', { name: 'Workstreams' })
  assert.equal(await nav.getByRole('group').getByRole('group').locator('[aria-current="page"]').count(), 1)
  const parents = page.locator('header button', { hasText: 'New workstream' })
  await until('two parents in the header', async () => (await parents.count()) === 2)
  await parents.first().click()
  await page.waitForURL(new RegExp(`/w/${root}$`))
  await page.context().close()
})

/** A Workstream that talked with the mock agent: created (under `parent`, or the owner's), started, its messages sent and answered. */
async function talked(id: string, at: { owner?: string; parent?: string }, messages: readonly string[]): Promise<void> {
  assert.equal((await server.post('/api/workstreams', { id, ...at })).status, 200)
  assert.equal((await server.command(id, 'Create', {}, { pool: 'mock-test' })).status, 200)
  const view = await until('ready', async () => {
    const v = (await viewOf(server.url, id)) as { state: string; execution: string; session: string } | undefined
    return v?.state === 'ready' ? v : undefined
  })
  for (const [i, text] of messages.entries()) {
    assert.equal((await server.command(id, 'Write', { execution: view.execution, session: view.session }, { prompt: [{ type: 'text', text }] })).status, 200)
    await until(`answer ${String(i + 1)}`, async () =>
      (await entriesOf(id)).filter((e) => (e as { direction?: string; correlated_method?: string }).direction === 'in' && (e as { correlated_method?: string }).correlated_method === 'session/prompt').length === i + 1,
    )
  }
}

test('U59 a word said only in an exchange of a Workstream not loaded, and far into a long one of a sub-stream\'s: both found with their line, the word in view and marked; emptied, the list as before', async () => {
  const email = 'words@example.org'
  const owner = identity('owner', email)
  const old = randomUUID(),
    root = randomUUID(),
    sub = randomUUID()
  // Said in a second exchange: neither title holds it.
  await talked(old, { owner }, ['an older talk', 'the quokka came by'])
  await grown(root, { owner })
  // Far into a long line: a narrow row shows it only from just before it.
  await talked(sub, { parent: root }, ['a sub-stream', `${'a long way round, '.repeat(12)}then a quokka again`])
  // More recent ones: the older talk is not in the first 50.
  await asked(owner, 55)
  const page = await proxied(email)
  await page.goto(`${server.url}/`)
  const nav = page.getByRole('navigation', { name: 'Workstreams' })
  await until('the 50 most recent', async () => (await listItems(page).count()) === 50)
  assert.equal(await nav.getByText('an older talk').count(), 0, 'not loaded')
  await page.getByLabel('Search the workstreams').fill('QUOKKA')
  await nav.getByText('an older talk', { exact: true }).waitFor()
  await nav.getByText('a sub-stream', { exact: true }).waitFor()
  assert.equal(await listItems(page).count(), 2)
  // Under each title, its latest matching line: the agent's echo of the message that said it, from the word
  // before the word searched, which is marked.
  await nav.getByText('Echo #2: the quokka came by. Before, you told me "an older talk".', { exact: true }).waitFor()
  await nav.getByText('…round, then a quokka again. Before, you told me "a sub-stream".', { exact: true }).waitFor()
  assert.deepEqual(await nav.locator('mark').allTextContents(), ['quokka', 'quokka'])
  await page.getByLabel('Search the workstreams').fill('')
  await until('the list as before', async () => (await listItems(page).count()) === 50)
  assert.equal(await nav.getByText('an older talk').count(), 0)
  await page.context().close()
})

test('U65 an agent’s delegate within its rights, then its last message of 10,000 characters: the line names and links to it; working, then idle; the message shown as the delegate’s, whole, by its title, then the agent’s answer', async () => {
  const page = await fresh()
  await delegating(page, 'before delegating')
  await send(page, delegateCall({ instructions: '/sleep 3', harness: 'mock' }))
  const line = delegateLine(page, '/sleep 3 · Mock agent')
  await line.getByText('working', { exact: true }).waitFor()
  await shot(page, 'u65-working')
  assert.match(String(await line.getByRole('link', { name: '/sleep 3 · Mock agent' }).getAttribute('href')), /^\/w\/[0-9a-f-]{36}$/)
  await line.getByText('idle', { exact: true }).waitFor()
  const said = thread(page).locator('[data-from]').last()
  await said.getByText(/Slept 3 s\./).waitFor()
  await shot(page, 'u65-idle')
  assert.equal(await said.getByRole('link').innerText(), 'From /sleep 3')
  await thread(page).getByText(/Echo #\d+: … second 1\/3/).waitFor()
  // Whole, however long.
  await send(page, delegateCall({ instructions: '/words 10000', harness: 'mock' }))
  const long = thread(page).locator('[data-from]').filter({ hasText: 'word word' })
  await long.waitFor()
  assert.ok((await long.innerText()).length >= 9_900, String((await long.innerText()).length))
})

test('U61 an approval pending on that line; Approve: the proposal and one button, the row waiting for you; after Approve, Approved and the delegate working', async () => {
  const page = await fresh()
  const caller = await delegating(page, 'before asking')
  await send(page, beyond('/sleep 5'))
  const box = delegateLine(page, 'delegate · /sleep 5').locator('[data-approval="pending"]')
  await box.waitFor()
  await shot(page, 'u61-approval')
  // On the agent's own line: the approval names it, matched by its arguments (docs/specs/delegation.md, "Matching").
  const ask = (await entriesOf(caller)).find((e) => e.kind === 'command' && e.content.kind === 'Ask')!
  assert.match(String((ask.content.body as { toolCallId?: unknown }).toolCallId), /^outil-/)
  assert.match(await box.innerText(), /Rights beyond the caller's: github:owner\/b:read/)
  assert.deepEqual(await box.getByRole('button').allInnerTexts(), ['Approve'])
  await page.locator('button[aria-current="page"]').getByText('waiting for you').waitFor()
  await box.getByRole('button', { name: 'Approve' }).click()
  const line = delegateLine(page, '/sleep 5 · Mock agent')
  await line.locator('[data-approval="answered"]').getByText('Approved').waitFor()
  await line.getByText('working', { exact: true }).waitFor()
  await shot(page, 'u61-approved')
})

test('U62 an approval pending; the person writes “use the read-only rights”: sending open while the turn runs, the composer saying so; once sent, Refused and the words on the line; no new turn', async () => {
  const page = await fresh()
  const caller = await delegating(page, 'before refusing')
  await send(page, beyond('/sleep 5'))
  const line = delegateLine(page, 'delegate · /sleep 5')
  await line.locator('[data-approval="pending"]').waitFor()
  const prompts = async () => (await entriesOf(caller)).filter((e) => e.kind === 'acp' && e.content.method === 'session/prompt').length
  const before = await prompts()
  await page.getByPlaceholder('Write to refuse, or to ask for a change').fill('use the read-only rights')
  assert.equal(await page.getByRole('button', { name: 'Send' }).isEnabled(), true, 'open while the turn runs')
  await shot(page, 'u62-refusing')
  await page.getByRole('button', { name: 'Send' }).click()
  await line.locator('[data-approval="refused"]').getByText('“use the read-only rights”').waitFor()
  await thread(page).getByText('Delegated: refused: use the read-only rights').waitFor()
  await shot(page, 'u62-refused')
  assert.equal(await prompts(), before, 'no new turn')
})

test('U63 an approval left unanswered: “Expired before a decision” on its line', async () => {
  const page = await fresh()
  await delegating(page, 'before expiring')
  await send(page, beyond('/sleep 5'))
  const line = delegateLine(page, 'delegate · /sleep 5')
  await line.locator('[data-approval="pending"]').waitFor()
  await line.locator('[data-approval="expired"]').getByText('Expired before a decision').waitFor({ timeout: 40_000 })
  await thread(page).getByText('Delegated: expired').waitFor()
  await shot(page, 'u63-expired')
})

test('U64 a delegate’s Workstream opened: its first message shown as from its delegator, by its title, not as the person’s', async () => {
  const page = await fresh()
  const caller = await delegating(page, 'the caller')
  await send(page, delegateCall({ instructions: 'hello delegate', harness: 'mock' }))
  await delegateLine(page, 'hello delegate · Mock agent').getByRole('link').click()
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  const first = thread(page).locator('[data-role="user"]').first()
  await first.getByText('hello delegate').waitFor()
  assert.equal(await first.getAttribute('data-from'), caller)
  assert.equal(await first.getByRole('link').innerText(), 'From the caller')
  await shot(page, 'u64-delegate')
  await first.getByRole('link').click()
  await page.waitForURL(`${server.url}/w/${caller}`)
})

test('U76 a delegate’s message while its delegator runs a command: waiting, saying who wrote it; then in the thread at its place, as the delegate’s; one of Agora’s, a line opening on its text', async () => {
  const page = await fresh()
  await delegating(page, 'before the message')
  await send(page, delegateCall({ instructions: 'a short task', harness: 'mock' }))
  await delegateLine(page, 'a short task · Mock agent').getByText('idle', { exact: true }).waitFor()
  await thread(page).getByText(/Echo #\d+: Echo #1: a short task\./).waitFor()
  // A second delegate, whose turn ends while the delegator's command runs.
  await send(page, delegateCall({ instructions: '/sleep 2', harness: 'mock' }))
  await delegateLine(page, '/sleep 2 · Mock agent').waitFor()
  await send(page, '/tool-open 6')
  await cancelButton(page).waitFor()
  await waitingList(page).first().getByText('From /sleep 2').waitFor({ timeout: 15_000 })
  await shot(page, 'u76-waiting')
  await waitingList(page).first().waitFor({ state: 'detached', timeout: 20_000 })
  const said = thread(page).locator('[data-from]').filter({ hasText: 'Slept 2 s.' })
  await said.waitFor()
  assert.equal(await said.getByRole('link').innerText(), 'From /sleep 2')
  await thread(page).getByText(/Heard: … second 1\/2/).waitFor()
  await shot(page, 'u76-in-the-thread')
  // One of Agora's.
  await cancelButton(page).waitFor({ state: 'detached', timeout: 20_000 })
  await send(page, delegateCall({ instructions: '/turn-error', harness: 'mock' }))
  const agora = thread(page).locator('[data-agora]').last()
  await agora.getByText('From Agora', { exact: true }).click()
  await agora.getByText(/Its turn failed/).waitFor()
  await shot(page, 'u76-agora')
})

const waitingList = (page: Page) => page.getByRole('list', { name: 'Messages waiting' }).getByRole('listitem')
const cancelButton = (page: Page) => page.getByRole('button', { name: 'Cancel the turn' })
const sendButton = (page: Page) => page.getByRole('button', { name: 'Send' })

test('U67 a turn running: sending open, the model and access pickers closed; once it ends, open again', async () => {
  const page = await fresh()
  await started(page, 'before the pickers')
  await send(page, '/sleep 3')
  await cancelButton(page).waitFor()
  assert.equal(await composerInput(page).isEnabled(), true)
  assert.equal(await modelPicker(page).isDisabled(), true)
  assert.equal(await accessPicker(page).isDisabled(), true)
  await thread(page).getByText('Slept 3 s.').waitFor()
  await until('the pickers open', () => modelPicker(page).isEnabled())
  assert.equal(await accessPicker(page).isEnabled(), true)
})

test('U70 an agent taking messages into its turn: Send beside Cancel once typed; sent with Ctrl or Cmd and Enter, in the thread above the rest of the response', async () => {
  const page = await fresh()
  await started(page, 'before the message')
  await send(page, '/sleep 6')
  await cancelButton(page).waitFor()
  assert.equal(await sendButton(page).count(), 0)
  await shot(page, 'u70-cancel-alone')
  await composerInput(page).fill('also this')
  await sendButton(page).waitFor()
  assert.equal(await cancelButton(page).isVisible(), true)
  await shot(page, 'u70-send-beside-cancel')
  await composerInput(page).press('ControlOrMeta+Enter')
  await thread(page).getByText('Heard: also this.').waitFor()
  await shot(page, 'u70-in-the-thread')
  const said = await page.locator('main [data-role="user"]').allInnerTexts()
  assert.equal(said.at(-1)!.trim(), 'also this')
  // Above the rest of the response: the agent's last message holds what it heard.
  assert.match((await page.locator('main [data-role="assistant"]').last().innerText()), /^Heard: also this\./)
  assert.equal(await waitingList(page).count(), 0)
  assert.equal(await cancelButton(page).isVisible(), true)
  assert.equal(await composerInput(page).inputValue(), '')
  await thread(page).getByText('Slept 6 s.').waitFor()
  await cancelButton(page).waitFor({ state: 'detached' })
  await sendButton(page).waitFor()
})

test('U71 an agent that does not: both above the composer, oldest first; the cross takes the first away, never sent; at the turn\'s end the second\'s turn', async () => {
  const page = await fresh()
  // As opencode: it does not say `_meta.steering.supported`.
  const factory = c.kube.bridgeFactory
  c.kube.bridgeFactory = (publicKey, pod) => mockBridge(publicKey, pod, { noSteering: true })
  await started(page, 'before the messages').finally(() => (c.kube.bridgeFactory = factory))
  await send(page, '/sleep 6')
  await cancelButton(page).waitFor()
  await composerInput(page).fill('the first waiting')
  await composerInput(page).press('ControlOrMeta+Enter')
  await waitingList(page).first().waitFor()
  await composerInput(page).fill('the second waiting')
  await composerInput(page).press('ControlOrMeta+Enter')
  await until('both listed', async () => (await waitingList(page).count()) === 2)
  assert.deepEqual((await waitingList(page).allInnerTexts()).map((t) => t.trim()), ['the first waiting', 'the second waiting'])
  await shot(page, 'u71-waiting')
  await waitingList(page).first().getByRole('button', { name: 'Take back' }).click()
  await until('one left', async () => (await waitingList(page).count()) === 1)
  assert.equal((await waitingList(page).first().innerText()).trim(), 'the second waiting')
  await thread(page).getByText('Slept 6 s.').waitFor()
  await thread(page).getByText(/Echo #\d+: the second waiting\./).waitFor()
  assert.equal(await waitingList(page).count(), 0)
  assert.equal(await thread(page).getByText('the first waiting').count(), 0)
})

test('U69 the queue\'s commands: each message a Write that may wait; the cross a Retract of its position', async () => {
  const page = await fresh()
  const id = await started(page, 'before the commands')
  await send(page, '/steering promptRequired 3')
  await cancelButton(page).waitFor()
  await composerInput(page).fill('taken back')
  await composerInput(page).press('ControlOrMeta+Enter')
  await waitingList(page).first().waitFor()
  await waitingList(page).first().getByRole('button', { name: 'Take back' }).click()
  await waitingList(page).first().waitFor({ state: 'detached' })
  const entries = (await entriesOf(id)) as unknown as { kind: string; position: string; content: { kind?: string; waits?: boolean; target?: { message?: string }; body?: { mayWait?: boolean; prompt?: { text?: string }[] } } }[]
  const commands = entries.filter((e) => e.kind === 'command')
  for (const write of commands.filter((e) => e.content.kind === 'Write')) assert.equal(write.content.body?.mayWait, true)
  const waited = commands.find((e) => e.content.kind === 'Write' && e.content.body?.prompt?.[0]?.text === 'taken back')!
  assert.equal(waited.content.waits, true)
  assert.equal(commands.find((e) => e.content.kind === 'Retract')?.content.target?.message, waited.position)
})

test('U72 a message waiting, then Cancel: what it says, nothing goes; a next message: the first\'s turn, then its own', async () => {
  const page = await fresh()
  await started(page, 'before the cancel')
  await send(page, '/tool-open 30')
  await cancelButton(page).waitFor()
  await thread(page).getByText('A long command').waitFor()
  await composerInput(page).fill('held back')
  await composerInput(page).press('ControlOrMeta+Enter')
  await waitingList(page).first().waitFor()
  await page.getByText('These go with your next message.').waitFor({ state: 'detached' })
  await cancelButton(page).click()
  await page.getByText('These go with your next message.').waitFor()
  await shot(page, 'u72-held')
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(await thread(page).getByText(/Echo #\d+: held back\./).count(), 0)
  assert.equal(await waitingList(page).count(), 1)
  await send(page, 'and this')
  await thread(page).getByText(/Echo #\d+: held back\./).waitFor()
  await thread(page).getByText(/Echo #\d+: and this\./).waitFor()
  assert.equal(await waitingList(page).count(), 0)
})

test('U73 a Write refused during a turn: its reason above the composer, the text back in it', async () => {
  const page = await fresh()
  await started(page, 'before the refusal')
  await send(page, '/sleep 4')
  await cancelButton(page).waitFor()
  // Simulated: the server's refusal, the composer still open as the agent asks for a permission.
  await page.route('**/commands', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ accepted: false, reason: 'permission_pending' }) }))
  await composerInput(page).fill('words kept')
  await composerInput(page).press('ControlOrMeta+Enter')
  await page.getByRole('alert').getByText('Answer the permission request first.').waitFor()
  await until('the text back', async () => (await composerInput(page).inputValue()) === 'words kept')
  await page.unroute('**/commands')
})

test('U73 a first message refused: its reason above the composer, the text back in it', async () => {
  const page = await fresh()
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  // Simulated: the server's refusal of the Write alone, once its execution is ready.
  await page.route('**/commands', (route) =>
    route.request().postDataJSON().kind === 'Write' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ accepted: false, reason: 'permission_pending' }) }) : route.continue(),
  )
  await send(page, 'first words kept')
  await page.getByRole('alert').getByText('Answer the permission request first.').waitFor()
  await until('the text back', async () => (await composerInput(page).inputValue()) === 'first words kept')
  await page.unroute('**/commands')
})

test('U74 a turn running: / typed, Escape: the commands hidden, the turn going on; Escape again: the turn cancelled', async () => {
  const page = await fresh()
  const id = await started(page, 'before the escape')
  await send(page, '/sleep 20')
  await cancelButton(page).waitFor()
  await composerInput(page).fill('/')
  const commands = page.getByRole('listbox', { name: 'Commands' })
  await commands.waitFor()
  await composerInput(page).press('Escape')
  await commands.waitFor({ state: 'detached' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(await cancelButton(page).isVisible(), true)
  assert.equal((await entriesOf(id)).filter((e) => e.kind === 'command' && e.content.kind === 'Cancel').length, 0)
  await composerInput(page).press('Escape')
  await cancelButton(page).waitFor({ state: 'detached' })
  await thread(page).getByText('cancelled', { exact: true }).waitFor()
  assert.equal((await entriesOf(id)).filter((e) => e.kind === 'command' && e.content.kind === 'Cancel').length, 1)
})

test('U75 a message with an attachment sent during a turn: one line, counted, no message of it in the thread; taken back, gone and never sent', async () => {
  const page = await fresh()
  const id = await started(page, 'before the attachment')
  await send(page, '/sleep 7')
  await cancelButton(page).waitFor()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Attach files' }).click()])
  await chooser.setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') })
  await page.getByText('notes.md').first().waitFor()
  await composerInput(page).fill('with a file')
  await composerInput(page).press('ControlOrMeta+Enter')
  await waitingList(page).first().waitFor()
  assert.deepEqual((await waitingList(page).first().innerText()).split(/\s+/), ['with', 'a', 'file', '1'])
  const bubble = page.locator('main [data-role="user"]').filter({ hasText: 'with a file' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await bubble.count(), 0)
  await shot(page, 'u75-attachment-waiting')
  await waitingList(page).first().getByRole('button', { name: 'Take back' }).click()
  await waitingList(page).first().waitFor({ state: 'detached' })
  await thread(page).getByText('Slept 7 s.').waitFor()
  assert.equal(await bubble.count(), 0)
  const prompts = (await entriesOf(id)).filter((e) => e.kind === 'acp' && (e as unknown as { method: string }).method === 'session/prompt')
  assert.equal(JSON.stringify(prompts).includes('with a file'), false)
})

test('U78 tools in a row folded, closed, a text between them, what waits for the person outside; a tool alone on its line', async () => {
  const page = await fresh()
  await started(page, 'before the tools')
  await send(page, '/tool-run 3')
  const folds = thread(page).locator('[data-tool-fold]')
  const words = async (fold: Locator) => (await fold.innerText()).split('\n').filter((l) => l !== '>')
  const allow = page.getByRole('button', { name: 'Allow', exact: true })
  await allow.waitFor()
  assert.equal(await folds.count(), 2)
  assert.deepEqual(await words(folds.nth(0)), ['1 read, 1 command', '1 failed'])
  assert.deepEqual(await words(folds.nth(1)), ['1 edit, 1 search', '+1 −1'])
  assert.equal(await thread(page).getByText('Read demo.txt').count(), 0, 'closed')
  const said = await thread(page).locator('[data-role="assistant"]').last().innerText()
  const places = ['Looking first.', '1 read', 'Now the change.', '1 edit', 'Write demo.txt'].map((text) => said.indexOf(text))
  assert.ok(places.every((place, i) => place >= 0 && (i === 0 || places[i - 1]! < place)), said)
  await thread(page).getByRole('button', { name: /Write demo\.txt/ }).waitFor()
  assert.equal(await folds.getByRole('button', { name: /Write demo\.txt/ }).count(), 0, 'outside its fold')
  await shot(page, 'u78-permission')
  await allow.click()
  await folds.nth(1).getByText('A long command').waitFor()
  assert.deepEqual(await words(folds.nth(1)), ['A long command', '4 tools'], 'closed, saying its running tool')
  assert.equal(await allow.count(), 0)
  await shot(page, 'u78-running')
  await thread(page).getByText('All done.').waitFor()
  await folds.nth(1).getByText('2 edits, 1 search, 1 command').waitFor()
  assert.deepEqual(await words(folds.nth(1)), ['2 edits, 1 search, 1 command', '+2 −2'], 'closed once done')
  await shot(page, 'u78-done')
  await folds.nth(1).getByRole('button', { name: /2 edits/ }).click()
  await folds.nth(1).getByText('A long command').waitFor()
  const lines = (await folds.nth(1).innerText()).split('\n').filter((l) => l !== '>')
  assert.deepEqual(lines, ['2 edits, 1 search, 1 command', '+2 −2', 'Edit demo.txt', '+1 −1', 'Search demo', 'Write demo.txt', '+1 −1', 'A long command'])
  await folds.nth(1).getByRole('button', { name: /Edit demo\.txt/ }).click()
  await folds.nth(1).locator('.aui-diff-viewer').getByText('after').first().waitFor()
  await shot(page, 'u78-open')
  await send(page, '/tool')
  await thread(page).getByText('Tool done.').waitFor()
  const alone = thread(page).locator('[data-role="assistant"]').last()
  await alone.getByRole('button', { name: /Edit demo\.txt/ }).waitFor()
  assert.equal(await alone.locator('[data-tool-fold]').count(), 0, 'a tool alone')
})

test('U80 Enter in the composer: a new line, nothing sent, on a computer and on a phone; Ctrl or Cmd with it, or Send: sent', async () => {
  const page = await fresh()
  const id = await started(page, 'before the lines')
  const said = page.locator('main [data-role="user"]')
  await composerInput(page).fill('first line')
  await composerInput(page).press('Enter')
  await composerInput(page).pressSequentially('second line')
  assert.equal(await composerInput(page).inputValue(), 'first line\nsecond line')
  await page.waitForTimeout(500)
  assert.equal(await said.count(), 1, 'Enter sent nothing')
  await composerInput(page).press('ControlOrMeta+Enter')
  await thread(page).getByText(/Echo #2: first line\s+second line\./).waitFor()
  assert.equal(await said.count(), 2)
  assert.match(await said.last().innerText(), /^first line\s+second line$/)
  assert.equal(await composerInput(page).inputValue(), '')

  const { page: small } = await phone()
  await small.goto(`${server.url}/w/${id}`)
  await thread(small).getByText(/Echo #2: first line/).waitFor()
  const saidThere = small.locator('main [data-role="user"]')
  await composerInput(small).tap()
  await composerInput(small).fill('on the phone')
  await composerInput(small).press('Enter')
  await composerInput(small).pressSequentially('too')
  assert.equal(await composerInput(small).inputValue(), 'on the phone\ntoo')
  await small.waitForTimeout(500)
  assert.equal(await saidThere.count(), 2, 'Enter sent nothing on the phone')
  await sendButton(small).tap()
  await thread(small).getByText(/Echo #3: on the phone\s+too\./).waitFor()
  assert.equal(await saidThere.count(), 3)
})

test('U81 Copy shown on hover over an earlier response: the thread under it does not move', async () => {
  const page = await fresh()
  await started(page, 'the first')
  await send(page, 'the second')
  await thread(page).getByText('Echo #2: the second.').waitFor()
  const first = page.locator('main [data-role="assistant"]').first()
  const next = page.locator('main [data-role="user"]').last()
  const copy = first.getByRole('button', { name: 'Copy' })
  // The last response has its Copy for good; the earlier one only on hover.
  await page.locator('main [data-role="assistant"]').last().getByRole('button', { name: 'Copy' }).waitFor()
  await page.mouse.move(5, 5)
  assert.equal(await copy.count(), 0, 'no Copy before the hover')
  const before = (await next.boundingBox())!
  await first.hover()
  await copy.waitFor()
  const after = (await next.boundingBox())!
  assert.equal(after.y, before.y, 'the next message did not move')
  const bar = (await copy.boundingBox())!
  const response = (await first.boundingBox())!
  assert.ok(bar.y >= response.y + response.height - 1, 'in the gap under the response')
  assert.ok(bar.y + bar.height <= after.y + 1, 'above the next message')
  // Reached by the mouse, it stays.
  await copy.hover()
  await page.waitForTimeout(200)
  assert.equal(await copy.isVisible(), true)
  assert.equal((await next.boundingBox())!.y, before.y)
  await page.mouse.move(5, 5)
  await copy.waitFor({ state: 'detached' })
  assert.equal((await next.boundingBox())!.y, before.y)
})

test('U82 a text typed and not sent: each Workstream and the draft keep their own, moving between them and New workstream', async () => {
  const page = await fresh()
  const alpha = await started(page, 'alpha draft task')
  const beta = await started(page, 'beta draft task')
  const list = page.getByRole('navigation', { name: 'Workstreams' })
  await composerInput(page).fill('for beta')
  await list.getByText('alpha draft task').click()
  await page.waitForURL(`${server.url}/w/${alpha}`)
  await thread(page).getByText('Echo #1: alpha draft task.').waitFor()
  assert.equal(await composerInput(page).inputValue(), '', 'not the text of beta')
  await composerInput(page).fill('for alpha')
  await page.getByRole('button', { name: 'New workstream', exact: true }).click()
  await page.waitForURL(`${server.url}/`)
  await page.getByText('What shall we work on?').waitFor()
  assert.equal(await composerInput(page).inputValue(), '', 'not the text of alpha')
  await composerInput(page).fill('for the draft')
  await list.getByText('beta draft task').click()
  await page.waitForURL(`${server.url}/w/${beta}`)
  await thread(page).getByText('Echo #1: beta draft task.').waitFor()
  assert.equal(await composerInput(page).inputValue(), 'for beta')
  await list.getByText('alpha draft task').click()
  await page.waitForURL(`${server.url}/w/${alpha}`)
  assert.equal(await composerInput(page).inputValue(), 'for alpha')
  await page.getByRole('button', { name: 'New workstream', exact: true }).click()
  await page.waitForURL(`${server.url}/`)
  assert.equal(await composerInput(page).inputValue(), 'for the draft')
  // Sent from the draft, it is gone from the draft: the new Workstream's composer, then the draft, empty.
  await pickHarness(page, 'Mock agent')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText('Echo #1: for the draft.').waitFor()
  assert.equal(await composerInput(page).inputValue(), '')
  await page.getByRole('button', { name: 'New workstream', exact: true }).click()
  await page.waitForURL(`${server.url}/`)
  assert.equal(await composerInput(page).inputValue(), '')
})

test('G8 a merge card: the pull request as a link, its state, Merge closed while it waits for a review, open once ready; merged, squash; a card a message cancels', async () => {
  const page = await fresh()
  pulls.set(7, { mergeable_state: 'blocked', merged: false })
  pulls.set(8, { mergeable_state: 'clean', merged: false })
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await accessPicker(page).click()
  await accessChoice(page, 'owner/a', 'Write').click()
  await page.keyboard.press('Escape')
  await send(page, `/propose_merge ${JSON.stringify({ repo: 'owner/a', number: 7 })}`)
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  const card = thread(page).locator('[data-merge="pending"]')
  await card.waitFor()
  await card.locator('[data-merge-state="review"]').waitFor()
  assert.equal(await card.getByRole('link', { name: 'Add feature 7' }).getAttribute('href'), 'https://github.com/owner/a/pull/7')
  assert.match(await card.locator('[data-merge-state]').innerText(), /owner\/a#7 · Waiting for a review/)
  assert.ok(await card.getByRole('button', { name: 'Merge' }).isDisabled())
  await shot(page, 'merge-card-review')
  // Approved meanwhile: the card reads GitHub again (its state stands 10 s on the server).
  pulls.get(7)!.mergeable_state = 'clean'
  await until('the card ready', async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    return (await card.locator('[data-merge-state="ready"]').count()) === 1
  }, 30_000)
  assert.ok(await card.getByRole('button', { name: 'Merge' }).isEnabled())
  await shot(page, 'merge-card-ready')
  await card.getByRole('button', { name: 'Merge' }).click()
  const merged = thread(page).locator('[data-merge="merged"]')
  await merged.waitFor()
  assert.match(await merged.innerText(), /Merged · f00d123/)
  assert.deepEqual(mergesAsked, [{ number: 7, body: { sha: 'head7', merge_method: 'squash' } }])
  await thread(page).getByText('Pull request owner/a#7 merged (squash): f00d1234567890.').waitFor()
  await shot(page, 'merge-card-merged')
  // Another, cancelled by a message.
  await until('the agent idle', async () => (await page.getByRole('textbox').count()) > 0)
  await send(page, `/propose_merge ${JSON.stringify({ repo: 'owner/a', number: 8 })}`)
  await thread(page).locator('[data-merge="pending"]').waitFor()
  await send(page, 'not now, fix the tests first')
  await thread(page).locator('[data-merge="cancelled"]').waitFor()
  assert.equal(mergesAsked.length, 1)
  await shot(page, 'merge-card-cancelled')
  await page.context().close()
})
