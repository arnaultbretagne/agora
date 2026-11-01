// docs/specs/log.md, "The list": each Workstream's light row, written beside its view by the projector,
// read as the thread is — a snapshot, then what follows — and by pages.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { folderOwner, identity } from '../src/index.ts'
import { bench, EMAIL, page, readList, titles, views, type ListRead } from './lists.ts'

test("L78 a row takes the owner's next position at each change of the row, none when a rebuild leaves it as it was", async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  const ws = await b.workstream(owner, { title: 'First' })
  const listing = async () => (await b.db.admin.query('SELECT position::text, row FROM listings WHERE workstream=$1', [ws])).rows[0]
  assert.equal((await listing()).position, '1')
  await b.write(ws, { title: 'Second' })
  assert.equal((await listing()).position, '2')
  await b.write(ws, { state: 'starting' })
  const changed = await listing()
  assert.equal(changed.position, '3')
  assert.deepEqual({ ...changed.row, changedAt: undefined }, { id: ws, parent: null, depth: 0, title: 'Second', state: 'starting', harness: 'mock', question: null, below: { count: 0, live: 0, waiting: 0 }, changedAt: undefined })
  await b.projections.run(ws, views, true)
  assert.equal((await listing()).position, '3')
  assert.equal((await b.db.admin.query('SELECT last_position::text FROM lists WHERE owner=$1', [owner])).rows[0].last_position, '3')
})

test("L79 each owner's list holds its own rows, the agents' folder its own, each with its own positions", async (t) => {
  const b = await bench(t)
  const own = await b.workstream(identity('owner', EMAIL), { title: 'Mine' })
  const folder = await b.workstream(folderOwner('agents', EMAIL), { title: 'My agent' })
  const other = await b.workstream(identity('owner', 'someone@example.org'), { title: 'Theirs' })
  const ids = (read: ListRead) => read.snapshot.map((r) => [r.id, r.position])
  assert.deepEqual(ids(await readList(b.url, 'after=0', { email: EMAIL })), [[own, '1']])
  assert.deepEqual(ids(await readList(b.url, 'after=0&folder=agents', { email: EMAIL })), [[folder, '1']])
  assert.deepEqual(ids(await readList(b.url, 'after=0', { email: 'someone@example.org' })), [[other, '1']])
  assert.deepEqual(await readList(b.url, 'after=0&folder=archive', { email: EMAIL }).then((r) => [r.status, r.body.reason]), [400, 'unknown_folder'])
})

test('L80 a list read from zero gives the 50 most recently changed rows, newest first, then the last position', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  for (let i = 0; i < 60; i++) await b.workstream(owner, { title: `Report ${String(i)}` })
  const read = await readList(b.url, `after=0&owner=${owner}`)
  assert.equal(read.status, 200)
  assert.equal(read.snapshot.length, 50)
  assert.equal(titles(read.snapshot)[0], 'Report 59')
  assert.equal(titles(read.snapshot)[49], 'Report 10')
  assert.equal(read.end, '60')
})

test('L81 a change reaches an open list once, and a list read again from its cursor neither repeats nor misses one', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  const first = await b.workstream(owner, { title: 'One' })
  const second = await b.workstream(owner, { title: 'Two' })
  const read = await readList(b.url, `after=0&owner=${owner}`, {
    during: () => b.write(first, { title: 'One, renamed' }),
    more: (live) => live.length < 1,
  })
  assert.equal(read.end, '2')
  assert.deepEqual(
    read.live.map((r) => [r.id, r.position, (r.object as { title: string }).title]),
    [[first, '3', 'One, renamed']],
  )
  const again = await readList(b.url, `after=3&owner=${owner}`, {
    during: () => b.write(second, { state: 'starting' }),
    more: (live) => live.length < 1,
  })
  assert.deepEqual(again.snapshot, [])
  assert.equal(again.end, '3')
  assert.deepEqual(
    again.live.map((r) => [r.id, r.position]),
    [[second, '4']],
  )
})

