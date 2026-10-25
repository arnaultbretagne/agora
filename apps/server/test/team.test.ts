// docs/specs/flows.md, "Launching from Agora": the server creates the lead's Workstream and asks Prefect
// for the run — here a stand-in Prefect that keeps what it was asked and honours idempotency keys. The
// server is the real one (apps/server/src/main.ts), on its own database. Run from the log package:
// `npm test -w @agora/server`.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { folderOwner, identity } from '../../../packages/log/src/index.ts'
import { cluster, database, Server, type Db } from '../../../packages/log/test/support.ts'

interface Asked {
  readonly parameters: Record<string, unknown>
  readonly idempotency_key: string
}

/** A stand-in for Prefect's API: one deployment, `lead/main`; runs by idempotency key. */
class FakePrefect {
  readonly asked: Asked[] = []
  readonly runs = new Map<string, string>()
  private server: HttpServer | null = null
  url = ''

  async listen(): Promise<this> {
    this.server = createServer((req, res) => {
      const reply = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (req.method === 'GET' && req.url === '/api/deployments/name/lead/main') return reply(200, { id: 'deployment-1' })
      if (req.method === 'POST' && req.url === '/api/deployments/deployment-1/create_flow_run') {
        let text = ''
        req.on('data', (chunk: Buffer) => (text += chunk.toString()))
        req.on('end', () => {
          const asked = JSON.parse(text) as Asked
          this.asked.push(asked)
          const run = this.runs.get(asked.idempotency_key) ?? randomUUID()
          this.runs.set(asked.idempotency_key, run)
          reply(201, { id: run, name: 'dashing-lead' })
        })
        return
      }
      reply(404, { detail: 'not found' })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${String((this.server!.address() as AddressInfo).port)}/api`
    return this
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }
}

const PERSON = 'person@example.org'
let db: Db
let c: Awaited<ReturnType<typeof cluster>>
let prefect: FakePrefect
let server: Server

before(async () => {
  db = await database()
  c = await cluster()
  prefect = await new FakePrefect().listen()
  server = await Server.start({
    db,
    api: c.api,
    keys: c.keys,
    env: { TEAM_PREFECT_API: prefect.url, TEAM_DEPLOYMENT: 'lead/main', TEAM_PREFECT_UI: 'https://prefect.example.org' },
  })
})

after(async () => {
  await server?.stop()
  await prefect?.close()
  await c?.close()
  await db?.drop()
})

const launch = (body: Record<string, unknown>, email: string | null = PERSON) =>
  fetch(`${server.url}/api/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(email ? { 'x-forwarded-email': email } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))

test('F22 a team launched from Agora: the lead\'s Workstream the person\'s, the run asked of Prefect once, whatever the retries', async () => {
  assert.deepEqual(await (await fetch(`${server.url}/api/teams`)).json(), { available: true })
  const id = randomUUID()
  const first = await launch({ id, goal: 'Make uploads reliable' })
  assert.equal(first.status, 200)
  assert.equal(first.body.workstream, id)
  assert.equal(first.body.url, `https://prefect.example.org/runs/flow-run/${String(first.body.flowRun)}`)
  assert.equal(prefect.asked.length, 1)
  assert.deepEqual(prefect.asked[0], {
    parameters: { goal: 'Make uploads reliable', lead_workstream: id, owner: identity('owner', PERSON), members_owner: folderOwner('agents', PERSON) },
    idempotency_key: `agora-team-${id}`,
  })
  // The person's Workstream, in their list.
  const mine = (await (await fetch(`${server.url}/api/workstreams`, { headers: { 'x-forwarded-email': PERSON } })).json()) as { workstreams: { id: string }[] }
  assert.ok(mine.workstreams.some((w) => w.id === id))
  // Sent again: the same run.
  const again = await launch({ id, goal: 'Make uploads reliable' })
  assert.deepEqual([again.status, again.body.flowRun], [200, first.body.flowRun])
  assert.equal(new Set(prefect.asked.map((a) => a.idempotency_key)).size, 1)
})

test('F22 a launch refused: no goal, another\'s Workstream, Prefect unreachable', async () => {
  assert.deepEqual(await launch({ id: randomUUID(), goal: '  ' }), { status: 400, body: { reason: 'invalid_goal' } })
  const id = randomUUID()
  assert.equal((await launch({ id, goal: 'Mine' })).status, 200)
  assert.deepEqual(await launch({ id, goal: 'Theirs' }, 'someone@example.org'), { status: 409, body: { reason: 'workstream_conflict' } })
  const asked = prefect.asked.length
  await prefect.close()
  const unreachable = await launch({ id: randomUUID(), goal: 'While Prefect is down' })
  assert.deepEqual(unreachable, { status: 502, body: { reason: 'teams_unreachable' } })
  assert.equal(prefect.asked.length, asked)
  prefect = await new FakePrefect().listen()
})
