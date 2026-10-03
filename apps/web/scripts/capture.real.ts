// Captures a real harness's history for the client's tests (test/fixtures/<harness>.json): a
// tool-heavy task played on a deployed server with TEST_ROUTES, every permission answered with its
// first "allow" option, then the execution stopped; the entries read back through the test route.
//   node apps/web/scripts/capture.real.ts http://<server>:8080 <pool> <harness>
// A real harness spends its subscription: a few cents, or a few messages of a plan.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { fold, type Entry } from '@agora/log'

const [base, pool, harness] = process.argv.slice(2)
if (!base || !pool || !harness) throw new Error('usage: capture.real.ts <server> <pool> <harness>')
const PROMPTS = [
  'Plan the work with your todo list first. Then: create fizzbuzz.js exporting fizzbuzz(n), which returns the FizzBuzz strings from 1 to n, and fizzbuzz.test.js using node:test and node:assert. Run the tests with `node --test`. Then rename the function to fizzBuzz in both files and run the tests again. Keep your messages short.',
  'Summarise in two sentences what you changed, with a short markdown list of the files.',
]

type Json = Record<string, any>
const id = randomUUID()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function api(method: string, path: string, body?: unknown): Promise<Json> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, ...(text === '' ? {} : JSON.parse(text)) }
}
const entries = async (): Promise<Entry[]> => (await (await fetch(`${base}/api/workstreams/${id}/entries`)).json()) as Entry[]
const command = (kind: string, target: Json = {}, body: Json = {}) => api('POST', `/api/workstreams/${id}/commands`, { id: randomUUID(), kind, target, body })

await api('POST', '/api/workstreams', { id, owner: randomUUID() })
const created = await command('Create', {}, { pool })
if (created.status !== 200) throw new Error(`Create refused: ${JSON.stringify(created)}`)
const execution = String(created.execution)
let session = ''
for (let i = 0; i < 480 && session === ''; i++) {
  const e = fold(await entries()).current
  if (e?.id === execution && e.session && e.connection) session = e.session
  else await sleep(250)
}
if (session === '') throw new Error('no Session after 2 minutes')
const answered = new Set<string>()
for (const text of PROMPTS) {
  await command('Write', { execution, session }, { prompt: [{ type: 'text', text }] })
  const started = Date.now()
  for (;;) {
    const state = fold(await entries())
    for (const [key, p] of state.permissions) {
      if (answered.has(key)) continue
      answered.add(key)
      const options = ((p.content.params as Json)?.options ?? []) as Json[]
      const allow = options.find((o) => String(o.kind) === 'allow_once') ?? options.find((o) => String(o.kind).startsWith('allow')) ?? options[0]
      await command('RespondPermission', { execution: p.execution, session: p.session, requestPosition: p.position }, { requestId: p.rpc_id, outcome: { outcome: 'selected', optionId: allow?.optionId } })
    }
    const latest = [...state.turns.values()].at(-1)
    if (latest && ['done', 'failed', 'cancelled'].includes(latest.status)) break
    if (Date.now() - started > 600_000) throw new Error('the turn ran for 10 minutes')
    await sleep(1000)
  }
}
await command('Stop', { execution })
const all = await entries()
await writeFile(new URL(`../test/fixtures/${harness}.json`, import.meta.url), JSON.stringify({ harness, workstream: id, entries: all }))
console.log(`${harness}: ${String(all.length)} entries, Workstream ${id}`)
