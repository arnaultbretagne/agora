// docs/specs/log.md, "HTTP": the caller's account, and its agents' folder — the real server
// (apps/server/src/main.ts), the proxy's identity sent as its header.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { folderOwner, identity } from '../src/index.ts'
import { cluster, database, Server, until, type Db } from './support.ts'

const PERSON = 'person@example.org'
const SOMEONE = 'someone@example.org'
let db: Db
let c: Awaited<ReturnType<typeof cluster>>
let server: Server

before(async () => {
  db = await database()
  c = await cluster()
  server = await Server.start({ db, api: c.api, keys: c.keys })
})

after(async () => {
  await server?.stop()
  await c?.close()
  await db?.drop()
})

const get = async (path: string, email: string | null) => {
  const response = await fetch(`${server.url}${path}`, { headers: email ? { 'x-forwarded-email': email } : {} })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}
const ids = (body: Record<string, unknown>) => (body.workstreams as { id: string }[]).map((w) => w.id).sort()

test('L75 the account: the identity the proxy passes; none without it', async () => {
  assert.deepEqual(await get('/api/account', PERSON), { status: 200, body: { email: PERSON } })
  assert.deepEqual(await get('/api/account', null), { status: 200, body: { email: null } })
})

test('L76 the agents\' folder: the caller\'s own, out of its list, nobody else\'s; an unknown folder refused', async () => {
  // The person's Workstream, their folder's, someone else's folder's; each with a question, so that it is listed.
  const ask = { title: 'Listed', text: '', options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { optionId: 'b', name: 'B', kind: 'reject_once' }] }
  const owners = { own: identity('owner', PERSON), folder: folderOwner('agents', PERSON), other: folderOwner('agents', SOMEONE) }
  const made: Record<string, string> = {}
  for (const [name, owner] of Object.entries(owners)) {
    const id = randomUUID()
    assert.equal((await server.post('/api/workstreams', { id, owner })).status, 200)
    assert.equal((await server.command(id, 'Ask', {}, ask)).status, 200)
    made[name] = id
  }
  // The views are projected after the commands: waited for in the list without the proxy, which shows all.
  await until('the three listed', async () => ids((await get('/api/workstreams', null)).body).length >= 3)
  assert.deepEqual(ids((await get('/api/workstreams', PERSON)).body), [made.own])
  assert.deepEqual(ids((await get('/api/workstreams?folder=agents', PERSON)).body), [made.folder])
  assert.deepEqual(ids((await get('/api/workstreams?folder=agents', SOMEONE)).body), [made.other])
  assert.deepEqual(await get('/api/workstreams?folder=archive', PERSON), { status: 400, body: { reason: 'unknown_folder' } })
  // Without the proxy, every Workstream, as every list is.
  const all = ids((await get('/api/workstreams?folder=agents', null)).body)
  assert.ok(Object.values(made).every((id) => all.includes(id)))
})
