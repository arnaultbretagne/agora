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
/** A list's ids through its pages (docs/specs/log.md, "The list"), or the refusal. */
const listed = async (query: string, email: string | null) => {
  const { status, body } = await get(`/api/workstreams/page?${query}`, email)
  return status === 200 ? (body.rows as { id: string }[]).map((w) => w.id).sort() : [status, body.reason]
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

test('L75 the account: the identity the proxy passes; none without it', async () => {
  assert.deepEqual(await get('/api/account', PERSON), { status: 200, body: { email: PERSON } })
  assert.deepEqual(await get('/api/account', null), { status: 200, body: { email: null } })
})

test('L76 the agents\' folder: the caller\'s own, out of its list, nobody else\'s; an unknown folder refused; without the proxy, the owner given', async () => {
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
  // The views are projected after the commands: each list waited for.
  await until('the person\'s own', async () => same(await listed('', PERSON), [made.own]))
  await until('their folder\'s', async () => same(await listed('folder=agents', PERSON), [made.folder]))
  await until('someone else\'s folder\'s', async () => same(await listed('folder=agents', SOMEONE), [made.other]))
  assert.deepEqual(await listed('folder=archive', PERSON), [400, 'unknown_folder'])
  // Without the proxy, the owner given; none, refused.
  assert.deepEqual(await listed(`owner=${owners.folder}`, null), [made.folder])
  assert.deepEqual(await listed('', null), [400, 'invalid_identifier'])
})
