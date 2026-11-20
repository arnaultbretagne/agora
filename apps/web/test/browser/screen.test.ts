// docs/specs/assistant-ui.md, acceptance cases U16–U24, U27–U29, U34–U41, U43, U44, U46, U50, U52–U59, U61–U65, U67, U69–U76, U78–U83, U85–U97, U101, U102, U104–U111, U115–U117: the built client in a real browser (Playwright's
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
import { identity } from '../../../../packages/log/src/index.ts'
import { NOBODY } from '../../src/agora/api.ts'

let db: Db
let c: Awaited<ReturnType<typeof cluster>>
let server: Server
let browser: Browser
const PERSON = 'person@example.org'
/** GitHub, standing in for the merge card (docs/specs/merge.md): each pull request's state, every merge asked. */
const pulls = new Map<number, { mergeable_state: string; merged: boolean }>()
const mergesAsked: { number: number; body: Record<string, unknown> }[] = []
let github: HttpServer

before(async () => {
  assert.ok(existsSync(new URL('../../dist/index.html', import.meta.url)), 'the client is built first: npm run build -w @agora/web')
  db = await database()
  // Agora's MCP server where the mock agent's `/spawn_agent` calls it: the lab has no gateway (packages/mock-agent).
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
  // Cards of the suite's own (docs/specs/roles.md, "Cards"), whose values are what the lab offers: its pools'
  // harnesses, the mock agent's models and efforts, the profiles above. `judge`'s are offered by nothing here.
  const roles = mkdtempSync(join(tmpdir(), 'roles-'))
  for (const card of [
    { role: 'dev', summary: 'Owns one feature end to end.', harness: 'mock', model: 'mock-small', effort: 'low', access: 'github:owner/b:read' },
    { role: 'judge', summary: 'Says whether the work can ship.', harness: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', access: 'zai' },
    { role: 'lead', summary: 'Runs a small team on one goal.', harness: 'claude-code', model: 'mock-large', effort: 'high', access: 'agora:delegate' },
  ]) {
    const front = Object.entries(card).map(([key, value]) => `${key}: ${value}`).join('\n')
    writeFileSync(join(roles, `${card.role}.md`), `---\n${front}\n---\n\n# The ${card.role}\n\nYou are the ${card.role} of the tests.\n`)
  }
  // Room for every case's sandbox: a stopped one counts until its deadline.
  // Approvals of 12 s: one is answered at once, or left to expire (U61–U63).
  server = await Server.start({ db, api: c.api, keys: c.keys, env: { MAX_ACTIVE: '100', MCP_PORT: String(mcpPort), APPROVAL_SECONDS: '12', ...credentials, ...merge, ROLES_DIR: roles } })
  // The Pods push their anchor to the server's receiver, as in the cluster.
  c.kube.anchorUrl = server.anchorUrl
  browser = await chromium.launch()
})

after(async () => {
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

/** The commands the page posts, in order: each one's Workstream, kind and, for a message, its prompt. */
function commandsPosted(page: Page): { workstream: string; kind: string; prompt: unknown }[] {
  const posted: { workstream: string; kind: string; prompt: unknown }[] = []
  page.on('request', (request) => {
    const route = /\/api\/workstreams\/([0-9a-f-]{36})\/commands$/.exec(new URL(request.url()).pathname)
    if (request.method() !== 'POST' || !route) return
    const command = request.postDataJSON() as { kind: string; body?: { prompt?: unknown } }
    posted.push({ workstream: route[1]!, kind: command.kind, prompt: command.body?.prompt })
  })
  return posted
}

const entriesOf = async (id: string) => (await (await fetch(`${server.url}/api/workstreams/${id}/entries`)).json()) as { kind: string; content: Record<string, unknown> }[]
const modelPicker = (page: Page) => page.getByRole('button', { name: /^Model: / })
const accessPicker = (page: Page) => page.getByRole('button', { name: /^Access: / })
/** What a picker is set to, from its accessible name ("Role: dev" gives "dev"). */
const valueOf = async (picker: Locator) => (await picker.getAttribute('aria-label'))!.replace(/^[^:]+: /, '')
/** An entry of the access menu, the menu open, by its name: the menu stays open. */
const accessEntry = (page: Page, name: string) => page.getByRole('menu', { name: 'Access' }).getByRole('menuitemcheckbox', { name: new RegExp(`^${name}`) })
/** The Internet's entry in the access menu, the menu open. */
const internetSwitch = (page: Page) => accessEntry(page, 'Internet')

/** A Workstream of the mock agent's given agora:delegate (docs/specs/delegation.md), once it answered its first message. */
async function delegating(page: Page, text: string): Promise<string> {
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await accessPicker(page).click()
  await accessEntry(page, 'agora').click()
  await page.keyboard.press('Escape')
  await send(page, text)
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText(`Echo #1: ${text}.`).waitFor()
  return idOf(page)
}
/** What the mock agent is told to call `spawn_agent` with (packages/mock-agent). */
const delegateCall = (args: Record<string, unknown>) => `/spawn_agent ${JSON.stringify(args)}`
/** A delegate's line of the thread, by its label. */
const delegateLine = (page: Page, label: string) => thread(page).locator('[data-delegate]').filter({ hasText: label })
/** A message the agent received from another than the person: its line, by what it says (docs/specs/assistant-ui.md, "A tool's line"). */
const messageLine = (page: Page, label: string | RegExp) => thread(page).locator('[data-message]').filter({ hasText: label })
/** The button of a trace line, or of a fold: it opens and closes it. */
const lineButton = (line: Locator) => line.locator('button[aria-expanded]').first()
/** A fold's or a line's words, as they read: each line's label and note, the markers left out. */
const traceWords = async (line: Locator) => (await line.innerText()).split('\n').filter((l) => l !== '>')
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

test('U18 a first message: nothing on the server before it; then one Create carrying it, shown at once while its sandbox starts, the address /w/<id>, the answer, the list', async (t) => {
  const page = await fresh()
  const posted = commandsPosted(page)
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await composerInput(page).fill('a brand new task')
  const before = await stored()
  assert.equal(await stored(), before, 'opening the draft and picking a harness create nothing')
  // Its Pod two seconds to come: the message is seen waiting.
  c.kube.allocationDelayMs = 2_000
  try {
    await page.getByRole('button', { name: 'Send' }).click()
    await thread(page).getByText('a brand new task', { exact: true }).waitFor({ timeout: 1000 })
    await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
    await thread(page).getByText('waiting for the sandbox').waitFor()
    await thread(page).getByText('starting Mock agent').waitFor()
    await stateLabel(page, 'starting').waitFor()
    assert.equal(await page.getByRole('list', { name: 'Messages waiting' }).count(), 0, 'not above the composer')
    await shot(page, 'U18-starting')
  } finally {
    c.kube.allocationDelayMs = 0
  }
  await thread(page).getByText('Echo #1: a brand new task.').waitFor()
  assert.equal(await thread(page).getByText('waiting for the sandbox').count(), 0)
  assert.equal(await stored(), before + 1)
  await page.getByRole('navigation', { name: 'Workstreams' }).getByText('a brand new task').waitFor()
  assert.deepEqual(posted.map((c) => [c.kind, c.prompt]), [['Create', [{ type: 'text', text: 'a brand new task' }]]])
  t.diagnostic(`commands posted by the page: ${JSON.stringify(posted.map((c) => c.kind))}, the Create's prompt ${JSON.stringify(posted[0]?.prompt)}`)
})

test('U19 a permission: the card with the agent options; Allow: the agent goes on, the card gone, sending open again', async () => {
  const page = await fresh()
  await started(page, 'before the permission')
  await send(page, '/permission')
  await page.getByText('asks before it goes on').waitFor()
  assert.deepEqual(await page.locator('main button').filter({ hasText: /^(Allow|Reject)$/ }).allInnerTexts(), ['Allow', 'Reject'])
  await page.getByText('Answer the permission request above.').waitFor()
  await shot(page, 'u19-permission')
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await thread(page).getByText('Permission: allow-once.').waitFor()
  assert.equal(await page.getByText('asks before it goes on').count(), 0)
  await shot(page, 'u19-answered')
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
  await page.waitForFunction(() => /mock-small/.test(document.querySelector('[aria-label^="Model: "]')?.textContent ?? ''))
  const configure = (await entriesOf(id)).filter((e) => e.kind === 'command' && e.content.kind === 'Configure')
  assert.deepEqual(configure.map((e) => e.content.body), [{ configId: 'model', value: 'mock-small' }])
  await send(page, 'after the switch')
  await thread(page).getByText('Echo #2: after the switch.').waitFor()
})

test('U29 / in the composer: the commands listed; one chosen with Tab, one with Enter, nothing sent; sent, the agent receives it', async () => {
  const page = await fresh()
  await started(page, 'before the command')
  await composerInput(page).fill('/')
  const list = page.getByRole('listbox', { name: 'Commands' })
  await list.waitFor()
  assert.deepEqual(await list.getByRole('option').allInnerTexts().then((t) => t.map((x) => x.split(/\s/)[0])), ['/recall', '/review'])
  const said = page.locator('main [data-role="user"]')
  await composerInput(page).fill('/rec')
  await composerInput(page).press('Tab')
  assert.equal(await composerInput(page).inputValue(), '/recall ')
  assert.equal(await list.count(), 0)
  await composerInput(page).fill('/re')
  await composerInput(page).press('ArrowDown')
  await composerInput(page).press('Enter')
  assert.equal(await composerInput(page).inputValue(), '/review ')
  assert.equal(await list.count(), 0)
  await page.waitForTimeout(500)
  assert.equal(await said.count(), 1, 'choosing a command sent nothing')
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
  assert.equal(await valueOf(accessPicker(page)), 'Internet', 'on by default')
  await accessPicker(page).click()
  assert.equal(await internetSwitch(page).getAttribute('aria-checked'), 'true', 'a right among the others, on')
  // One GitHub entry: every repository at its widest, none on a line of its own, no levels to pick.
  assert.deepEqual(await accessEntry(page, 'GitHub').innerText(), 'GitHub\nowner/a, owner/b (read)')
  assert.equal(await accessEntry(page, 'GitHub').getAttribute('aria-checked'), 'false')
  assert.equal(await page.getByRole('menu', { name: 'Access' }).getByRole('menuitemradio').count(), 0, 'no level')
  await accessEntry(page, 'GitHub').click()
  // The menu, still open, hides the rest of the page from the accessibility tree.
  await page.keyboard.press('Escape')
  assert.equal(await valueOf(accessPicker(page)), 'Internet, GitHub')
  await send(page, 'with an access')
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText('Echo #1: with an access.').waitFor()
  const create = (await entriesOf(idOf(page))).find((e) => e.kind === 'command' && e.content.kind === 'Create')!
  assert.deepEqual((create.content.body as { profiles: unknown }).profiles, ['github:owner/a:write', 'github:owner/b:read', 'internet', 'agora:read', 'previews'])
  assert.equal(await valueOf(accessPicker(page)), 'Internet, GitHub')
})

test('U35 another access picked in an open Workstream: Scope sent with the whole set, shown at once and once the view has it', async () => {
  const page = await fresh()
  const id = await started(page, 'before the access')
  await accessPicker(page).click()
  await accessEntry(page, 'GitHub').click()
  // The menu stays open: a second choice, from what the first gave.
  await accessEntry(page, 'agora').click()
  await page.keyboard.press('Escape')
  assert.equal(await valueOf(accessPicker(page)), 'Internet, GitHub, agora')
  await until('both Scopes', async () => (await entriesOf(id)).filter((e) => e.kind === 'command' && e.content.kind === 'Scope').length === 2)
  const scopes = (await entriesOf(id)).filter((e) => e.kind === 'command' && e.content.kind === 'Scope').map((e) => e.content.body)
  assert.deepEqual(scopes, [{ profiles: ['github:owner/a:write', 'github:owner/b:read', 'internet', 'agora:read', 'previews'] }, { profiles: ['github:owner/a:write', 'github:owner/b:read', 'internet', 'agora:delegate', 'agora:read', 'previews'] }])
  await send(page, 'after the access')
  await thread(page).getByText('Echo #2: after the access.').waitFor()
  assert.equal(await valueOf(accessPicker(page)), 'Internet, GitHub, agora')
})

test('U44 the Internet: a right among the others, on in a draft; off, the Create without it; on again in the open Workstream, Scope with the whole set', async () => {
  const page = await fresh()
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await accessPicker(page).click()
  const rights = await page.getByRole('menu', { name: 'Access' }).getByRole('menuitemcheckbox').allInnerTexts()
  assert.deepEqual(rights.map((r) => r.split('\n')[0]), ['Internet', 'GitHub', 'agora'], 'the Internet first, then the other services, GitHub, agora')
  assert.equal(await internetSwitch(page).getAttribute('aria-checked'), 'true', 'on by default')
  await internetSwitch(page).click()
  assert.equal(await internetSwitch(page).getAttribute('aria-checked'), 'false', 'the menu stays open')
  await accessEntry(page, 'GitHub').click()
  await page.keyboard.press('Escape')
  assert.equal(await valueOf(accessPicker(page)), 'GitHub')
  await send(page, 'without the internet')
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText('Echo #1: without the internet.').waitFor()
  const id = idOf(page)
  const create = (await entriesOf(id)).find((e) => e.kind === 'command' && e.content.kind === 'Create')!
  assert.deepEqual((create.content.body as { profiles: unknown }).profiles, ['github:owner/a:write', 'github:owner/b:read', 'agora:read', 'previews'])
  await accessPicker(page).click()
  assert.equal(await internetSwitch(page).getAttribute('aria-checked'), 'false', 'the execution\'s own')
  await internetSwitch(page).click()
  assert.equal(await internetSwitch(page).getAttribute('aria-checked'), 'true', 'shown at once')
  await page.keyboard.press('Escape')
  await until('the Scope', async () => (await entriesOf(id)).some((e) => e.kind === 'command' && e.content.kind === 'Scope'))
  const scope = (await entriesOf(id)).find((e) => e.kind === 'command' && e.content.kind === 'Scope')!
  assert.deepEqual(scope.content.body, { profiles: ['github:owner/a:write', 'github:owner/b:read', 'internet', 'agora:read', 'previews'] })
  await send(page, 'with the internet')
  await thread(page).getByText('Echo #2: with the internet.').waitFor()
  assert.equal(await valueOf(accessPicker(page)), 'Internet, GitHub', 'once the view has it')
})

test('U37 a phone: the pickers as marks, no arrow, nothing cut, each list below its trigger, the composer above the home indicator; wide: the same', async () => {
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
  const harness = harnessPicker(page)
  const coral = async () => (await accessPicker(page).locator('svg').getAttribute('class'))!.includes('text-primary')
  assert.equal(await coral(), true, 'the key coral: the Internet, on by default')
  await accessPicker(page).click()
  await internetSwitch(page).click()
  await page.keyboard.press('Escape')
  assert.equal(await coral(), false, 'not while nothing is granted')
  await accessPicker(page).click()
  await accessEntry(page, 'GitHub').click()
  await page.keyboard.press('Escape')
  // Narrow and wide alike: the harness's mark, the model · the effort, a person, the key; no arrow; each list below its trigger.
  const look = async (screen: string) => {
    assert.equal((await harness.innerText()).trim(), '', `${screen}: the harness as its mark alone`)
    assert.equal(await harness.locator('svg').first().isVisible(), true)
    assert.equal(await valueOf(harness), 'Mock agent')
    assert.equal((await modelPicker(page).innerText()).trim(), 'mock-large · high', `${screen}: the model · the effort`)
    assert.equal((await rolePicker(page).innerText()).trim(), '', `${screen}: the role as a person alone`)
    assert.equal((await accessPicker(page).innerText()).trim(), '', `${screen}: the key alone`)
    assert.equal(await valueOf(accessPicker(page)), 'GitHub')
    assert.equal(await coral(), true)
    assert.equal(await page.locator('main form svg[class*="chevron"]').count(), 0, `${screen}: no arrow`)
    assert.deepEqual(await cut(page, 'main form button'), [], `${screen}: no picker cut`)
    for (const picker of [harness, modelPicker(page), rolePicker(page), accessPicker(page)]) {
      // Measured before it opens: an open list hides the rest of the page from the accessibility tree.
      const [trigger, name] = [await picker.boundingBox(), await picker.getAttribute('aria-label')]
      await picker.click()
      const list = page.locator('[role="menu"][data-state="open"]')
      await list.waitFor()
      const opened = await list.boundingBox()
      assert.ok(opened!.y >= trigger!.y + trigger!.height, `${screen}: ${name}'s list below it`)
      await page.keyboard.press('Escape')
      await list.waitFor({ state: 'detached' })
    }
  }
  await look('narrow')
  await page.setViewportSize({ width: 1400, height: 900 })
  await look('wide')
  await insets(0)
  await page.goto(`${server.url}/w/${id}`)
  await thread(page).getByText('Echo #1: a session for the phone').waitFor()
  assert.equal(await composerMargin(page), 20, 'without a home indicator, the usual margin')
})

test('U118 every picker\'s list, in a draft and in an open Workstream, at 1280 and 390 px: its top below its trigger\'s bottom; above its trigger only where it does not fit below', async (t) => {
  const contexts = [
    { screen: '1280 × 800', make: () => browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' }) },
    { screen: '390 × 844', make: () => browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' }) },
  ]
  for (const { screen, make } of contexts) {
    const page = await (await make()).newPage()
    page.setDefaultTimeout(30_000)
    // Each list opened from its trigger, measured, and told: where it opened, and the room it had below.
    const measure = async (where: string, picker: Locator) => {
      // Measured before it opens: an open list hides the rest of the page from the accessibility tree.
      const [trigger, name] = [(await picker.boundingBox())!, (await picker.getAttribute('aria-label'))!.split(':')[0]!]
      await picker.click()
      const list = page.locator('[role="menu"][data-state="open"]')
      await list.waitFor()
      const opened = (await list.boundingBox())!
      const bottom = trigger.y + trigger.height
      const room = page.viewportSize()!.height - bottom
      const below = opened.y >= bottom
      t.diagnostic(`${screen}, ${where}, ${name}: list top ${Math.round(opened.y)}, height ${Math.round(opened.height)}; trigger top ${Math.round(trigger.y)}, bottom ${Math.round(bottom)}; room below ${Math.round(room)}: ${below ? 'below' : 'above'}`)
      if (!below) {
        assert.ok(opened.y + opened.height <= trigger.y, `${screen}, ${where}: ${name}'s list either below its trigger or wholly above it`)
        assert.ok(opened.height > room, `${screen}, ${where}: ${name}'s list above only where it does not fit below`)
      }
      await page.keyboard.press('Escape')
      await list.waitFor({ state: 'detached' })
    }
    const id = await started(page, `a workstream for the lists at ${screen}`)
    // The open Workstream: its harness a mark with no list, no role picker; the model and the access.
    assert.equal(await harnessPicker(page).count(), 0, `${screen}: once started, the harness is no picker`)
    assert.equal(await rolePicker(page).count(), 0)
    // Its composer at the foot of the screen: there a list that does not fit below opens above.
    for (const picker of [modelPicker(page), accessPicker(page)]) await measure('open Workstream', picker)
    await shot(page, `U118-${screen.split(' ')[0]}-open`)
    // The draft: the four pickers.
    await page.goto(`${server.url}/`)
    await pickHarness(page, 'Mock agent')
    for (const picker of [harnessPicker(page), modelPicker(page), rolePicker(page), accessPicker(page)]) await measure('draft', picker)
    assert.ok(id)
    await shot(page, `U118-${screen.split(' ')[0]}-draft`)
    await page.context().close()
  }
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

test('U52 the proxy’s identity: the person’s e-mail at the sidebar’s foot; opened, Sign out alone; the list the person’s one Workstream, not someone else’s', async () => {
  const page = await proxied()
  // The person's Workstream and one of someone else's; listed for the question each waits on.
  const ask = { title: 'Listed', text: '', options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { optionId: 'b', name: 'B', kind: 'reject_once' }] }
  const owners = { own: identity('owner', PERSON), other: identity('owner', 'someone@example.org') }
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
  // The list: the person's one Workstream, which opens.
  await until('the person’s Workstream listed', async () => (await listItems(page).count()) === 1)
  await listItems(page).click()
  await page.waitForURL(new RegExp(`/w/${made.own!}$`))
  assert.equal(await listItems(page).count(), 1, 'still the one')
  await shot(page, 'U52-account')
  await page.context().close()
  // The other's Workstream is listed for its own owner: it was there to be left out.
  const theirs = await proxied('someone@example.org')
  await theirs.goto(`${server.url}/`)
  await until('the other’s Workstream listed for them', async () => (await listItems(theirs).count()) === 1)
  await listItems(theirs).click()
  await theirs.waitForURL(new RegExp(`/w/${made.other!}$`))
  await theirs.context().close()
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
/** The lists' requests, by what they read: the person's list, a page. */
const listReads = (page: Page): string[] => {
  const reads: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/workstreams/list') reads.push('list')
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
  assert.deepEqual([...reads].sort(), ['list', 'page'])
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
  assert.deepEqual([...reads].sort(), ['list'])
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
  assert.deepEqual([...reads].sort(), ['list'])
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

test('U65 an agent’s spawn_agent within its rights, then its last message of 10,000 characters: the line names and links to it; working, then idle; the message shown as the delegate’s, whole, by its title, then the agent’s answer', async () => {
  const page = await fresh()
  await delegating(page, 'before delegating')
  await send(page, delegateCall({ instructions: '/sleep 3', harness: 'mock' }))
  const line = delegateLine(page, '/sleep 3 · Mock agent')
  await line.getByText('working', { exact: true }).waitFor()
  await shot(page, 'u65-working')
  assert.match(String(await line.getByRole('link', { name: '/sleep 3 · Mock agent' }).getAttribute('href')), /^\/w\/[0-9a-f-]{36}$/)
  await line.getByText('idle', { exact: true }).waitFor()
  // Its last message: a line of the delegator's next turn, closed, by the delegate's title and its first line.
  const said = thread(page).locator('[data-message="delegate"]').last()
  await said.getByText('From /sleep 3 · … second 1/3', { exact: true }).waitFor()
  assert.equal(await lineButton(said).getAttribute('aria-expanded'), 'false', 'closed')
  assert.equal(await said.locator('[data-message-text]').count(), 0)
  await thread(page).getByText(/Echo #\d+: … second 1\/3/).waitFor()
  await shot(page, 'u65-idle')
  await lineButton(said).click()
  await said.locator('[data-message-text]').getByText(/Slept 3 s\./).waitFor()
  assert.equal(await said.getByRole('link').innerText(), 'From /sleep 3')
  assert.equal(await said.getByRole('link').getAttribute('href'), await line.getByRole('link').getAttribute('href'), 'a link to the delegate')
  // Whole, however long.
  await send(page, delegateCall({ instructions: '/words 10000', harness: 'mock' }))
  const long = messageLine(page, 'From /words 10000 · word word')
  await long.waitFor()
  await lineButton(long).click()
  const whole = await long.locator('[data-message-text]').innerText()
  assert.ok(whole.length >= 9_900, String(whole.length))
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

test('U101 a delegate whose agent asks a permission: its delegator’s row waiting for you, the delegate’s too once unfolded; the delegate’s line waiting for you; Agora’s message naming the request, the tool call and each option; in the delegate’s thread, its card', async () => {
  const page = await proxied('requests@example.org')
  await delegating(page, 'before the request')
  await send(page, delegateCall({ instructions: '/permission', harness: 'mock' }))
  const line = delegateLine(page, '/permission · Mock agent')
  await line.getByText('waiting for you').waitFor()
  const agora = thread(page).locator('[data-agora]').last()
  await agora.getByText(/^From Agora · Your delegate [0-9a-f-]{36} "\/permission": it waits for an answer to its request \d+: a permission\.$/).waitFor()
  await lineButton(agora).click()
  await agora.locator('[data-message-text]').getByText(/it waits for an answer to its request \d+: a permission\./).waitFor()
  const said = await agora.locator('[data-message-text]').innerText()
  assert.match(said, /Asked: Write demo\.txt \(edit\)/)
  assert.match(said, /allow-once: Allow \(allow_once\)/)
  assert.match(said, /reject-once: Reject \(reject_once\)/)
  assert.match(said, /answer_agent/)
  const nav = page.getByRole('navigation', { name: 'Workstreams' })
  await nav.locator('button[aria-current="page"]').getByText('waiting for you').waitFor()
  await shot(page, 'u101-delegator')
  await nav.getByRole('button', { name: 'Unfold' }).click()
  const row = nav.getByRole('group').locator('button[title]')
  await row.getByText('waiting for you').waitFor()
  assert.match(await row.innerText(), /^\/permission/)
  await shot(page, 'u101-tree')
  await row.click()
  await page.getByText('asks before it goes on').waitFor()
  await page.getByRole('navigation', { name: 'Workstreams' }).locator('button[aria-current="page"]').getByText('waiting for you').waitFor()
  await shot(page, 'u101-delegate')
  await page.context().close()
})

test('U102 a delegate’s permission answered by its delegator’s answer_agent: the delegator’s line naming the delegate; in the delegate’s thread, no card, its line noting “allowed by its delegator”, the agent going on', async () => {
  const page = await proxied('answered@example.org')
  await delegating(page, 'before answering')
  await send(page, delegateCall({ instructions: '/permission', harness: 'mock' }))
  const line = delegateLine(page, '/permission · Mock agent').first()
  await line.getByText('waiting for you').waitFor()
  const delegate = /\/w\/([0-9a-f-]{36})$/.exec(String(await line.getByRole('link').getAttribute('href')))![1]!
  // The request's number, as Agora's message gives it to the delegator.
  const agora = thread(page).locator('[data-agora]').last()
  await lineButton(agora).click()
  const request = /its request (\d+):/.exec(await agora.locator('[data-message-text]').innerText())![1]!
  await send(page, `/answer_agent ${JSON.stringify({ to: delegate, request, option: 'allow-once' })}`)
  await thread(page).getByText(`Answered: answered ${delegate} · /permission`).waitFor()
  await until('both lines naming it, neither waiting', async () => (await delegateLine(page, '/permission · Mock agent').count()) === 2 && (await delegateLine(page, '/permission · Mock agent').getByText('waiting for you').count()) === 0)
  await shot(page, 'u102-delegator')
  await line.getByRole('link').click()
  await thread(page).getByText('Permission: allow-once.').waitFor()
  assert.equal(await page.getByText('asks before it goes on').count(), 0)
  // Its line, answered, folded with its task — its delegator's message —, which it follows.
  const fold = thread(page).locator('[data-tool-fold]').last()
  await fold.getByText('1 message, 1 edit', { exact: true }).waitFor()
  await lineButton(fold).click()
  await fold.getByText('allowed by its delegator').waitFor()
  await shot(page, 'u102-delegate')
  await page.context().close()
})

test('U64 a delegate’s Workstream opened: its first message shown as from its delegator, by its title, not as the person’s', async () => {
  const page = await fresh()
  const caller = await delegating(page, 'the caller')
  await send(page, delegateCall({ instructions: 'hello delegate', harness: 'mock' }))
  await delegateLine(page, 'hello delegate · Mock agent').getByRole('link').click()
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  // Its first message, its delegator's: a line of its response, not a bubble of the person's.
  const first = thread(page).locator('[data-message="delegator"]').first()
  await first.getByText('From the caller · hello delegate', { exact: true }).waitFor()
  assert.equal(await first.getAttribute('data-from'), caller)
  assert.equal(await thread(page).locator('[data-role="user"]').count(), 0, 'no bubble of the person’s')
  await shot(page, 'u64-delegate')
  await lineButton(first).click()
  await first.getByRole('link', { name: 'From the caller' }).click()
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
  // At its place in the response, after the command it came during, the response not split: one assistant message under the person's.
  const response = thread(page).locator('[data-role="assistant"]').last()
  await response.getByText(/Heard: … second 1\/2/).waitFor()
  assert.deepEqual((await thread(page).locator('[data-role]').evaluateAll((all) => all.map((m) => m.getAttribute('data-role')))).slice(-2), ['user', 'assistant'])
  assert.equal(await thread(page).locator('[data-role="user"]').last().innerText(), '/tool-open 6')
  const fold = response.locator('[data-tool-fold]')
  await lineButton(fold).click()
  const said = fold.locator('[data-message="delegate"]')
  await said.getByText('From /sleep 2 · … second 1/2', { exact: true }).waitFor()
  assert.deepEqual(await traceWords(fold), ['1 command, 1 message', 'A long command', 'From /sleep 2 · … second 1/2'])
  await lineButton(said).click()
  await said.locator('[data-message-text]').getByText(/Slept 2 s\./).waitFor()
  assert.equal(await said.getByRole('link').innerText(), 'From /sleep 2')
  await shot(page, 'u76-in-the-thread')
  // One of Agora's.
  await cancelButton(page).waitFor({ state: 'detached', timeout: 20_000 })
  await send(page, delegateCall({ instructions: '/turn-error', harness: 'mock' }))
  const agora = thread(page).locator('[data-agora]').last()
  await agora.getByText(/^From Agora · Your delegate [0-9a-f-]{36} "\/turn-error": Its turn failed/).waitFor()
  await lineButton(agora).click()
  await agora.locator('[data-message-text]').getByText(/Its turn failed/).waitFor()
  await shot(page, 'u76-agora')
})

test('U113 a delegator running a command while a delegate’s turn ends and the person stops another: both waiting, then one fold of the command and both messages, closed, counting them; opened, each line, closed; one opened, its writer’s link and its text; the agent’s text after it', async () => {
  const page = await fresh()
  await delegating(page, 'before the fold')
  await send(page, delegateCall({ instructions: '/sleep 5', harness: 'mock' }))
  const reporting = delegateLine(page, '/sleep 5 · Mock agent')
  await reporting.getByText('working', { exact: true }).waitFor()
  await send(page, delegateCall({ instructions: '/sleep 60', harness: 'mock' }))
  const stopped = delegateLine(page, '/sleep 60 · Mock agent')
  await stopped.getByText('working', { exact: true }).waitFor()
  const other = /\/w\/([0-9a-f-]{36})$/.exec(String(await stopped.getByRole('link').getAttribute('href')))![1]!
  // A command of 8 s, then 4 s before the agent speaks again.
  await send(page, '/tool-open 8 completed 4')
  await cancelButton(page).waitFor()
  const response = thread(page).locator('[data-role="assistant"]').last()
  await response.getByText('A long command').waitFor()
  // The person stops the second delegate while the command runs: Agora tells the delegator, as the first's last message comes.
  const { execution } = (await viewOf(server.url, other)) as { execution: string }
  assert.equal((await server.command(other, 'Stop', { execution }, {})).status, 200)
  // No message goes into a turn while one of its tools is open (docs/specs/log.md, "Messages during a turn"): both wait.
  await until('both waiting', async () => (await waitingList(page).count()) === 2)
  assert.equal(await response.locator('[data-tool-fold]').count(), 0, 'the command alone on its line meanwhile')
  await shot(page, 'u113-waiting')
  // The command over, both come in after it: one fold, closed, its response running on, saying its last line and what it holds.
  const fold = response.locator('[data-tool-fold]')
  await fold.getByText('1 tool, 2 messages', { exact: true }).waitFor({ timeout: 15_000 })
  const [latest, size, ...more] = await traceWords(fold)
  assert.match(String(latest), /^From (Agora|\/sleep 5) · /)
  assert.deepEqual([size, more], ['1 tool, 2 messages', []], 'closed while it runs')
  assert.equal(await waitingList(page).count(), 0)
  await shot(page, 'u113-running')
  await response.getByText('Command done.').waitFor({ timeout: 20_000 })
  assert.deepEqual(await traceWords(fold), ['1 command, 2 messages'], 'closed once done, counting them')
  assert.equal(await fold.getByText('Command done.').count(), 0, 'the agent’s text out of it')
  assert.equal(await response.locator('[data-message]').count(), 0, 'its lines not shown')
  await shot(page, 'u113-folded')
  await lineButton(fold).click()
  await fold.locator('[data-message]').nth(1).waitFor()
  const [label, command, ...messages] = await traceWords(fold)
  assert.deepEqual([label, command], ['1 command, 2 messages', 'A long command'])
  assert.deepEqual(messages.sort(), ['From /sleep 5 · … second 1/5', `From Agora · Your delegate ${other} "/sleep 60": The person stopped it.`].sort())
  for (const line of await fold.locator('[data-message]').all()) assert.equal(await lineButton(line).getAttribute('aria-expanded'), 'false', 'each closed')
  const report = fold.locator('[data-message="delegate"]')
  await lineButton(report).click()
  await report.locator('[data-message-text]').getByText(/Slept 5 s\./).waitFor()
  assert.equal(await report.getByRole('link').innerText(), 'From /sleep 5')
  assert.equal(await report.getByRole('link').getAttribute('href'), await reporting.getByRole('link').getAttribute('href'))
  await shot(page, 'u113-opened')
})

test('U114 a delegate’s last message written in Markdown, its delegator idle: its own line, closed, no fold; opened, a link to the delegate and its text as Markdown; then the agent’s answer', async () => {
  const page = await fresh()
  await delegating(page, 'before the report')
  await send(page, delegateCall({ instructions: 'Report\n**Bold** words and `code`', harness: 'mock' }))
  const line = delegateLine(page, 'Report · Mock agent')
  await line.getByText('idle', { exact: true }).waitFor()
  const said = messageLine(page, 'From Report · ')
  await said.getByText('From Report · Echo #1: Report', { exact: true }).waitFor()
  await thread(page).getByText(/Echo #\d+: Echo #1: Report/).waitFor()
  assert.equal(await lineButton(said).getAttribute('aria-expanded'), 'false', 'closed')
  assert.equal(await thread(page).locator('[data-tool-fold]').filter({ has: said }).count(), 0, 'no fold')
  await shot(page, 'u114-alone')
  await lineButton(said).click()
  const text = said.locator('[data-message-text]')
  assert.equal(await text.locator('strong').innerText(), 'Bold')
  assert.equal(await text.locator('code').innerText(), 'code')
  assert.equal(await said.getByRole('link').innerText(), 'From Report')
  assert.equal(await said.getByRole('link').getAttribute('href'), await line.getByRole('link').getAttribute('href'))
  await shot(page, 'u114-alone-opened')
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
  // Simulated: the server's refusal of the Create that carries it.
  await page.route('**/commands', (route) =>
    route.request().postDataJSON().kind === 'Create' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ accepted: false, reason: 'permission_pending' }) }) : route.continue(),
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

/** What the mock agent is told of its own sub-agents (packages/mock-agent, `/sub`). */
const subCall = (options: Record<string, unknown>) => `/sub ${JSON.stringify(options)}`
/** A Workstream of the mock agent's whose first message starts sub-agents of its own. */
async function withSubagents(page: Page, options: Record<string, unknown>): Promise<string> {
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await send(page, subCall(options))
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  return idOf(page)
}
/** The rows under a root, once unfolded: its sub-streams. */
const nav = (page: Page) => page.getByRole('navigation', { name: 'Workstreams' })
/** A native sub-agent's line of a thread, by its label. */
const subagentLine = (page: Page, label: string) => thread(page).locator('[data-delegate]').filter({ hasText: label })

test('U88 a Workstream whose agent announced two sub-agents, one working, one asking a permission; its root folded, then unfolded: waiting for you; both rows under it, each after its sub-agent mark, the first working, the second waiting for you', async () => {
  // A list of its own: nobody else's Workstream waits or works in it.
  const page = await proxied('subagents-sidebar@example.org')
  await withSubagents(page, { n: 25, count: 2, permission: 2 })
  await subagentLine(page, 'Read the changelog').getByText('waiting for you').waitFor()
  // Folded: what waits under it comes up.
  await nav(page).getByText('waiting for you').waitFor()
  assert.equal(await listItems(page).count(), 1)
  await nav(page).getByRole('button', { name: 'Unfold' }).click()
  await until('its two sub-streams', async () => (await listItems(page).count()) === 3)
  const rows = nav(page).getByRole('group').locator('button[title]')
  // The most recently changed first: whichever that is, each says what it is and how it stands.
  assert.deepEqual((await rows.evaluateAll((all) => all.map((row) => row.textContent!.replace(/\s+/g, ' ').trim()))).sort(), ['sub-agentCount the files', 'sub-agentRead the changelogwaiting for you'])
  const working = rows.filter({ hasText: 'Count the files' })
  assert.equal(await working.locator('[aria-label="working"]').count(), 1, 'the working dot')
  assert.equal(await working.getByText('sub-agent', { exact: true }).count(), 1)
  assert.equal(await rows.filter({ hasText: 'Read the changelog' }).locator('[aria-label="working"]').count(), 0, 'waiting for you in place of its dot')
  await shot(page, 'u88-subagents-sidebar')
  await page.context().close()
})

test('U89 that Workstream’s thread: one line for each sub-agent at its announcement, with its title, a link to its sub-stream and its state; none of their text or tools; the model picker the Workstream’s own', async () => {
  // A list of its own: nobody else's Workstream waits or works in it.
  const page = await proxied('subagents-thread@example.org')
  const id = await withSubagents(page, { n: 3, count: 2, settings: true })
  for (const title of ['Count the files', 'Read the changelog']) {
    const line = subagentLine(page, title)
    await line.getByText('working').waitFor()
    assert.match((await line.getByRole('link').getAttribute('href')) ?? '', /^\/w\/[0-9a-f-]{36}$/)
  }
  await thread(page).getByText('Sub-agents done.').waitFor()
  for (const title of ['Count the files', 'Read the changelog']) await subagentLine(page, title).getByText('idle', { exact: true }).waitFor()
  await shot(page, 'u89-subagents-thread')
  assert.equal(await thread(page).getByText('Working on:').count(), 0, 'none of their text')
  assert.equal(await thread(page).getByText('ls -1 | wc -l').count(), 0, 'none of their tools')
  // Its settings are its own: the sub-agents' model never reached its picker.
  const view = await viewOf(server.url, id)
  assert.ok(!JSON.stringify(view?.settings).includes('sub-model') && view?.usage === null)
  assert.equal(await modelPicker(page).getByText('Sub model').count(), 0)
  await page.context().close()
})

test('U90 a native sub-stream opened, working, cancel advertised; then cancelled; one that advertises none; one with no task: its parents, its task as from its parent, its text and tools, no composer, Read-only; Cancel, sent to its host; then cancelled and no Cancel; never a Cancel; its response alone', async () => {
  // A list of its own: nobody else's Workstream waits or works in it.
  const page = await proxied('subagents-substream@example.org')
  const id = await withSubagents(page, { n: 25 })
  await subagentLine(page, 'Count the files').getByRole('link').click()
  await page.waitForURL((url) => /\/w\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(id))
  const child = idOf(page)
  // Its parents in the header, its task a line from its parent, its text and its tool.
  await page.locator('header').getByRole('button', { name: subCall({ n: 25 }) }).waitFor()
  await stateLabel(page, 'native').getByText('working').waitFor()
  const task = thread(page).locator('[data-message="parent"]')
  await task.getByText(`From ${subCall({ n: 25 })} · Count the files, and say how many.`).waitFor()
  await lineButton(task).click()
  await task.locator('[data-message-text]').getByText('Count the files, and say how many.').waitFor()
  await thread(page).getByText('Working on: Count the files.').waitFor()
  await thread(page).getByText('ls -1 | wc -l').waitFor()
  // No composer, no picker, no Stop: the line that says why, and Cancel.
  await thread(page).locator('[data-read-only]').getByText(`Read-only: a sub-agent of “${subCall({ n: 25 })}” takes no message.`).waitFor()
  assert.equal(await composerInput(page).count(), 0)
  assert.equal(await modelPicker(page).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0)
  await shot(page, 'u90-subagent-working')
  await page.locator('header').getByRole('button', { name: 'Cancel', exact: true }).click()
  await stateLabel(page, 'native').getByText('cancelled').waitFor()
  assert.equal(await page.locator('header').getByRole('button', { name: 'Cancel', exact: true }).count(), 0)
  // The Cancel went to its host, for the sub-stream's turn; none was written for the sub-stream itself.
  const cancels = (await entriesOf(id)).filter((e) => e.kind === 'command' && e.content.kind === 'Cancel')
  assert.equal(cancels.length, 1)
  assert.equal((await entriesOf(child)).length, 0)
  await shot(page, 'u90-subagent-cancelled')
  // One that advertises none, and reports no task: never a Cancel; its response alone.
  await page.goBack()
  await page.waitForURL((url) => url.pathname.endsWith(id))
  await thread(page).getByText('Sub-agents done.').waitFor()
  // In its host's thread its line says what happened to it: cancelled, as its turn was.
  await subagentLine(page, 'Count the files').getByText('cancelled', { exact: true }).waitFor()
  await send(page, subCall({ n: 6, cancel: false, task: false, title: 'List the tests' }))
  await subagentLine(page, 'List the tests').getByRole('link').click()
  await page.waitForURL((url) => /\/w\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(id))
  await stateLabel(page, 'native').getByText('working').waitFor()
  await thread(page).getByText('Working on: List the tests.').waitFor()
  assert.equal(await page.locator('header').getByRole('button', { name: 'Cancel', exact: true }).count(), 0)
  assert.equal(await thread(page).locator('[data-message]').count(), 0, 'no task: its response alone')
  await stateLabel(page, 'native').getByText('idle').waitFor()
  await page.context().close()
})

test('U91 a permission pending in a native sub-stream; an option chosen: its card in the sub-stream’s thread; RespondPermission sent to its host with that request; the option answered', async () => {
  // A list of its own: nobody else's Workstream waits or works in it.
  const page = await proxied('subagents-permission@example.org')
  const id = await withSubagents(page, { n: 2, permission: true })
  const line = subagentLine(page, 'Count the files')
  await line.getByText('waiting for you').waitFor()
  await line.getByRole('link').click()
  await page.waitForURL((url) => /\/w\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(id))
  const child = idOf(page)
  await stateLabel(page, 'native').getByText('waiting for you').waitFor()
  await shot(page, 'u91-subagent-permission')
  await thread(page).getByRole('button', { name: 'Allow', exact: true }).click()
  await until('its answer in its host’s log', async () => (await entriesOf(id)).some((e) => e.kind === 'command' && e.content.kind === 'RespondPermission'), 15_000)
  assert.equal((await entriesOf(child)).length, 0)
  await stateLabel(page, 'native').getByText('idle').waitFor()
  assert.equal(await thread(page).getByRole('button', { name: 'Allow', exact: true }).count(), 0)
  await page.context().close()
})

// ---------------------------------------------------------------- roles (docs/specs/assistant-ui.md, "Roles")

const rolePicker = (page: Page) => page.getByRole('button', { name: /^Role: / })
const harnessPicker = (page: Page) => page.getByRole('button', { name: /^Harness: / })
/** A role picked in its menu, by its name: `No role`, or a card's. */
async function pickRole(page: Page, name: string): Promise<void> {
  await rolePicker(page).click()
  await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click()
}
/** What the three other pickers show: the harness, the model with its effort, the access. */
const pickersOf = async (page: Page) => ({
  harness: await valueOf(harnessPicker(page)),
  model: await valueOf(modelPicker(page)),
  access: await valueOf(accessPicker(page)),
})
/**
 * A Session opened in each of the lab's pools, in a list of its own: a draft offers what a pool's last Session
 * gave, its models and efforts (docs/specs/assistant-ui.md, "Settings and commands").
 */
async function sessionsOpened(): Promise<void> {
  for (const pool of ['mock-test', 'claude-test']) {
    const offers = async () => ((await (await fetch(`${server.url}/api/pools`)).json()) as { pools: { name: string; settings: unknown[] | null }[] }).pools.find((p) => p.name === pool)?.settings
    if (await offers()) continue
    const id = randomUUID()
    assert.equal((await server.post('/api/workstreams', { id, owner: identity('owner', 'catalogue@example.org') })).status, 200)
    assert.equal((await server.command(id, 'Create', {}, { pool })).status, 200)
    await until(`${pool} offers its Session's settings`, offers)
  }
}
/** The commands the page posts, whole: each one's kind and body. */
function bodiesPosted(page: Page): { kind: string; body: Record<string, unknown> }[] {
  const posted: { kind: string; body: Record<string, unknown> }[] = []
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !/\/api\/workstreams\/[0-9a-f-]{36}\/commands$/.test(new URL(request.url()).pathname)) return
    const command = request.postDataJSON() as { kind: string; body: Record<string, unknown> }
    posted.push({ kind: command.kind, body: command.body })
  })
  return posted
}
/** The header's line after the title: the role when there is one, the harness, the state. */
const headerLine = async (page: Page) => (await page.locator('header').innerText()).replace(/\s+/g, ' ')

test('U92 roles offered: in a draft nothing was picked in, a role of another harness sets its card’s harness, model, effort and access; in one whose harness and model the person picked, its access alone; No role: back to the draft’s own, the person’s choices kept', async () => {
  await sessionsOpened()
  const page = await fresh()
  await page.goto(`${server.url}/`)
  // The picker: after the model, before the access; No role first, then each role by its name, its summary under it.
  for (const picker of [harnessPicker, modelPicker, rolePicker, accessPicker]) await picker(page).waitFor()
  assert.deepEqual(
    await page.locator('main form button[aria-haspopup="menu"]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')!.split(':')[0])),
    ['Harness', 'Model', 'Role', 'Access'],
  )
  assert.equal(await valueOf(rolePicker(page)), 'No role', 'a draft starts with no role')
  await rolePicker(page).click()
  assert.deepEqual(
    (await page.getByRole('menuitem').allInnerTexts()).map((text) => text.split('\n').map((line) => line.trim()).filter((line) => line !== '')),
    [['No role'], ['dev', 'Owns one feature end to end.'], ['judge', 'Says whether the work can ship.'], ['lead', 'Runs a small team on one goal.']],
  )
  await shot(page, 'U92-menu')
  await page.keyboard.press('Escape')
  // Nothing picked: the draft's own harness is the mock's, its access the Internet.
  const own = await pickersOf(page)
  assert.deepEqual([own.harness, own.access], ['Mock agent', 'Internet'])
  await shot(page, 'U92-draft')
  // A role of another harness: its card's harness, model and effort on their pickers, its access beside the Internet.
  await pickRole(page, 'lead')
  assert.equal(await valueOf(rolePicker(page)), 'lead')
  assert.deepEqual(await pickersOf(page), { harness: 'Claude Code', model: 'mock-large · high', access: 'Internet, agora' })
  await shot(page, 'U92-role')
  // One of the draft's own harness: its model and effort there, its access in place of the other's.
  await pickRole(page, 'dev')
  assert.deepEqual(await pickersOf(page), { harness: 'Mock agent', model: 'mock-small · low', access: 'Internet, GitHub (partly)' })
  assert.equal(await valueOf(accessPicker(page)), 'Internet, GitHub (partly)')
  // One whose card names nothing offered here — no Codex pool, no such profile —: the draft's own.
  await pickRole(page, 'judge')
  assert.equal(await valueOf(rolePicker(page)), 'judge')
  assert.deepEqual(await pickersOf(page), own)
  // No role: what a card had set, back to the draft's own.
  await pickRole(page, 'lead')
  assert.equal((await pickersOf(page)).harness, 'Claude Code')
  await pickRole(page, 'No role')
  assert.equal(await valueOf(rolePicker(page)), 'No role')
  assert.deepEqual(await pickersOf(page), own)

  // Another draft, its harness and its model the person's: a role of another harness leaves both as they are.
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await modelPicker(page).click()
  await page.getByRole('menuitem', { name: 'mock-large' }).click()
  const picked = await pickersOf(page)
  assert.match(picked.model, /^mock-large/)
  await pickRole(page, 'lead')
  assert.deepEqual(await pickersOf(page), { ...picked, access: 'Internet, agora' }, 'the card’s access granted, its harness and model not set')
  await shot(page, 'U92-own')
  // One of that harness: the model the person picked stays, where the card's stood in the draft nothing was picked in.
  await pickRole(page, 'dev')
  assert.deepEqual(await pickersOf(page), { ...picked, access: 'Internet, GitHub (partly)' })
  // No role: the card's access gone, the person's harness and model kept.
  await pickRole(page, 'No role')
  assert.deepEqual(await pickersOf(page), picked)
  assert.equal(picked.access, 'Internet')
  await shot(page, 'U92-no-role')
  // The access the person picked stays too, whatever role is picked after.
  await accessPicker(page).click()
  await internetSwitch(page).click()
  await accessEntry(page, 'GitHub').click()
  await page.keyboard.press('Escape')
  assert.equal((await pickersOf(page)).access, 'GitHub')
  await pickRole(page, 'lead')
  assert.deepEqual(await pickersOf(page), { ...picked, access: 'GitHub' })
  await page.context().close()
})

test('U93 lead picked in a draft, a first message: the Create carries the role, the card’s settings and the profiles shown; the Workstream opens with no role picker, its header naming the role before the harness', async () => {
  await sessionsOpened()
  const page = await fresh()
  const posted = bodiesPosted(page)
  await page.goto(`${server.url}/`)
  await pickRole(page, 'lead')
  assert.deepEqual(await pickersOf(page), { harness: 'Claude Code', model: 'mock-large · high', access: 'Internet, agora' })
  await shot(page, 'U93-draft')
  await send(page, 'lead the first task')
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  const id = idOf(page)
  // The agent was given the role's block ahead of the message; the person's bubble shows the message alone.
  await thread(page).getByText('Echo #1: From Agora, not the person: your role, lead.').waitFor()
  await thread(page).getByText('lead the first task.').waitFor()
  assert.deepEqual(await page.locator('main [data-role="user"]').allInnerTexts(), ['lead the first task'])
  // What the page sent, and what the log kept of it.
  assert.deepEqual(posted, [{ kind: 'Create', body: { pool: 'claude-test', settings: { model: 'mock-large', effort: 'high' }, profiles: ['internet', 'agora:delegate'], role: 'lead', prompt: [{ type: 'text', text: 'lead the first task' }] } }])
  const create = (await entriesOf(id)).find((e) => e.kind === 'command' && e.content.kind === 'Create')!
  const kept = create.content.body as { pool: string; role: string; settings: unknown; profiles: unknown }
  assert.deepEqual([kept.pool, kept.role, kept.settings, kept.profiles], ['claude-test', 'lead', [{ id: 'model', value: 'mock-large' }, { id: 'effort', value: 'high' }], ['internet', 'agora:delegate', 'agora:read', 'previews']])
  // Started: the role in the header, before the harness; no role picker, the other pickers the Session's own.
  await stateLabel(page, 'ready').waitFor()
  assert.equal(await page.locator('header [data-workstream-role]').innerText(), 'lead')
  assert.match(await headerLine(page), /lead the first task · lead · Claude Code · ready/)
  assert.equal(await rolePicker(page).count(), 0, 'no role picker once started')
  assert.match(await modelPicker(page).innerText(), /mock-large\s*·\s*high/)
  assert.equal(await valueOf(accessPicker(page)), 'Internet, agora')
  await shot(page, 'U93-started')
  // The next draft starts with no role, and with its own harness.
  await page.getByRole('button', { name: 'New workstream', exact: true }).click()
  await page.waitForURL(`${server.url}/`)
  assert.equal(await valueOf(rolePicker(page)), 'No role')
  assert.deepEqual([(await pickersOf(page)).harness, (await pickersOf(page)).access], ['Mock agent', 'Internet'])
  await page.context().close()
})

test('U94 a Workstream started with a role: a second message, then one after its execution ended: neither the Write nor the Create names a role; the header names it still', async () => {
  await sessionsOpened()
  const page = await fresh()
  const posted = bodiesPosted(page)
  await page.goto(`${server.url}/`)
  await pickRole(page, 'dev')
  assert.deepEqual(await pickersOf(page), { harness: 'Mock agent', model: 'mock-small · low', access: 'Internet, GitHub (partly)' })
  await send(page, 'a first task for the dev')
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  const id = idOf(page)
  await thread(page).getByText('a first task for the dev.').waitFor()
  await stateLabel(page, 'ready').waitFor()
  assert.match(await headerLine(page), /a first task for the dev · dev · Mock agent · ready/)
  // A second message, in the same execution.
  await send(page, 'a second message')
  await thread(page).getByText(/Echo #2: a second message\./).waitFor()
  assert.match(await headerLine(page), /· dev · Mock agent · ready/)
  await shot(page, 'U94-second')
  // Its execution ended: the harness picker is back, the role picker is not; the header names the role still.
  const view = (await viewOf(server.url, id)) as { execution: string }
  await page.locator('header').getByRole('button', { name: /Stop/ }).click()
  await expire(c.kube, claimName(view.execution))
  await stateLabel(page, 'ended').waitFor()
  await harnessPicker(page).waitFor()
  assert.equal(await rolePicker(page).count(), 0, 'no role picker once it has had an execution')
  assert.match(await headerLine(page), /· dev · Mock agent · ended/)
  await shot(page, 'U94-ended')
  await send(page, 'a message after the end')
  await thread(page).getByText(/Echo #3: a message after the end\./).waitFor()
  await stateLabel(page, 'ready').waitFor()
  assert.match(await headerLine(page), /· dev · Mock agent · ready/)
  await shot(page, 'U94-continued')
  // What the page sent: the first Create alone names the role.
  const sent = posted.filter((command) => ['Create', 'Write'].includes(command.kind))
  assert.deepEqual(sent.map((command) => [command.kind, command.body.role]), [['Create', 'dev'], ['Write', undefined], ['Create', undefined]])
  for (const command of sent.slice(1)) assert.ok(!('role' in command.body), `${command.kind} names no role`)
  assert.equal(((await viewOf(server.url, id)) as { role?: string }).role, 'dev', 'the Workstream’s role, kept')
  await page.context().close()
})

test('U95 no role offered: no role picker; a Create refused unknown_role: the message back in the composer with the reason', async () => {
  // A server that gives no role: its answer, its roles taken out.
  const without = await fresh()
  await without.route('**/api/config', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...((await response.json()) as Record<string, unknown>), roles: [] } })
  })
  await without.goto(`${server.url}/`)
  // What the same answer offers is there: the access picker.
  await accessPicker(without).waitFor()
  assert.equal(await rolePicker(without).count(), 0, 'no role picker')
  await shot(without, 'U95-no-role-offered')
  await without.context().close()
  // The control, and a role the server holds no card of: its answer, one more role in it.
  const page = await fresh()
  const posted = bodiesPosted(page)
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch()
    const config = (await response.json()) as { roles: unknown[] }
    await route.fulfill({ response, json: { ...config, roles: [...config.roles, { role: 'ghost', summary: 'A card the server no longer holds.', harness: 'mock', model: null, effort: null, access: [] }] } })
  })
  await page.goto(`${server.url}/`)
  await rolePicker(page).waitFor()
  await pickRole(page, 'ghost')
  assert.equal(await valueOf(harnessPicker(page)), 'Mock agent')
  await send(page, 'words for a ghost')
  await page.getByRole('alert').getByText('This role is no longer available.').waitFor()
  await until('the text back', async () => (await composerInput(page).inputValue()) === 'words for a ghost')
  // The server's own refusal, nothing written: the Workstream has had no execution, and offers the role picker still.
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  const id = idOf(page)
  assert.deepEqual(posted.map((command) => [command.kind, command.body.role]), [['Create', 'ghost']])
  assert.deepEqual((await entriesOf(id)).filter((e) => e.kind === 'command'), [])
  assert.equal(await valueOf(rolePicker(page)), 'ghost', 'as it was sent')
  assert.equal(await thread(page).locator('[data-role="user"]').count(), 0, 'no message in the thread')
  await shot(page, 'U95-refused')
  // Sent again with no role: it starts.
  await pickRole(page, 'No role')
  await page.getByRole('button', { name: 'Send' }).click()
  await thread(page).getByText('Echo #1: words for a ghost.').waitFor()
  assert.equal(await page.locator('header [data-workstream-role]').count(), 0)
  await page.context().close()
})

test('U96 roles offered, one picked: the role picker a person alone, coral, narrow and wide; its name in its menu, its tooltip and its accessible name; no picker cut', async () => {
  await sessionsOpened()
  const { page } = await phone()
  await page.goto(`${server.url}/`)
  const mask = rolePicker(page).locator('svg').first()
  const colour = (of: Locator) => of.evaluate((element) => getComputedStyle(element).color)
  // The page's coral, as any element in it has it.
  const coral = await page.evaluate(() => {
    const probe = document.body.appendChild(Object.assign(document.createElement('span'), { className: 'text-primary' }))
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  })
  // No role: the person alone, not coral; "No role" in its tooltip.
  await mask.waitFor()
  assert.equal((await rolePicker(page).innerText()).trim(), '', 'the person without a name')
  assert.equal(await rolePicker(page).getAttribute('title'), 'No role')
  assert.notEqual(await colour(mask), coral)
  await shot(page, 'U96-no-role')
  // Its menu names the roles; one picked: the person coral, its name in the tooltip, and marked in the menu.
  await rolePicker(page).tap()
  await page.getByRole('menuitem', { name: /^lead/ }).waitFor()
  await shot(page, 'U96-menu')
  await page.getByRole('menuitem', { name: /^lead/ }).tap()
  assert.equal((await rolePicker(page).innerText()).trim(), '', 'still no name')
  assert.equal(await mask.isVisible(), true)
  assert.equal(await colour(mask), coral, 'coral once a role is picked')
  assert.equal(await rolePicker(page).getAttribute('title'), 'lead')
  assert.equal(await valueOf(rolePicker(page)), 'lead', 'its name and value for assistive technology')
  // Its card's values on the other pickers: Claude Code's mark, its model · its effort, the key.
  assert.equal(await harnessPicker(page).getAttribute('title'), 'Claude Code')
  assert.equal((await modelPicker(page).innerText()).trim(), 'mock-large · high')
  assert.equal(await valueOf(accessPicker(page)), 'Internet, agora')
  assert.deepEqual(await cut(page, 'main form button'), [], 'no picker cut')
  await shot(page, 'U96-role')
  await rolePicker(page).tap()
  const items = (await page.getByRole('menuitem').allInnerTexts()).map((text) => text.split('\n')[0]!.trim())
  assert.deepEqual(items, ['No role', 'dev', 'judge', 'lead'], 'its name in its menu')
  // Wide, the same draft: the person alone still, its name in its tooltip.
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1400, height: 900 })
  assert.equal((await rolePicker(page).innerText()).trim(), '', 'no name, wide too')
  assert.equal(await mask.isVisible(), true)
  assert.equal(await rolePicker(page).getAttribute('title'), 'lead')
  await page.context().close()
})

test('U97 a model picked in a draft, a role with it, a message sent, then New workstream; a role picked there; an effort changed while a card’s show: the model as the person left it on the new draft, No role on its role picker; the role’s model not set over it; the model with its effort the person’s from then', async () => {
  await sessionsOpened()
  const page = await fresh()
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await modelPicker(page).click()
  await page.getByRole('menuitem', { name: 'mock-large' }).click()
  await pickRole(page, 'dev')
  assert.match((await pickersOf(page)).model, /^mock-large/, 'the person’s model, not the card’s mock-small')
  await send(page, 'the first one')
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
  await thread(page).getByText(/Echo #1/).waitFor()
  // The next draft: what the person picked is theirs still; the role is not kept.
  await page.getByRole('button', { name: 'New workstream', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await rolePicker(page).waitFor()
  assert.match((await pickersOf(page)).model, /^mock-large/)
  assert.equal(await valueOf(rolePicker(page)), 'No role')
  // The card's model, mock-small, is a default: never set over the person's.
  await pickRole(page, 'dev')
  assert.equal(await valueOf(rolePicker(page)), 'dev')
  assert.match((await pickersOf(page)).model, /^mock-large/)
  await shot(page, 'U97-next-draft')
  // The control: in a page where nothing was picked, the same role sets its card's model.
  const other = await fresh()
  await other.goto(`${server.url}/`)
  await pickRole(other, 'dev')
  assert.deepEqual((await pickersOf(other)).model, 'mock-small · low')
  // Its effort changed while the card's show: the model with its effort is the person's from then, No role or not.
  await modelPicker(other).click()
  await other.getByRole('menuitem', { name: 'high' }).click()
  assert.deepEqual((await pickersOf(other)).model, 'mock-small · high')
  await pickRole(other, 'No role')
  assert.deepEqual((await pickersOf(other)).model, 'mock-small · high')
  await other.context().close()
  await page.context().close()
})

/** Whether the page's pointers match a media query, as the composer asks it. */
const pointerMatches = (page: Page, query: string) => page.evaluate((q) => matchMedia(q).matches, query)
/** assistant-ui's query for a touch screen alone (`unstable_insertNewlineOnTouchEnter`). */
const TOUCH_ALONE = '(pointer: coarse) and (not (any-pointer: fine))'

test('U80 Enter in the composer with a mouse or a trackpad: sent; Shift+Enter a new line, nothing sent; Ctrl+Enter and Cmd+Enter: sent', async () => {
  const page = await fresh()
  assert.equal(await pointerMatches(page, '(any-pointer: fine)'), true, 'a fine pointer')
  assert.equal(await pointerMatches(page, TOUCH_ALONE), false, 'not a touch screen alone')
  await started(page, 'before the lines')
  const said = page.locator('main [data-role="user"]')
  await composerInput(page).fill('first line')
  await composerInput(page).press('Shift+Enter')
  await composerInput(page).pressSequentially('second line')
  assert.equal(await composerInput(page).inputValue(), 'first line\nsecond line')
  await page.waitForTimeout(500)
  assert.equal(await said.count(), 1, 'Shift+Enter sent nothing')
  await composerInput(page).press('Enter')
  await thread(page).getByText(/Echo #2: first line\s+second line\./).waitFor()
  assert.equal(await said.count(), 2)
  assert.match(await said.last().innerText(), /^first line\s+second line$/)
  assert.equal(await composerInput(page).inputValue(), '')
  await composerInput(page).fill('with Ctrl')
  await composerInput(page).press('Control+Enter')
  await thread(page).getByText('Echo #3: with Ctrl.').waitFor()
  assert.equal(await composerInput(page).inputValue(), '')
  await composerInput(page).fill('with Cmd')
  await composerInput(page).press('Meta+Enter')
  await thread(page).getByText('Echo #4: with Cmd.').waitFor()
  assert.equal(await said.count(), 4)
  assert.equal(await composerInput(page).inputValue(), '')
})

test('U115 Enter on a touch screen alone: a new line, nothing sent; Send, Ctrl+Enter and Cmd+Enter: sent', async () => {
  const { page } = await phone()
  assert.equal(await pointerMatches(page, TOUCH_ALONE), true, 'a touch screen alone')
  await started(page, 'before the phone lines')
  const said = page.locator('main [data-role="user"]')
  await composerInput(page).tap()
  await composerInput(page).fill('on the phone')
  await composerInput(page).press('Enter')
  await composerInput(page).pressSequentially('too')
  assert.equal(await composerInput(page).inputValue(), 'on the phone\ntoo')
  await page.waitForTimeout(500)
  assert.equal(await said.count(), 1, 'Enter sent nothing on the phone')
  await sendButton(page).tap()
  await thread(page).getByText(/Echo #2: on the phone\s+too\./).waitFor()
  assert.equal(await said.count(), 2)
  assert.equal(await composerInput(page).inputValue(), '')
  await composerInput(page).fill('with Ctrl')
  await composerInput(page).press('Control+Enter')
  await thread(page).getByText('Echo #3: with Ctrl.').waitFor()
  await composerInput(page).fill('with Cmd')
  await composerInput(page).press('Meta+Enter')
  await thread(page).getByText('Echo #4: with Cmd.').waitFor()
  assert.equal(await said.count(), 4)
  assert.equal(await composerInput(page).inputValue(), '')
})

test('U116 Enter on a touch screen with a fine pointer too, as an iPad with a Magic Keyboard: sent', async () => {
  // Chromium's touch emulation takes the fine pointer away (U115); the page's matchMedia gives it back
  // for any query on `any-pointer: fine`, the touch screen and the coarse primary pointer kept.
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, colorScheme: 'light' })
  await context.addInitScript(() => {
    const real = window.matchMedia.bind(window)
    window.matchMedia = (query: string) => real(query.replace(/any-pointer:\s*fine/g, 'min-width: 0px'))
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  await page.goto(`${server.url}/`)
  assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0), true, 'a touch screen')
  assert.equal(await pointerMatches(page, '(pointer: coarse)'), true, 'its primary pointer coarse')
  assert.equal(await pointerMatches(page, '(any-pointer: fine)'), true, 'a fine pointer too')
  assert.equal(await pointerMatches(page, TOUCH_ALONE), false, 'not a touch screen alone')
  await started(page, 'before the tablet line')
  const said = page.locator('main [data-role="user"]')
  await composerInput(page).tap()
  await composerInput(page).fill('on the tablet')
  await composerInput(page).press('Enter')
  await thread(page).getByText('Echo #2: on the tablet.').waitFor()
  assert.equal(await said.count(), 2)
  assert.equal(await composerInput(page).inputValue(), '')
  await context.close()
})

test('U117 Enter during an IME composition, and as Safari sends the one that ends it: nothing sent; a plain Enter sends; on an empty composer, nothing', async () => {
  const page = await fresh()
  await started(page, 'before the conversion')
  const said = page.locator('main [data-role="user"]')
  // A keydown as an IME gives it, which Playwright's keyboard cannot type.
  const enter = (init: { isComposing: boolean; keyCode: number }) =>
    composerInput(page).evaluate((input, { isComposing, keyCode }) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing, bubbles: true, cancelable: true })
      Object.defineProperty(event, 'keyCode', { value: keyCode })
      Object.defineProperty(event, 'which', { value: keyCode })
      input.dispatchEvent(event)
    }, init)
  await composerInput(page).fill('日本語')
  await enter({ isComposing: true, keyCode: 229 })
  await enter({ isComposing: false, keyCode: 229 })
  await page.waitForTimeout(500)
  assert.equal(await said.count(), 1, 'the conversion’s Enter sent nothing')
  assert.equal(await composerInput(page).inputValue(), '日本語')
  // The control: the same keydown, outside a composition, sends.
  await enter({ isComposing: false, keyCode: 13 })
  await thread(page).getByText('Echo #2: 日本語.').waitFor()
  assert.equal(await said.count(), 2)
  assert.equal(await composerInput(page).inputValue(), '')
  await composerInput(page).press('Enter')
  await page.waitForTimeout(500)
  assert.equal(await said.count(), 2, 'Enter on the empty composer sent nothing')
  assert.equal(await composerInput(page).inputValue(), '')
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
  // Measured once the messages have slid in.
  await page.waitForFunction(() => document.querySelector('main')!.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity))
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

test('U82 a text typed and not sent, and its attachment: each Workstream and the draft keep their own, moving between them and New workstream; the attachment sent; not after a reload', async () => {
  const page = await fresh()
  const alpha = await started(page, 'alpha draft task')
  const beta = await started(page, 'beta draft task')
  const list = page.getByRole('navigation', { name: 'Workstreams' })
  const tile = page.locator('main form').getByText('notes.md')
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Attach files' }).click()])
  await chooser.setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') })
  await tile.waitFor()
  await composerInput(page).fill('for beta')
  await list.getByText('alpha draft task').click()
  await page.waitForURL(`${server.url}/w/${alpha}`)
  await thread(page).getByText('Echo #1: alpha draft task.').waitFor()
  assert.equal(await composerInput(page).inputValue(), '', 'not the text of beta')
  assert.equal(await tile.count(), 0, 'not the attachment of beta')
  await composerInput(page).fill('for alpha')
  await page.getByRole('button', { name: 'New workstream', exact: true }).click()
  await page.waitForURL(`${server.url}/`)
  await page.getByText('What shall we work on?').waitFor()
  assert.equal(await composerInput(page).inputValue(), '', 'not the text of alpha')
  assert.equal(await tile.count(), 0, 'not the attachment of beta')
  await composerInput(page).fill('for the draft')
  await list.getByText('beta draft task').click()
  await page.waitForURL(`${server.url}/w/${beta}`)
  await thread(page).getByText('Echo #1: beta draft task.').waitFor()
  assert.equal(await composerInput(page).inputValue(), 'for beta')
  await tile.waitFor()
  assert.equal(await tile.count(), 1)
  await list.getByText('alpha draft task').click()
  await page.waitForURL(`${server.url}/w/${alpha}`)
  assert.equal(await composerInput(page).inputValue(), 'for alpha')
  // Once alpha's view, and so its adapter, is known: still none of beta's.
  await thread(page).getByText('Echo #1: alpha draft task.').waitFor()
  await page.waitForTimeout(300)
  assert.equal(await tile.count(), 0)
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
  // Beta's attachment, added again, is sent with its text.
  await list.getByText('beta draft task').click()
  await page.waitForURL(`${server.url}/w/${beta}`)
  await tile.waitFor()
  assert.equal(await composerInput(page).inputValue(), 'for beta')
  await page.getByRole('button', { name: 'Send' }).click()
  await thread(page).getByText('Echo #2: for beta.').waitFor()
  const prompts = (await entriesOf(beta)).filter((e) => e.kind === 'acp' && (e as unknown as { method: string }).method === 'session/prompt').map((e) => JSON.stringify(e))
  assert.ok(prompts.some((p) => p.includes('for beta') && p.includes('notes.md') && p.includes('# Notes')), 'the prompt holds the file')
  // Kept in the page only: alpha's text, still kept, is gone after a reload.
  await list.getByText('alpha draft task').click()
  await page.waitForURL(`${server.url}/w/${alpha}`)
  assert.equal(await composerInput(page).inputValue(), 'for alpha')
  await page.reload()
  await thread(page).getByText('Echo #1: alpha draft task.').waitFor()
  assert.equal(await composerInput(page).inputValue(), '')
  assert.equal(await tile.count(), 0)
})

test('U83 a Write refused once the person has moved to another Workstream: neither its text nor its reason there; both back in its own', async () => {
  const page = await fresh()
  const alpha = await started(page, 'alpha refused task')
  const beta = await started(page, 'beta refused task')
  const list = page.getByRole('navigation', { name: 'Workstreams' })
  // Simulated: the server's refusal, held until the person has moved.
  let release = () => {}
  const moved = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/commands', async (route) => {
    await moved
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ accepted: false, reason: 'permission_pending' }) })
  })
  const answered = page.waitForResponse('**/commands')
  await composerInput(page).fill('sent from beta')
  await composerInput(page).press('ControlOrMeta+Enter')
  await until('the field emptied by the send', async () => (await composerInput(page).inputValue()) === '')
  await list.getByText('alpha refused task').click()
  await page.waitForURL(`${server.url}/w/${alpha}`)
  await thread(page).getByText('Echo #1: alpha refused task.').waitFor()
  release()
  assert.equal((await answered).status(), 409)
  await page.waitForTimeout(300)
  assert.equal(await composerInput(page).inputValue(), '', 'not in the other Workstream')
  assert.equal(await page.getByRole('alert').getByText('Answer the permission request first.').count(), 0, 'its reason not said there')
  await page.unroute('**/commands')
  await list.getByText('beta refused task').click()
  await page.waitForURL(`${server.url}/w/${beta}`)
  await until('the text back in its own', async () => (await composerInput(page).inputValue()) === 'sent from beta')
  await page.getByRole('alert').getByText('Answer the permission request first.').waitFor()
})

