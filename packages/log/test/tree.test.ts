// docs/specs/log.md, "Sub-streams": a Workstream started from another records its line at creation, its row
// lives in its parent's list, and what happens under a Workstream comes up its line.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { decode, identity, object } from '../src/index.ts'
import { bench, EMAIL, page, readList, views } from './lists.ts'

const OWNER = identity('owner', EMAIL)

/** A POST of a Workstream through the proxy as `email`, with the body given. */
const create = async (url: string, email: string, body: Record<string, unknown>) => {
  const response = await fetch(`${url}/api/workstreams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-email': email },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: object(decode(await response.text())) ?? {} }
}
const lineOf = async (b: Awaited<ReturnType<typeof bench>>, id: string) =>
  (await b.db.admin.query('SELECT owner, parent, coalesce(root,id) AS root, depth FROM workstreams WHERE id=$1', [id])).rows[0] as
    | { owner: string; parent: string | null; root: string; depth: number }
    | undefined
const rowOf = async (b: Awaited<ReturnType<typeof bench>>, id: string) =>
  (await b.db.admin.query('SELECT owner AS list, position::text, row FROM listings WHERE workstream=$1', [id])).rows[0] as
    | { list: string; position: string; row: { below: { count: number; live: number; waiting: number }; changedAt: string; parent: string | null; depth: number } }
    | undefined

test('L86 a sub-stream, then one under it: the root\'s, depths 1 and 2, owned by the root\'s owner whatever the body says', async (t) => {
  const b = await bench(t)
  const root = randomUUID(),
    first = randomUUID(),
    second = randomUUID()
  assert.equal((await create(b.url, EMAIL, { id: root })).status, 200)
  assert.equal((await create(b.url, EMAIL, { id: first, parent: root, owner: randomUUID() })).status, 200)
  assert.equal((await create(b.url, EMAIL, { id: second, parent: first, owner: randomUUID() })).status, 200)
  assert.deepEqual(await lineOf(b, root), { owner: OWNER, parent: null, root, depth: 0 })
  assert.deepEqual(await lineOf(b, first), { owner: OWNER, parent: root, root, depth: 1 })
  assert.deepEqual(await lineOf(b, second), { owner: OWNER, parent: first, root, depth: 2 })
  // Sent again as it was: the same Workstream.
  assert.equal((await create(b.url, EMAIL, { id: second, parent: first })).status, 200)
  // Without the proxy, as a flow creates: the parent's owner, whatever the body says.
  const flows = randomUUID()
  const plain = await fetch(`${b.url}/api/workstreams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: flows, parent: second, owner: randomUUID() }) })
  assert.equal(plain.status, 200)
  assert.deepEqual(await lineOf(b, flows), { owner: OWNER, parent: second, root, depth: 3 })
})

test('L87 a parent that does not exist, one of another owner, the same id with another parent: refused, nothing written', async (t) => {
  const b = await bench(t)
  const theirs = randomUUID(),
    mine = randomUUID(),
    child = randomUUID()
  assert.equal((await create(b.url, 'someone@example.org', { id: theirs })).status, 200)
  assert.equal((await create(b.url, EMAIL, { id: mine })).status, 200)
  assert.equal((await create(b.url, EMAIL, { id: child, parent: mine })).status, 200)
  const count = async () => Number((await b.db.admin.query('SELECT count(*) AS n FROM workstreams')).rows[0].n)
  const before = await count()
  assert.deepEqual(await create(b.url, EMAIL, { id: randomUUID(), parent: randomUUID() }).then((r) => [r.status, r.body.reason]), [404, 'unknown_parent'])
  assert.deepEqual(await create(b.url, EMAIL, { id: randomUUID(), parent: theirs }).then((r) => [r.status, r.body.reason]), [404, 'unknown_parent'])
  assert.deepEqual(await create(b.url, EMAIL, { id: child, parent: randomUUID() }).then((r) => [r.status, r.body.reason]), [404, "unknown_parent"])
  const other = randomUUID()
  assert.equal((await create(b.url, EMAIL, { id: other, parent: mine })).status, 200)
  assert.deepEqual(await create(b.url, EMAIL, { id: child, parent: other }).then((r) => [r.status, r.body.reason]), [409, 'workstream_conflict'])
  assert.deepEqual(await create(b.url, EMAIL, { id: child }).then((r) => [r.status, r.body.reason]), [409, 'workstream_conflict'])
  assert.equal(await count(), before + 1)
})