test('L82 pages: the 50 most recent, then the rest; a title filter in any case, across every page', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  const named: Record<number, string> = { 2: 'kubernetes route', 30: 'The KUBERNETES profile', 55: 'Kubernetes rights' }
  for (let i = 0; i < 60; i++) await b.workstream(owner, { title: named[i] ?? `Report ${String(i)}` })
  const first = await page(b.url, `owner=${owner}`)
  assert.equal(first.status, 200)
  assert.equal(first.body.rows?.length, 50)
  assert.equal(first.body.rows?.[0]?.title, 'Report 59')
  assert.ok(first.body.next)
  const rest = await page(b.url, `owner=${owner}&before=${encodeURIComponent(first.body.next!)}`)
  assert.equal(rest.body.rows?.length, 10)
  assert.equal(rest.body.rows?.[9]?.title, 'Report 0')
  assert.equal(rest.body.next, null)
  const found = await page(b.url, `owner=${owner}&title=${encodeURIComponent('KuBeRnEtEs')}`)
  assert.deepEqual(
    found.body.rows?.map((r) => r.title),
    ['Kubernetes rights', 'The KUBERNETES profile', 'kubernetes route'],
  )
  assert.equal(found.body.next, null)
  const profile = found.body.rows![1]!
  const older = await page(b.url, `owner=${owner}&title=kubernetes&before=${encodeURIComponent(`${profile.changedAt},${profile.id}`)}`)
  assert.deepEqual(
    older.body.rows?.map((r) => r.title),
    ['kubernetes route'],
  )
})

test('L83 a cursor beyond the last position, a negative one, a malformed page cursor, no owner without the proxy: refused', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  await b.workstream(owner, { title: 'Only one' })
  const refused = async (read: Promise<ListRead>) => read.then((r) => [r.status, r.body.reason])
  assert.deepEqual(await refused(readList(b.url, `after=9&owner=${owner}`)), [400, 'future_cursor'])
  assert.deepEqual(await refused(readList(b.url, `after=-1&owner=${owner}`)), [400, 'invalid_cursor'])
  assert.deepEqual(await page(b.url, `owner=${owner}&before=yesterday`).then((r) => [r.status, r.body.reason]), [400, 'invalid_cursor'])
  assert.deepEqual(await refused(readList(b.url, 'after=0')), [400, 'invalid_identifier'])
})

test('L84 back-filling gives each Workstream with a view and no row its row once; again, none', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  for (const title of ['A', 'B', 'C']) await b.workstream(owner, { title })
  // A log from before the list: views, and no row.
  await b.db.admin.query('DELETE FROM listings')
  assert.equal(await b.projections.backfill(), 3)
  assert.equal((await b.db.admin.query('SELECT count(*)::int AS n FROM listings WHERE owner=$1', [owner])).rows[0].n, 3)
  assert.equal(await b.projections.backfill(), 0)
  const read = await readList(b.url, `after=0&owner=${owner}`)
  assert.deepEqual(titles(read.snapshot), ['C', 'B', 'A'])
})

test('L85 two Workstreams of one owner projected at the same time, the list read live: both rows, distinct positions, in their order', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  const first = await b.workstream(owner, { title: 'First' })
  const second = await b.workstream(owner, { title: 'Second' })
  await b.write(first, { state: 'starting' }, false)
  await b.write(second, { state: 'starting' }, false)
  const read = await readList(b.url, `after=2&owner=${owner}`, {
    during: async () => {
      await Promise.all([b.projections.run(first, views), b.projections.run(second, views)])
    },
    more: (live) => live.length < 2,
  })
  assert.equal(read.end, '2')
  assert.deepEqual(
    read.live.map((r) => r.position),
    ['3', '4'],
  )
  assert.deepEqual(new Set(read.live.map((r) => r.id)), new Set([first, second]))
})