/** The `session/prompt` lines of a Workstream, each as the text blocks it holds. */
const promptsOf = async (id: string): Promise<string[][]> =>
  (await entriesOf(id))
    .filter((e) => e.kind === 'acp' && (e as unknown as { method: string }).method === 'session/prompt')
    .map((e) => ((e.content.params as { prompt: { type: string; text?: string }[] }).prompt ?? []).filter((b) => b.type === 'text').map((b) => String(b.text)))

test('U85 a first message, its Workstream left before its Session opens for an ended one, a message sent there: both go, each a Create carrying it; neither waits for its Workstream to be on screen', async (t) => {
  const page = await fresh()
  const alpha = await started(page, 'alpha kept task')
  const view = (await viewOf(server.url, alpha)) as { execution: string }
  await page.locator('header').getByRole('button', { name: /Stop/ }).click()
  await expire(c.kube, claimName(view.execution))
  await stateLabel(page, 'ended').waitFor()
  const list = page.getByRole('navigation', { name: 'Workstreams' })
  const posted = commandsPosted(page)
  // Each Pod three seconds to come: both Workstreams are left before their Session opens.
  c.kube.allocationDelayMs = 3_000
  let beta = ''
  try {
    await page.getByRole('button', { name: 'New workstream', exact: true }).click()
    await page.waitForURL(`${server.url}/`)
    await pickHarness(page, 'Mock agent')
    await send(page, 'a side question')
    await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
    beta = idOf(page)
    assert.notEqual(beta, alpha)
    await list.getByText('alpha kept task').click()
    await page.waitForURL(`${server.url}/w/${alpha}`)
    await thread(page).getByText('Echo #1: alpha kept task.').waitFor()
    assert.deepEqual(await promptsOf(beta), [], 'left before its Session opened')
    await send(page, 'a follow-up')
    await thread(page).getByText('waiting for the sandbox').waitFor()
    // The other one's message goes while this Workstream is the one on screen.
    await until('the side question sent', async () => (await promptsOf(beta)).length === 1, 30_000)
    assert.equal(new URL(page.url()).pathname, `/w/${alpha}`)
  } finally {
    c.kube.allocationDelayMs = 0
  }
  await thread(page).getByText(/a follow-up/).last().waitFor()
  await until('the follow-up sent', async () => (await promptsOf(alpha)).length === 2, 30_000)
  // Restored from its anchor, the mock agent says what it remembers after its echo.
  await thread(page).getByText(/Echo #2: a follow-up\./).waitFor()
  await list.getByText('a side question').click()
  await page.waitForURL(`${server.url}/w/${beta}`)
  await thread(page).getByText('Echo #1: a side question.').waitFor()
  assert.deepEqual((await promptsOf(beta)).map((p) => p.at(-1)), ['a side question'])
  assert.equal((await promptsOf(alpha)).at(-1)!.at(-1), 'a follow-up')
  assert.deepEqual(posted.map((c) => [c.workstream === beta ? 'beta' : 'alpha', c.kind, (c.prompt as { text: string }[])[0]?.text]), [
    ['beta', 'Create', 'a side question'],
    ['alpha', 'Create', 'a follow-up'],
  ])
  t.diagnostic(`posted: ${JSON.stringify(posted.map((c) => [c.workstream === beta ? 'beta' : 'alpha', c.kind]))}; prompts of beta ${JSON.stringify(await promptsOf(beta))}, the last of alpha ${JSON.stringify((await promptsOf(alpha)).at(-1))}`)
})

test('U86 a first message, the page reloaded while its sandbox starts: the message still in the thread, waiting for the sandbox; then the answer', async () => {
  const page = await fresh()
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  c.kube.allocationDelayMs = 5_000
  try {
    await send(page, 'kept across a reload')
    await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
    await thread(page).getByText('waiting for the sandbox').waitFor()
    await page.reload()
    await thread(page).getByText('kept across a reload', { exact: true }).waitFor()
    await thread(page).getByText('waiting for the sandbox').waitFor()
    await thread(page).getByText('starting Mock agent').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Send' }).count(), 0, 'a spinner in place of Send')
    assert.deepEqual(await promptsOf(idOf(page)), [], 'reloaded before its Session opened')
  } finally {
    c.kube.allocationDelayMs = 0
  }
  await thread(page).getByText('Echo #1: kept across a reload.').waitFor()
  assert.deepEqual(await promptsOf(idOf(page)), [['kept across a reload']])
})

test('U87 a first message with a file, its Pod never starting, its execution ended at its deadline: the reason, the text and the file back in the composer; after a reload too; sent again, the agent given both', async (t) => {
  const page = await fresh()
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  const composer = page.locator('main form')
  const tile = composer.getByText('notes.md')
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Attach files' }).click()])
  await chooser.setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') })
  await tile.waitFor()
  await composerInput(page).fill('read the notes')
  // Real: the Pod of this claim never starts; its claim then reaches its deadline.
  const factory = c.kube.bridgeFactory
  c.kube.bridgeFactory = () => new Promise(() => {})
  let id = ''
  try {
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForURL(/\/w\/[0-9a-f-]{36}$/)
    id = idOf(page)
    await thread(page).getByText('waiting for the sandbox').waitFor()
    const view = await until('its execution', async () => {
      const v = (await viewOf(server.url, id)) as { execution?: string } | undefined
      return v?.execution ? (v as { execution: string }) : null
    })
    await until('its claim', () => c.kube.claims.has(claimName(view.execution)))
    await expire(c.kube, claimName(view.execution))
  } finally {
    c.kube.bridgeFactory = factory
  }
  const reason = page.getByRole('alert').getByText('The sandbox could not start. Your message is back in the composer.')
  await reason.waitFor()
  await until('the text back', async () => (await composerInput(page).inputValue()) === 'read the notes')
  await tile.waitFor()
  assert.equal(await thread(page).getByText('waiting for the sandbox').count(), 0, 'no longer in the thread')
  assert.deepEqual(await promptsOf(id), [])
  await shot(page, 'U87-given-back')
  // After a reload: the log gives it back again.
  await page.reload()
  await reason.waitFor()
  await until('the text back after the reload', async () => (await composerInput(page).inputValue()) === 'read the notes')
  await tile.waitFor()
  // Sent again: another Create, and this time its message goes, the file with it.
  await page.getByRole('button', { name: 'Send' }).click()
  await thread(page).getByText('Echo #1: read the notes.').waitFor()
  const sent = (await entriesOf(id)).filter((e) => e.kind === 'acp' && (e as unknown as { method: string }).method === 'session/prompt').map((e) => (e.content.params as { prompt: Record<string, unknown>[] }).prompt)
  assert.deepEqual(sent, [[{ type: 'text', text: 'read the notes' }, { type: 'resource', resource: { uri: 'notes.md', mimeType: 'text/markdown', text: '# Notes\n' } }]])
  assert.equal(await reason.count(), 0, 'its reason gone with the next command')
  assert.equal(await composerInput(page).inputValue(), '')
  t.diagnostic(`given back: "${'read the notes'}" and notes.md, before and after a reload; sent again: ${JSON.stringify(sent)}`)
})

test('G8 a merge card: the pull request as a link, its state, Merge closed while it waits for a review, open once ready; merged, squash; a card a message cancels', async () => {
  const page = await fresh()
  pulls.set(7, { mergeable_state: 'blocked', merged: false })
  pulls.set(8, { mergeable_state: 'clean', merged: false })
  await page.goto(`${server.url}/`)
  await pickHarness(page, 'Mock agent')
  await accessPicker(page).click()
  await accessEntry(page, 'GitHub').click()
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
  // Agora's message, a line of the agent's response, and the agent's answer to it.
  await thread(page).locator('[data-agora]').getByText('From Agora · Pull request owner/a#7 merged (squash): f00d1234567890.', { exact: true }).waitFor()
  await thread(page).getByText(/^Echo #\d+: Pull request owner\/a#7 merged \(squash\): f00d1234567890\./).waitFor()
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

// ---------------------------------------------------------------- forms (docs/specs/assistant-ui.md, "Forms")

/** The form's box in the thread, by its shape. */
const formCard = (page: Page, shape: string) => thread(page).locator(`[data-form="${shape}"]`).last()

test('U104 Claude Code’s AskUserQuestion with one question: a box — who asks, the question, its options and an “Other” field, Answer and Decline at its foot; an option and a note answered: the agent given both; its receipt, no button', async () => {
  const page = await fresh()
  await started(page, 'before the question')
  await send(page, '/question')
  const card = formCard(page, 'select')
  await card.getByText('waiting for you').waitFor()
  assert.match(await card.innerText(), /Mock agent asks you\.[\s\S]*Which database should the service use\?[\s\S]*PostgreSQL[\s\S]*Managed and durable[\s\S]*SQLite[\s\S]*Other/)
  await page.getByText('Answer the question above.').waitFor()
  await shot(page, 'u104-select')
  await card.getByRole('radio', { name: /SQLite/ }).click()
  await card.getByRole('textbox').fill('for the tests only')
  await card.getByRole('button', { name: 'Answer' }).click()
  await thread(page).getByText('Elicitation: accept {"question_0":"SQLite","question_0_custom":"for the tests only"}.').waitFor()
  const receipt = thread(page).locator('[data-form="select"][data-form-status="answered"]')
  await receipt.waitFor()
  assert.match(await receipt.innerText(), /answered[\s\S]*SQLite[\s\S]*Other: for the tests only/)
  assert.equal(await receipt.getByRole('button').count(), 0)
  await shot(page, 'u104-select-answered')
  await page.context().close()
})

test('U105 Claude Code’s AskUserQuestion with two questions: a Question Flow, one step each, its count; the first answered by an option, the second by two options and a typed one: the agent given each; its receipt, each question and its answer', async () => {
  const page = await fresh()
  await started(page, 'before the questions')
  await send(page, '/question several')
  const card = formCard(page, 'flow')
  await card.getByText('waiting for you').waitFor()
  await card.getByText('1 of 2').waitFor()
  assert.match(await card.innerText(), /Please answer the following questions\.[\s\S]*Which database should the service use\?[\s\S]*PostgreSQL/)
  await shot(page, 'u105-flow')
  await card.getByRole('radio', { name: /PostgreSQL/ }).click()
  await card.getByRole('button', { name: 'Next' }).click()
  await card.getByText('2 of 2').waitFor()
  await card.getByRole('checkbox', { name: /Lint/ }).click()
  await card.getByRole('checkbox', { name: /Unit tests/ }).click()
  await card.getByRole('textbox').fill('a smoke test')
  await shot(page, 'u105-flow-second')
  await card.getByRole('button', { name: 'Answer' }).click()
  await thread(page).getByText('Elicitation: accept {"question_0":"PostgreSQL","question_1":["Lint","Unit tests"],"question_1_custom":"a smoke test"}.').waitFor()
  const receipt = thread(page).locator('[data-form="flow"][data-form-status="answered"]')
  await receipt.waitFor()
  assert.match(await receipt.innerText(), /Which database should the service use\?\s*PostgreSQL[\s\S]*Which checks should run before the merge\?\s*Lint, Unit tests — a smoke test/)
  await shot(page, 'u105-flow-answered')
  await page.context().close()
})

test('U106 one multi-select question: an Option List, then answered; an MCP server’s form of a number and a yes/no: a Question Flow, a number out of bounds held back; Codex’s one text: a field, Send', async () => {
  const page = await fresh()
  await started(page, 'before the lists')
  await send(page, '/question multi')
  const list = formCard(page, 'list')
  await list.getByText('waiting for you').waitFor()
  await list.getByRole('checkbox', { name: /Browser tests/ }).click()
  await shot(page, 'u106-list')
  await list.getByRole('button', { name: 'Answer' }).click()
  await thread(page).getByText('Elicitation: accept {"question_0":["Browser tests"]}.').waitFor()
  await thread(page).locator('[data-form="list"][data-form-status="answered"]').getByText('Browser tests').waitFor()
  await send(page, '/question mcp')
  const flow = formCard(page, 'flow')
  await flow.getByText('waiting for you').waitFor()
  await flow.getByText('How should the rollout go?').waitFor()
  await shot(page, 'u106-number')
  await flow.getByRole('textbox').fill('9')
  assert.equal(await flow.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled'), 'true')
  await flow.getByRole('textbox').fill('3')
  await flow.getByRole('button', { name: 'Next' }).click()
  // One option, no "Other" field: picked, it answers, as the registry's list does.
  await flow.getByRole('button', { name: 'Yes', exact: true }).click()
  await thread(page).getByText('Elicitation: accept {"canary":true,"replicas":3}.').waitFor()
  await send(page, '/form text')
  const text = formCard(page, 'text')
  await text.getByText('Which branch should the release start from?').waitFor()
  await text.getByRole('textbox').fill('release/2026.11')
  await text.getByRole('button', { name: 'Send' }).click()
  await thread(page).getByText('Elicitation: accept {"branch":"release/2026.11"}.').waitFor()
  await page.context().close()
})

test('U107 Codex’s form with a secret field: no field, no button; the box says Agora declined it and why; the agent told decline', async () => {
  const page = await fresh()
  await started(page, 'before the secret')
  await send(page, '/form secret')
  const card = thread(page).locator('[data-form-status="declined-by-agora"]')
  await card.waitFor()
  await thread(page).getByText('Elicitation: decline.').waitFor()
  assert.match(await card.innerText(), /Agora declined it: it asks for a secret, which Agora’s log would keep in clear/)
  assert.equal(await card.getByRole('button').count(), 0)
  assert.equal(await card.getByRole('textbox').count(), 0)
  await shot(page, 'u107-secret-declined')
  await page.context().close()
})

test('U108 Codex’s question with options: required, Answer closed until one is chosen; then Decline: the agent told decline; its box “declined”', async () => {
  const page = await fresh()
  await started(page, 'before declining')
  await send(page, '/form')
  const card = formCard(page, 'select')
  await card.getByText('Which environment should I deploy to?').waitFor()
  assert.match(await card.innerText(), /Codex needs your input to continue\./)
  assert.equal(await card.getByRole('button', { name: 'Answer' }).getAttribute('aria-disabled'), 'true')
  await card.getByRole('radio', { name: /None of the above/ }).click()
  assert.equal(await card.getByRole('button', { name: 'Answer' }).getAttribute('aria-disabled'), null)
  await card.getByRole('button', { name: 'Decline' }).click()
  await thread(page).getByText('Elicitation: decline.').waitFor()
  await thread(page).locator('[data-form="select"][data-form-status="declined"]').getByText('declined').waitFor()
  await page.context().close()
})

test('U109 a delegate’s agent asking a form: its delegator’s thread holding Agora’s message — the form, each field and its options, how to answer —; answered by answer_agent with its content: the delegate’s box, its receipt, “answered by its delegator”', async () => {
  const page = await proxied('forms@example.org')
  await delegating(page, 'before the form')
  await send(page, delegateCall({ instructions: '/question several', harness: 'mock' }))
  const line = delegateLine(page, '/question several · Mock agent').first()
  await line.getByText('waiting for you').waitFor()
  const delegate = /\/w\/([0-9a-f-]{36})$/.exec(String(await line.getByRole('link').getAttribute('href')))![1]!
  const agora = thread(page).locator('[data-agora]').last()
  await lineButton(agora).click()
  await agora.locator('[data-message-text]').getByText(/it waits for an answer to its request \d+: a form\./).waitFor()
  const said = await agora.locator('[data-message-text]').innerText()
  assert.match(said, /Asked: Please answer the following questions\./)
  assert.match(said, /question_0 \(one of the options below\): Database — Which database should the service use\?/)
  assert.match(said, /PostgreSQL: Managed and durable/)
  assert.match(said, /question_1 \(any of the options below\)/)
  assert.match(said, /question_1_custom \(text\): Other/)
  assert.match(said, /answer_agent/)
  await shot(page, 'u109-delegator')
  const request = /its request (\d+):/.exec(said)![1]!
  await send(page, `/answer_agent ${JSON.stringify({ to: delegate, request, content: { question_0: 'PostgreSQL', question_1: ['Lint'] } })}`)
  await thread(page).getByText(`Answered: answered ${delegate} · /question several`).waitFor()
  await line.getByRole('link').click()
  await thread(page).getByText('Elicitation: accept {"question_0":"PostgreSQL","question_1":["Lint"]}.').waitFor()
  const receipt = thread(page).locator('[data-form="flow"][data-form-status="answered"]')
  await receipt.getByText('answered by its delegator').waitFor()
  await shot(page, 'u109-delegate')
  await page.context().close()
})

test('U110 a form’s bounds: a required list with no minimum answered empty; a required text with no minimum answered empty; a list of two to three held back at one, never a fourth; a text of two to three code points: four letters held back, two emoji taken; the agent given each as the schema says', async () => {
  const page = await fresh()
  await started(page, 'before the bounds')
  await send(page, '/question bounds')
  const flow = formCard(page, 'flow')
  await flow.getByText('1 of 4').waitFor()
  // Tags, required, no minimum: Next open with nothing chosen.
  assert.equal(await flow.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled'), null)
  await flow.getByRole('button', { name: 'Next' }).click()
  // Code, a required text with no minimum: Next open, empty.
  await flow.getByText('2 of 4').waitFor()
  assert.equal(await flow.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled'), null)
  await flow.getByRole('button', { name: 'Next' }).click()
  // Checks, two to three.
  await flow.getByText('3 of 4').waitFor()
  await flow.getByRole('checkbox', { name: 'Lint' }).click()
  assert.equal(await flow.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled'), 'true')
  await flow.getByRole('checkbox', { name: 'Unit' }).click()
  assert.equal(await flow.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled'), null)
  await flow.getByRole('checkbox', { name: 'Browser' }).click()
  assert.equal(await flow.getByRole('checkbox', { name: 'Live' }).getAttribute('aria-disabled'), 'true')
  await flow.getByRole('checkbox', { name: 'Live' }).click({ force: true })
  assert.equal(await flow.getByRole('checkbox', { name: 'Live' }).getAttribute('aria-checked'), 'false')
  await shot(page, 'u110-bounds')
  await flow.getByRole('button', { name: 'Next' }).click()
  // Short name, two to three code points.
  await flow.getByText('4 of 4').waitFor()
  await flow.getByRole('textbox').fill('abcd')
  assert.equal(await flow.getByRole('button', { name: 'Answer' }).getAttribute('aria-disabled'), 'true')
  await flow.getByRole('textbox').fill('😀😀')
  assert.equal(await flow.getByRole('button', { name: 'Answer' }).getAttribute('aria-disabled'), null)
  await flow.getByRole('button', { name: 'Answer' }).click()
  await thread(page).getByText('Elicitation: accept {"code":"","tags":[],"short":"😀😀","checks":["lint","unit","browser"]}.').waitFor()
  await page.context().close()
})

test('U111 RespondElicitation answered 503 once, for a select then for a Question Flow: the reason said in the box, its controls back, no receipt; answered again: the agent given it, the receipt', async () => {
  const page = await fresh()
  let failing = true
  await page.route('**/api/workstreams/*/commands', async (route) => {
    const command = route.request().postDataJSON() as { kind?: string }
    if (command.kind === 'RespondElicitation' && failing) {
      failing = false
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ accepted: false, reason: 'unavailable' }) })
    }
    return route.continue()
  })
  await started(page, 'before the refusals')
  // A select, through the part's approval.
  await send(page, '/question')
  const select = formCard(page, 'select')
  await select.getByText('waiting for you').waitFor()
  await select.getByRole('radio', { name: /SQLite/ }).click()
  await select.getByRole('button', { name: 'Answer' }).click()
  await select.getByRole('alert').getByText('Agora cannot take it now; try again.').waitFor()
  assert.equal(await select.getAttribute('data-form-status'), 'pending')
  assert.equal(await select.locator('[data-state="receipt"]').count(), 0)
  assert.equal(await select.getByRole('button', { name: 'Answer' }).getAttribute('aria-disabled'), null)
  assert.ok(await select.getByRole('button', { name: 'Decline' }).isEnabled())
  await shot(page, 'u111-select-refused')
  await select.getByRole('button', { name: 'Answer' }).click()
  await thread(page).getByText('Elicitation: accept {"question_0":"SQLite"}.').waitFor()
  await thread(page).locator('[data-form="select"][data-form-status="answered"] [data-state="receipt"]').waitFor()
  // A Question Flow, through the part's interrupt.
  failing = true
  await send(page, '/question several')
  const flow = formCard(page, 'flow')
  await flow.getByText('1 of 2').waitFor()
  await flow.getByRole('radio', { name: /PostgreSQL/ }).click()
  await flow.getByRole('button', { name: 'Next' }).click()
  await flow.getByRole('checkbox', { name: /Lint/ }).click()
  await flow.getByRole('button', { name: 'Answer' }).click()
  await flow.getByRole('alert').getByText('Agora cannot take it now; try again.').waitFor()
  assert.equal(await flow.getAttribute('data-form-status'), 'pending')
  assert.equal(await flow.locator('[data-state="receipt"]').count(), 0)
  await flow.getByText('2 of 2').waitFor()
  assert.equal(await flow.getByRole('button', { name: 'Answer' }).getAttribute('aria-disabled'), null)
  assert.ok(await flow.getByRole('button', { name: 'Decline' }).isEnabled())
  await shot(page, 'u111-flow-refused')
  await flow.getByRole('button', { name: 'Answer' }).click()
  await thread(page).getByText('Elicitation: accept {"question_0":"PostgreSQL","question_1":["Lint"]}.').waitFor()
  await thread(page).locator('[data-form="flow"][data-form-status="answered"] [data-state="receipt"]').waitFor()
  await page.context().close()
})