test('L88 a root with two sub-streams and one under the first: each list holds its own rows, with its own positions', async (t) => {
  const b = await bench(t)
  const root = await b.workstream(OWNER, { title: 'Root' })
  const first = await b.workstream(OWNER, { title: 'First' }, root)
  const second = await b.workstream(OWNER, { title: 'Second' }, root)
  const under = await b.workstream(OWNER, { title: 'Under the first' }, first)
  const ids = async (query: string) => (await readList(b.url, query)).snapshot.map((r) => [r.id, r.position])
  assert.deepEqual((await ids(`after=0&owner=${OWNER}`)).map(([id]) => id), [root])
  // The first after the second: what changed under it since — its own sub-stream — counts as its change.
  assert.deepEqual(await ids(`after=0&parent=${root}`), [
    [first, '3'],
    [second, '2'],
  ])
  assert.deepEqual(await ids(`after=0&parent=${first}`), [[under, '1']])
  // The root counts all three; the first, its one.
  assert.deepEqual((await rowOf(b, root))!.row.below, { count: 3, live: 3, waiting: 0 })
  assert.deepEqual((await rowOf(b, first))!.row.below, { count: 1, live: 1, waiting: 0 })
})

test('L89 a question two levels down, then its answer: the parent\'s and the root\'s rows written again each time', async (t) => {
  const b = await bench(t)
  const root = await b.workstream(OWNER, { title: 'Root' })
  const first = await b.workstream(OWNER, { title: 'First' }, root)
  const under = await b.workstream(OWNER, { title: 'Under' }, first)
  const before = { first: (await rowOf(b, first))!, root: (await rowOf(b, root))! }
  await b.write(under, { question: '7' })
  const asked = { under: (await rowOf(b, under))!, first: (await rowOf(b, first))!, root: (await rowOf(b, root))! }
  assert.deepEqual([asked.first.row.below.waiting, asked.root.row.below.waiting], [1, 1])
  assert.deepEqual([asked.first.row.changedAt, asked.root.row.changedAt], [asked.under.row.changedAt, asked.under.row.changedAt])
  assert.ok(BigInt(asked.first.position) > BigInt(before.first.position) && BigInt(asked.root.position) > BigInt(before.root.position))
  await b.write(under, { question: null })
  const answered = { under: (await rowOf(b, under))!, first: (await rowOf(b, first))!, root: (await rowOf(b, root))! }
  assert.deepEqual([answered.first.row.below.waiting, answered.root.row.below.waiting], [0, 0])
  assert.equal(answered.root.row.changedAt, answered.under.row.changedAt)
  assert.ok(BigInt(answered.root.position) > BigInt(asked.root.position))
  // The root in its owner's list, the most recently changed first.
  const other = await b.workstream(OWNER, { title: 'Another root' })
  await b.write(under, { title: 'Under, renamed' })
  assert.deepEqual((await readList(b.url, `after=0&owner=${OWNER}`)).snapshot.map((r) => r.id), [root, other])
})

