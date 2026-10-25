// docs/specs/log.md, "HTTP": the caller's account, and the list of an account it may switch to — the
// real server (apps/server/src/main.ts) with ACCOUNTS set, the proxy's identity sent as its header.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { identity } from '../src/index.ts'
import { cluster, database, Server, until, type Db } from './support.ts'

const PERSON = 'Person@Example.org'
const AGENTS = 'agents@example.org'
let db: Db
let c: Awaited<ReturnType<typeof cluster>>
let server: Server

before(async () => {
  db = await database()
  c = await cluster()
  server = await Server.start({ db, api: c.api, keys: c.keys, env: { ACCOUNTS: `person@example.org=${AGENTS}` } })
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

test('L75 the account: the identity the proxy passes, then the accounts it may switch to; none without it', async () => {
  assert.deepEqual(await get('/api/account', PERSON), { status: 200, body: { email: 'person@example.org', accounts: ['person@example.org', AGENTS] } })
  assert.deepEqual(await get('/api/account', 'someone@example.org'), { status: 200, body: { email: 'someone@example.org', accounts: ['someone@example.org'] } })
  assert.deepEqual(await get('/api/account', null), { status: 200, body: { email: null, accounts: [] } })
})

test('L76 another account\'s list: shown to whom may switch to it, refused to anyone else; the own list as before', async () => {
  // One Workstream of the person's, one of the agents', one of someone else's; each with a question, so that it is listed.
  const ask = { title: 'Listed', text: '', options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { optionId: 'b', name: 'B', kind: 'reject_once' }] }
  const made: Record<string, string> = {}
  for (const email of ['person@example.org', AGENTS, 'someone@example.org']) {
    const id = randomUUID()
    assert.equal((await server.post('/api/workstreams', { id, owner: identity('owner', email) })).status, 200)
    assert.equal((await server.command(id, 'Ask', {}, ask)).status, 200)
    made[email] = id
  }
  // The views are projected after the commands: waited for in the list without the proxy, which shows all.
  await until('the three listed', async () => ids((await get('/api/workstreams', null)).body).length >= 3)
  // The own list: the owner the identity gives, as written by the proxy.
  assert.deepEqual(ids((await get('/api/workstreams', 'person@example.org')).body), [made['person@example.org']])
  assert.deepEqual(ids((await get(`/api/workstreams?as=${encodeURIComponent(AGENTS)}`, 'person@example.org')).body), [made[AGENTS]])
  assert.deepEqual(ids((await get('/api/workstreams?as=person%40example.org', 'person@example.org')).body), [made['person@example.org']])
  assert.deepEqual(await get(`/api/workstreams?as=${encodeURIComponent(AGENTS)}`, 'someone@example.org'), { status: 403, body: { reason: 'account_not_allowed' } })
  assert.deepEqual(await get('/api/workstreams?as=someone%40example.org', 'person@example.org'), { status: 403, body: { reason: 'account_not_allowed' } })
  // Without the proxy, any account's list, as every list is.
  assert.deepEqual(ids((await get(`/api/workstreams?as=${encodeURIComponent(AGENTS)}`, null)).body), [made[AGENTS]])
})
