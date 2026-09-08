// The operator surface, driven the way an operator drives it (S13): a real Chromium, the real DOM,
// the real product API, a real model answer. Nothing here is a unit test — it spends model calls and
// creates a real Pod, deliberately.
//
// It exists because no other test in this repository can see what it sees. `client-boot.test.ts`
// proves the bundle loads; the server tests prove the API answers; neither can notice that pressing
// send does nothing. Both defects this script found on its first run were exactly that shape: the
// first message of a new conversation was dropped (the text became the title and nothing else), and
// the open Workstream's own state was never refreshed, so the screen did not move while the engine
// built a Pod, granted a credential and opened a Session.
//
// Playwright is NOT a dependency of this repository: install it where you run this.
//
//   npm i -D playwright && npx playwright install --with-deps chromium
//   kubectl -n agora-system port-forward svc/web 18080:8080 &
//   UI_URL=http://127.0.0.1:18080 OWNER=you@example.com node scripts/verify-ui.mjs
//
// The header is what oauth2-proxy sets after a successful OIDC login: this is the same request the
// browser makes on the other side of the gate. Point UI_URL at the public host instead and the gate
// will (correctly) send you to the identity provider rather than the app.
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const base = process.env.UI_URL ?? 'http://127.0.0.1:18080'
const owner = process.env.OWNER ?? 'operator@example.com'
const codeword = `VERVEINE-${Math.floor(Math.random() * 100000)}`
const shots = process.env.SHOTS ?? './ui-shots'

const steps = []
const record = (name, ok, detail = '') => {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  extraHTTPHeaders: { 'x-forwarded-email': owner },
})
const page = await context.newPage()
const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(String(e)))

try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForSelector('#new-chat', { timeout: 30_000 })
  record('the shell loads and renders', true, await page.title())
  await page.screenshot({ path: `${shots}/01-shell.png` })

  // What the footer must NOT do is claim an identity it cannot know: in production the browser sends
  // nothing and oauth2-proxy forwards the verified one, so "Session SSO" is the honest answer and an
  // email rendered there would be this client inventing it.
  const identity = (await page.textContent('#identity'))?.replace(/\s+/g, ' ').trim() ?? ''
  record('the identity shown is the one the browser can actually know', identity.includes('Session SSO'), identity.slice(0, 60))

  // The catalogue has to have arrived for the selectors to be usable at all.
  await page.click('#sel-harness')
  await page.waitForSelector('[data-harness]', { timeout: 15_000 })
  const harnesses = await page.$$eval('[data-harness]', (nodes) => nodes.map((n) => n.getAttribute('data-harness')))
  record('the catalogue reaches the browser', harnesses.length > 0, harnesses.join(', '))
  await page.click('[data-harness="claude-code"]')

  await page.click('#sel-model')
  await page.waitForSelector('[data-model]', { timeout: 15_000 })
  await page.click('[data-model="sonnet"]')
  await page.click('#sel-effort')
  await page.waitForSelector('[data-effort]', { timeout: 15_000 })
  await page.click('[data-effort="default"]')
  await page.click('#sel-capabilities')
  await page.waitForSelector('[data-capability]', { timeout: 15_000 })
  await page.click('[data-capability="provider.anthropic"]')
  await page.keyboard.press('Escape')
  const chosen = (await page.textContent('#sel-capabilities'))?.trim() ?? ''
  record('equipment is chosen through the UI, not a URL', chosen.includes('provider.anthropic'), chosen.slice(0, 60))
  await page.screenshot({ path: `${shots}/02-equipment.png` })

  await page.fill('#input', `Answer with exactly one short sentence including this word verbatim: ${codeword}`)
  await page.click('#send')
  record('sending creates the Workstream from the composer', true, codeword)

  // Convergence then a real answer: one Pod pulled, one credential injected, one model call.
  await page.waitForFunction(
    (word) => document.querySelector('.messages-inner')?.textContent?.includes(word) ?? false,
    codeword,
    { timeout: 900_000, polling: 2000 },
  )
  const answered = await page.waitForFunction(
    (word) => {
      const text = document.querySelector('.messages-inner')?.textContent ?? ''
      const after = text.slice(text.indexOf(word) + word.length)
      return after.includes(word) ? after : false
    },
    codeword,
    { timeout: 900_000, polling: 2000 },
  ).then((h) => h.jsonValue()).catch(() => null)
  record('the model answers, in the transcript on screen', answered !== null, String(answered ?? '').replace(/\s+/g, ' ').slice(0, 90))
  await page.screenshot({ path: `${shots}/03-answer.png`, fullPage: true })

  const power = (await page.textContent('#power-toggle'))?.trim() ?? ''
  record('the topbar reports the Workstream powered on', power.includes('ON'), power)

  await page.click('#power-toggle')
  await page.waitForFunction(() => document.querySelector('#power-toggle')?.textContent?.includes('OFF') ?? false, null, { timeout: 300_000, polling: 2000 })
  record('powering off from the UI takes effect', true, 'OFF')
  await page.screenshot({ path: `${shots}/04-off.png` })

  record('no console error along the way', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ').slice(0, 120))
} catch (error) {
  record('the run completed', false, String(error).split('\n')[0].slice(0, 160))
  await page.screenshot({ path: `${shots}/99-failure.png` }).catch(() => {})
} finally {
  writeFileSync(`${shots}/console.log`, consoleErrors.join('\n'))
  await browser.close()
}

const failed = steps.filter((s) => !s.ok)
console.log(`\n${steps.length - failed.length}/${steps.length} front-end checks passed`)
if (failed.length > 0) process.exit(1)
