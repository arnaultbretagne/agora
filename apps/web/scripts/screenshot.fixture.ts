// Renders the built client against a real server — the log, the mechanics on FakeKube, real bridges and
// the mock agent — and saves screenshots: a manual check of the screen, not evidence. Run from the log
// package, which provisions its database:
//   cd packages/log && SHOTS=/tmp/shots node test/run.ts ../../apps/web/scripts/screenshot.fixture.ts
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cluster, database, Server, until } from '../../../packages/log/test/support.ts'

const shell = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell')
const shots = process.env.SHOTS ?? '/tmp/shots'

function shoot(url: string, name: string): void {
  const run = spawnSync(shell, ['--no-sandbox', '--hide-scrollbars', '--window-size=1400,900', '--timeout=6000', `--screenshot=${join(shots, name)}`, url], { encoding: 'utf8', timeout: 60_000 })
  if (run.status !== 0) throw new Error(`screenshot ${name}: ${run.stderr}`)
}

test('screenshots of the client', { timeout: 40 * 60_000 }, async (t) => {
  const db = await database()
  const c = await cluster()
  const server = await Server.start({ db, api: c.api, keys: c.keys })
  t.after(async () => {
    await server.stop()
    await c.close()
    await db.drop()
  })
  const ws = randomUUID()
  await server.post('/api/workstreams', { id: ws, owner: randomUUID() })
  shoot(`${server.url}/w/${ws}`, '1-new.png')
  await server.command(ws, 'Create', {}, { pool: 'mock-test' })
  const views = async () => ((await (await fetch(`${server.url}/api/workstreams`)).json()) as { workstreams: Record<string, unknown>[] }).workstreams
  const view = await until('ready', async () => (await views()).find((v) => v.id === ws && v.state === 'ready'))
  const entries = async () => (await (await fetch(`${server.url}/api/workstreams/${ws}/entries`)).json()) as Record<string, unknown>[]
  const answered = async () => (await entries()).filter((e) => e.direction === 'in' && e.correlated_method === 'session/prompt').length
  const write = async (text: string) => server.command(ws, 'Write', { execution: view.execution, session: view.session }, { prompt: [{ type: 'text', text }] })
  await write('Hello agent, please fix the login page.')
  await until('first answer', async () => (await answered()) === 1)
  await write('/tool')
  await until('second answer', async () => (await answered()) === 2)
  await write('/permission')
  await until('a permission', async () => (await entries()).some((e) => e.method === 'session/request_permission'))
  shoot(`${server.url}/w/${ws}`, '2-thread.png')
  shoot(`${server.url}/`, '3-home.png')
  // HOLD=<seconds>: keep the server up to look at it by hand.
  if (process.env.HOLD) {
    console.log(`HOLDING ${server.url}/w/${ws}`)
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.HOLD) * 1000))
  }
})
