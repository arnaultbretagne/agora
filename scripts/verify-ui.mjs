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
const failedCalls = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(String(e)))
// The product API's own refusals, with their bodies. Without this a failed send is invisible: the
// toast that reports it is gone in four seconds, long before any screenshot, and the console line
// the browser writes says only "409" with no path and no reason.
page.on('response', async (response) => {
  if (response.status() < 400 || !response.url().includes('/v1/')) return
  const body = await response.text().catch(() => '')
  failedCalls.push(`${String(response.status())} ${response.request().method()} ${new URL(response.url()).pathname} ${body.slice(0, 160)}`)
})

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
  // Asserted, not assumed. This line used to record `true` unconditionally, and passed on a run
  // where the send did nothing at all: no Workstream, no Intent, no prompt, and an error toast that
  // had vanished four seconds later.
  const created = await page
    .waitForFunction(() => document.querySelector('#power-toggle') !== null && document.querySelector('.topbar-title')?.textContent !== 'Nouvelle conversation', null, { timeout: 60_000, polling: 500 })
    .then(() => true)
    .catch(() => false)
  record('sending creates the Workstream from the composer', created, created ? codeword : `refused: ${failedCalls[0] ?? 'no failed call seen'}`)

  // Convergence then a real answer: one Pod pulled, one credential injected, one model call.
  //
  // What is asserted here is the TRANSCRIPT, not a substring. An earlier version of this check
  // looked for the codeword twice anywhere in the DOM and passed while the screen showed the answer
  // ABOVE the question — the operator's own message was in no projection at all and the browser was
  // drawing it from a local echo. A check that cannot see the order of a conversation cannot say the
  // conversation renders.
  const transcript = await page
    .waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('.messages-inner [data-role]')].map((node) => ({
          role: node.getAttribute('data-role'),
          text: (node.textContent ?? '').trim(),
        }))
        const agent = rows.find((row) => row.role === 'agent' && row.text.length > 0)
        return agent !== undefined && rows.length >= 2 ? rows : false
      },
      null,
      { timeout: 900_000, polling: 2000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null)
  const rows = transcript ?? []
  const firstUser = rows.findIndex((row) => row.role === 'user')
  const firstAgent = rows.findIndex((row) => row.role === 'agent')
  record('the question is in the transcript, before the answer', firstUser >= 0 && firstAgent > firstUser, rows.map((row) => `${row.role}:${row.text.slice(0, 24)}`).join(' | ').slice(0, 110))
  record('the question is the one that was typed', (rows[firstUser]?.text ?? '').includes(codeword), (rows[firstUser]?.text ?? '(none)').slice(0, 70))
  record('the model answers, in the transcript on screen', (rows[firstAgent]?.text ?? '').includes(codeword), (rows[firstAgent]?.text ?? '(none)').replace(/\s+/g, ' ').slice(0, 80))
  await page.screenshot({ path: `${shots}/03-answer.png`, fullPage: true })

  // A reload proves the record, not the browser's memory of it: the echo used to vanish here.
  await page.reload({ waitUntil: 'networkidle' })
  const afterReload = await page
    .waitForFunction(
      (word) => {
        const rows = [...document.querySelectorAll('.messages-inner [data-role]')].map((node) => ({ role: node.getAttribute('data-role'), text: (node.textContent ?? '').trim() }))
        return rows.some((row) => row.role === 'user' && row.text.includes(word)) ? rows : false
      },
      codeword,
      { timeout: 120_000, polling: 2000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null)
  record('the conversation survives a reload', afterReload !== null, afterReload === null ? 'the question is gone after F5' : `${String(afterReload.length)} rows`)
  await page.screenshot({ path: `${shots}/03b-reload.png`, fullPage: true })

  const power = (await page.textContent('#power-toggle'))?.trim() ?? ''
  record('the topbar reports the Workstream powered on', power.includes('ON'), power)

  await page.click('#power-toggle')
  await page.waitForFunction(() => document.querySelector('#power-toggle')?.textContent?.includes('OFF') ?? false, null, { timeout: 300_000, polling: 2000 })
  record('powering off from the UI takes effect', true, 'OFF')
  await page.screenshot({ path: `${shots}/04-off.png` })

  // A 409 is the browser reporting a response the client is designed to receive: the held first
  // message races the server's own admission check, which re-derives convergence at the instant of
  // the send, and the client re-holds and retries six seconds later. The browser logs it whatever
  // the client does with it. Everything else — a real script error, a 500, a failed asset — still
  // fails this check, which is the point of keeping it.
  const unexpected = consoleErrors.filter((line) => !/409/.test(line))
  record('nothing in the console but the expected admission retry', unexpected.length === 0, `${String(consoleErrors.length)} entries, ${String(unexpected.length)} unexpected${unexpected.length > 0 ? `: ${unexpected[0]?.slice(0, 90)}` : ''}`)
  const unexpectedCalls = failedCalls.filter((line) => !line.startsWith('409'))
  record('no API refusal but the expected admission retry', unexpectedCalls.length === 0, unexpectedCalls.slice(0, 2).join(' | ').slice(0, 150) || `${String(failedCalls.length)} refusals, all 409`)
} catch (error) {
  record('the run completed', false, String(error).split('\n')[0].slice(0, 160))
  await page.screenshot({ path: `${shots}/99-failure.png` }).catch(() => {})
} finally {
  writeFileSync(`${shots}/console.log`, [...consoleErrors, ...failedCalls].join('\n'))
  await browser.close()
}

const failed = steps.filter((s) => !s.ok)
console.log(`\n${steps.length - failed.length}/${steps.length} front-end checks passed`)
if (failed.length > 0) process.exit(1)