test('L90 two sub-streams of one parent projected at the same time: the parent\'s row counts both', async (t) => {
  const b = await bench(t)
  const root = await b.workstream(OWNER, { title: 'Root', state: 'ended' })
  const first = await b.workstream(OWNER, { title: 'First', state: 'ended' }, root)
  const second = await b.workstream(OWNER, { title: 'Second', state: 'ended' }, root)
  assert.deepEqual((await rowOf(b, root))!.row.below, { count: 2, live: 0, waiting: 0 })
  await b.write(first, { state: 'starting', question: '3' }, false)
  await b.write(second, { state: 'starting' }, false)
  await Promise.all([b.projections.run(first, views), b.projections.run(second, views)])
  assert.deepEqual((await rowOf(b, root))!.row.below, { count: 2, live: 2, waiting: 1 })
})

test('L91 Agora started on a log whose sub-streams have no row: each in its parent\'s list, each ancestor counting it', async (t) => {
  const b = await bench(t)
  const root = await b.workstream(OWNER, { title: 'Root' })
  const first = await b.workstream(OWNER, { title: 'First' }, root)
  const under = await b.workstream(OWNER, { title: 'Under', question: '2' }, first)
  // As the rows a team's members had in another list: gone; the root's counting nothing.
  await b.db.admin.query('DELETE FROM listings WHERE workstream = ANY($1::uuid[])', [[first, under]])
  await b.db.admin.query(`UPDATE listings SET row = jsonb_set(row, '{below}', '{"count":0,"live":0,"waiting":0}') WHERE workstream=$1`, [root])
  assert.equal(await b.projections.backfill(), 2)
  assert.deepEqual([(await rowOf(b, first))!.list, (await rowOf(b, under))!.list], [root, first])
  assert.deepEqual((await rowOf(b, root))!.row.below, { count: 2, live: 2, waiting: 1 })
  assert.equal(await b.projections.backfill(), 0)
})

test('L92 a Workstream six levels down: created, at depth 6', async (t) => {
  const b = await bench(t)
  let parent = await b.workstream(OWNER, { title: 'Level 0' })
  for (let depth = 1; depth <= 6; depth++) parent = await b.workstream(OWNER, { title: `Level ${String(depth)}` }, parent)
  assert.equal((await lineOf(b, parent))!.depth, 6)
  assert.equal((await rowOf(b, parent))!.row.depth, 6)
})

test('L93 a row read by its id: a sub-stream\'s with its line; none before a first entry, none for another person', async (t) => {
  const b = await bench(t)
  const root = await b.workstream(OWNER, { title: 'Root' })
  const first = await b.workstream(OWNER, { title: 'First' }, root)
  const under = await b.workstream(OWNER, { title: 'Under' }, first)
  const read = async (id: string, email = EMAIL) => {
    const response = await fetch(`${b.url}/api/workstreams/${id}/row`, { headers: { 'x-forwarded-email': email } })
    return { status: response.status, body: object(decode(await response.text())) ?? {} }
  }
  const row = await read(under)
  assert.deepEqual([row.status, row.body.parent, String(row.body.depth), row.body.title], [200, first, '2', 'Under'])
  const empty = randomUUID()
  assert.equal((await create(b.url, EMAIL, { id: empty, parent: root })).status, 200)
  assert.deepEqual(await read(empty).then((r) => [r.status, r.body.reason]), [404, 'unknown_workstream'])
  assert.deepEqual(await read(under, 'someone@example.org').then((r) => [r.status, r.body.reason]), [404, 'unknown_workstream'])
})

test('L94 a title search on the owner\'s list finds a sub-stream two levels down, with its parent', async (t) => {
  const b = await bench(t)
  const root = await b.workstream(OWNER, { title: 'Root' })
  const first = await b.workstream(OWNER, { title: 'First' }, root)
  const under = await b.workstream(OWNER, { title: 'The gateway changelog' }, first)
  const found = await page(b.url, `owner=${OWNER}&title=GATEWAY`)
  assert.deepEqual(found.body.rows?.map((r) => [r.id, (r as unknown as { parent: string }).parent]), [[under, first]])
  // Without a text, the owner's list alone: the root.
  assert.deepEqual((await page(b.url, `owner=${OWNER}`)).body.rows?.map((r) => r.id), [root])
})
