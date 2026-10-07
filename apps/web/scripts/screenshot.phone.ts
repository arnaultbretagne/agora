// Renders the built client on a phone's screen (an iPhone's 390×844, touch, its safe areas: 47 px
// under the status bar, 34 px over the home indicator) against a real server — the log, the mechanics
// on FakeKube, real bridges and the mock agent — and saves screenshots, light and dark: a manual check
// of the screen, not evidence. Run from the log package, which provisions its database:
//   cd packages/log && SHOTS=/tmp/shots node test/run.ts ../../apps/web/scripts/screenshot.phone.ts
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium, type Page } from 'playwright'
import { cluster, database, Server, until } from '../../../packages/log/test/support.ts'

const shots = process.env.SHOTS ?? '/tmp/shots'
const SAFE_AREA = { top: 47, bottom: 34, left: 0, right: 0 }
// POOLS=<file>: the draft offers that catalogue instead (a copy of the cluster's GET /api/pools).
const pools = process.env.POOLS ? readFileSync(process.env.POOLS, 'utf8') : null

test('the client on a phone', { timeout: 40 * 60_000 }, async (t) => {
  mkdirSync(shots, { recursive: true })
  const db = await database()
  const c = await cluster()
  // A signer of its own and the access offered in the cluster; the gateway is never reached.
  const grants = join(mkdtempSync(join(tmpdir(), 'grants-')), 'key.pem')
  writeFileSync(grants, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const credentials = { GATEWAY_PROXY: '127.0.0.1:9', GRANTS_KEY_FILE: grants, OFFERED_PROFILES: 'github:owner/agora:write,github:owner/infra-k8s:read,internet' }
  const server = await Server.start({ db, api: c.api, keys: c.keys, env: credentials })
  const browser = await chromium.launch()
  t.after(async () => {
    await browser.close()
    await server.stop()
    await c.close()
    await db.drop()
  })
  const ws = randomUUID()
  await server.post('/api/workstreams', { id: ws, owner: randomUUID() })
  await server.command(ws, 'Create', {}, { pool: 'mock-test' })
  const views = async () => ((await (await fetch(`${server.url}/api/workstreams`)).json()) as { workstreams: Record<string, unknown>[] }).workstreams
  const view = await until('ready', async () => (await views()).find((v) => v.id === ws && v.state === 'ready'))
  const entries = async () => (await (await fetch(`${server.url}/api/workstreams/${ws}/entries`)).json()) as Record<string, unknown>[]
  const answered = async () => (await entries()).filter((e) => e.direction === 'in' && e.correlated_method === 'session/prompt').length
  const write = async (text: string) => server.command(ws, 'Write', { execution: view.execution, session: view.session }, { prompt: [{ type: 'text', text }] })
  await write('Hello agent, please fix the login page on the phone.')
  await until('first answer', async () => (await answered()) === 1)
  await write('/tool')
  await until('second answer', async () => (await answered()) === 2)

  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: scheme })
    const page = await context.newPage()
    // The safe areas of a home-screen app, where Chromium can emulate them.
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: SAFE_AREA })
    const shoot = async (p: Page, name: string) => p.screenshot({ path: join(shots, `${scheme}-${name}.png`) })
    if (pools !== null) await page.route('**/api/pools', (route) => route.fulfill({ contentType: 'application/json', body: pools }))
    await page.goto(`${server.url}/`)
    await page.getByRole('button', { name: 'Send' }).waitFor()
    await page.waitForTimeout(800)
    await shoot(page, '1-draft')
    await page.getByRole('button', { name: 'Model' }).click()
    await page.waitForTimeout(300)
    await shoot(page, '2-model-menu')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Harness' }).click()
    await page.waitForTimeout(300)
    await shoot(page, '2-harness-menu')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Access' }).click()
    await page.getByRole('menuitemradio', { name: 'Read' }).first().click()
    await page.waitForTimeout(300)
    await shoot(page, '2-access-menu')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await shoot(page, '2-access-granted')
    await page.goto(`${server.url}/w/${ws}`)
    await page.getByText('please fix the login page').first().waitFor()
    await page.waitForTimeout(800)
    await shoot(page, '3-thread')
    await page.getByRole('button', { name: 'Show the workstreams' }).first().click()
    await page.waitForTimeout(300)
    await shoot(page, '4-drawer')
    await context.close()
  }
  // HOLD=<seconds>: keep the server up to look at it by hand.
  if (process.env.HOLD) {
    console.log(`HOLDING ${server.url}/w/${ws}`)
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.HOLD) * 1000))
  }
})
