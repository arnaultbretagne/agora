// docs/specs/search.md: a person's Workstreams searched as grep -n searches files, and one read as an agent's
// Read reads a file, over transcripts PostgreSQL computes from the views' objects.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { core, encode } from '../src/index.ts'
import { bench } from './lists.ts'
import { craft } from './transcripts.ts'
import { opened, until } from './support.ts'

type Line = { number: number; kind: string; text: string }
type Read = { lines: Line[]; total: number; next: number | null }

const get = async (url: string, path: string) => {
  const response = await fetch(`${url}${path}`)
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> }
}
const readOf = async (url: string, ws: string, query = '') => (await get(url, `/api/workstreams/${ws}/read${query}`)).body as unknown as Read
const searchOf = async (url: string, owner: string, query: string) => get(url, `/api/search?owner=${owner}&${query}`)
/** An exchange's header without its time, which a test does not choose. */
const shown = (lines: readonly Line[]) => lines.map((l) => [l.number, l.kind, l.text.replace(/ · \d{4}-\d\d-\d\d \d\d:\d\d/, '')])
const raw = (lines: readonly unknown[]) => Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n')).toString('base64')
const update = (session: string, value: Record<string, unknown>) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: value } })
const ownerOf = async (db: { admin: { query: (q: string, v: unknown[]) => Promise<{ rows: { owner: string }[] }> } }, ws: string) =>
  (await db.admin.query('SELECT owner FROM workstreams WHERE id=$1', [ws])).rows[0]!.owner

test('S1 two exchanges, a tool that succeeds and one that fails: headers, the user\'s lines, the agent\'s, the tools, numbered in order', async (t) => {
  const { lab, ws, e } = await opened(t)
  assert.ok((await lab.write(ws, 'hello there')).accepted)
  await lab.turn(ws, 'done')
  const tools = raw([
    update(e.acpId!, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit demo.txt', kind: 'edit', status: 'completed' }),
    update(e.acpId!, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Run tests', kind: 'execute', status: 'failed' }),
    update(e.acpId!, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Tools ran.\nOne failed.' } }),
  ])
  assert.ok((await lab.write(ws, `/raw ${tools}`)).accepted)
  await lab.turn(ws, 'done')
  const read = await until('both exchanges', async () => {
    const r = await readOf(lab.url, ws)
    return r.lines.at(-1)?.text === 'One failed.' ? r : null
  })
  assert.deepEqual(shown(read.lines), [
    [1, 'header', '## 1 · you'],
    [2, 'user', 'hello there'],
    [3, 'header', '## 1 · agent'],
    [4, 'agent', 'Echo #1: hello there.'],
    [5, 'header', '## 2 · you'],
    [6, 'user', `/raw ${tools}`],
    [7, 'header', '## 2 · agent'],
    [8, 'tool', '[tool: Edit demo.txt]'],
    [9, 'tool', '[tool: Run tests — failed]'],
    [10, 'agent', 'Tools ran.'],
    [11, 'agent', 'One failed.'],
  ])
  assert.deepEqual([read.total, read.next], [11, null])
  assert.match(read.lines[0]!.text, /^## 1 · \d{4}-\d\d-\d\d \d\d:\d\d · you$/)
})

test('S2 a third exchange, then a rebuild: the first two exchanges\' lines at the same numbers, with the same text', async (t) => {
  const { lab, ws } = await opened(t)
  for (const text of ['first', 'second']) {
    assert.ok((await lab.write(ws, text)).accepted)
    await lab.turn(ws, 'done')
  }
  const before = await until('two exchanges', async () => {
    const r = await readOf(lab.url, ws)
    return r.total === 8 ? r : null
  })
  assert.ok((await lab.write(ws, 'third')).accepted)
  await lab.turn(ws, 'done')
  const after = await until('three exchanges', async () => {
    const r = await readOf(lab.url, ws)
    return r.total === 12 ? r : null
  })
  assert.deepEqual(after.lines.slice(0, 8), before.lines)
  await lab.workstreams.projections.run(ws, core, true)
  assert.deepEqual((await readOf(lab.url, ws)).lines, after.lines)
})

test('S3 an exchange in progress: its last lines grow, no line before them moves', async (t) => {
  const { lab, ws } = await opened(t)
  assert.ok((await lab.write(ws, 'a first message')).accepted)
  await lab.turn(ws, 'done')
  assert.ok((await lab.write(ws, '/sleep 3')).accepted)
  const early = await until('the answer begun', async () => {
    const r = await readOf(lab.url, ws)
    return r.lines.at(-1)?.text === '… second 1/3' ? r : null
  })
  const later = await until('the answer grown', async () => {
    const r = await readOf(lab.url, ws)
    return r.lines.at(-1)?.text === '… second 2/3' ? r : null
  }, 10_000)
  assert.ok(later.total > early.total)
  assert.deepEqual(later.lines.slice(0, early.lines.length), early.lines)
  await lab.turn(ws, 'done')
})

test('S4 a text in a user\'s line, an agent\'s and a tool\'s title: two lines without `tools`, three with; never a header', async (t) => {
  const { db, lab, ws, e } = await opened(t)
  const owner = await ownerOf(db, ws)
  assert.ok((await lab.write(ws, 'find the zebra')).accepted)
  await lab.turn(ws, 'done')
  assert.ok((await lab.write(ws, `/raw ${raw([update(e.acpId!, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Open zebra.txt', status: 'completed' })])}`)).accepted)
  await lab.turn(ws, 'done')
  const lines = async (extra: string) => {
    const r = await searchOf(lab.url, owner, `pattern=zebra&output_mode=content${extra}`)
    return (r.body.results as { line: number; text: string; match: boolean }[]).filter((l) => l.match).map((l) => l.text)
  }
  await until('the tool projected', async () => (await lines('&tools=true')).length === 3)
  assert.deepEqual(await lines(''), ['find the zebra', 'Echo #1: find the zebra.'])
  assert.deepEqual(await lines('&tools=true'), ['find the zebra', 'Echo #1: find the zebra.', '[tool: Open zebra.txt]'])
  // The headers hold "you" and "agent": never searched.
  assert.deepEqual((await searchOf(lab.url, owner, `pattern=${encodeURIComponent('· (you|agent)$')}&tools=true`)).body.results, [])
})

// ---------------------------------------------------------------- on objects written as the projector writes them

test('S5 the three outputs on two Workstreams: newest first with the latest match; each match with its context; the counts', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  const older = await craft(b.db.admin, owner, [{ user: 'a needle here', agent: ['nothing', 'another needle'] }], { changedAt: '2026-11-01 08:00:00+00', title: 'Older' })
  const newer = await craft(b.db.admin, owner, [{ user: 'plain', agent: ['the needle'] }], { changedAt: '2026-11-02 08:00:00+00', title: 'Newer' })
  const found = (await searchOf(b.url, owner, 'pattern=needle')).body.results as { workstream: string; row: { title: string }; count: number; line: number; text: string }[]
  assert.deepEqual(
    found.map((r) => [r.workstream, r.row.title, r.count, r.line, r.text]),
    [
      [newer, 'Newer', 1, 4, 'the needle'],
      [older, 'Older', 2, 5, 'another needle'],
    ],
  )
  const content = (await searchOf(b.url, owner, 'pattern=needle&output_mode=content&context=1')).body.results as { workstream: string; line: number; match: boolean; text: string }[]
  assert.deepEqual(
    content.map((r) => [r.workstream === newer ? 'newer' : 'older', r.line, r.match, r.text]),
    [
      ['newer', 3, false, '## 1 · agent'],
      ['newer', 4, true, 'the needle'],
      ['older', 1, false, '## 1 · 2026-11-02 09:00 · you'],
      ['older', 2, true, 'a needle here'],
      ['older', 3, false, '## 1 · agent'],
      ['older', 4, false, 'nothing'],
      ['older', 5, true, 'another needle'],
    ],
  )
  const counts = (await searchOf(b.url, owner, 'pattern=needle&output_mode=count')).body.results as { workstream: string; title: string; count: number }[]
  assert.deepEqual(
    counts.map((r) => [r.title, r.count]),
    [
      ['Newer', 1],
      ['Older', 2],
    ],
  )
})

test('S6 `\\bkube\\b`, with and without -i; a pattern that does not compile', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  await craft(b.db.admin, owner, [{ user: 'the Kube cluster\na kube node\nkubernetes only' }], { changedAt: '2026-11-02 08:00:00+00' })
  const count = async (extra: string) =>
    ((await searchOf(b.url, owner, `pattern=${encodeURIComponent('\\bkube\\b')}&output_mode=count${extra}`)).body.results as { count: number }[])[0]?.count
  assert.equal(await count(''), 1)
  assert.equal(await count('&ignore_case=true'), 2)
  assert.deepEqual(await searchOf(b.url, owner, 'pattern=(').then((r) => [r.status, r.body.reason]), [400, 'invalid_pattern'])
})

test('S7 another person\'s Workstream never found; one of the caller\'s sub-streams found; `workstream` limits to one', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  const root = await craft(b.db.admin, owner, [{ user: 'the root', agent: ['a needle in the root'] }], { changedAt: '2026-11-02 08:00:00+00' })
  const sub = await craft(b.db.admin, owner, [{ user: 'a needle in the sub-stream' }], { changedAt: '2026-11-02 09:00:00+00', parent: root })
  await craft(b.db.admin, randomUUID(), [{ user: 'a needle of someone else' }], { changedAt: '2026-11-02 10:00:00+00' })
  const ids = async (extra: string) => ((await searchOf(b.url, owner, `pattern=needle${extra}`)).body.results as { workstream: string }[]).map((r) => r.workstream)
  assert.deepEqual(await ids(''), [sub, root])
  assert.deepEqual(await ids(`&workstream=${root}`), [root])
})

test('S8 30 Workstreams matching: 20 and the next offset, then 10 and none', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  for (let i = 0; i < 30; i++) await craft(b.db.admin, owner, [{ user: `needle ${String(i)}` }], { changedAt: `2026-11-02 08:${String(i).padStart(2, '0')}:00+00` })
  const first = (await searchOf(b.url, owner, 'pattern=needle')).body
  assert.deepEqual([(first.results as unknown[]).length, first.next], [20, 20])
  const rest = (await searchOf(b.url, owner, 'pattern=needle&offset=20')).body
  assert.deepEqual([(rest.results as unknown[]).length, rest.next], [10, null])
})

test('S9 read windows: from an offset with a limit, beyond the end, cut at 50 KB, a line of 3,000 characters cut', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  const long = 'y'.repeat(3000)
  const many = Array.from({ length: 700 }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(95)}`).join('\n')
  const ws = await craft(b.db.admin, owner, [{ user: `${long}\nshort`, agent: [many] }])
  const total = 704
  const window = await readOf(b.url, ws, '?offset=3&limit=2')
  assert.deepEqual([window.lines.map((l) => l.number), window.total, window.next], [[3, 4], total, 5])
  assert.deepEqual(await readOf(b.url, ws, `?offset=${String(total + 5)}`), { lines: [], total, next: null })
  const whole = await readOf(b.url, ws)
  const bytes = whole.lines.reduce((n, l) => n + Buffer.byteLength(l.text) + 1, 0)
  assert.ok(bytes <= 50 * 1024 && whole.next !== null && whole.next === whole.lines.at(-1)!.number + 1)
  assert.equal(whole.lines[1]!.text, `${'y'.repeat(2000)}… (line cut to 2000 characters)`)
})

test('S10 replayed history outside any turn, reasoning, a question to the person: in no line', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  const ws = await craft(b.db.admin, owner, [{ user: 'hello', agent: [{ replay: 'replayed words' }, { thought: 'secret reasoning' }, 'the answer', { question: 'Approve?' }] }])
  const read = await readOf(b.url, ws)
  assert.deepEqual(
    read.lines.map((l) => l.text),
    ['## 1 · 2026-11-02 09:00 · you', 'hello', '## 1 · agent', 'the answer'],
  )
})

test('S11 a pattern opening with its own options, then a literal: as PostgreSQL reads them, line by line still', async (t) => {
  const b = await bench(t)
  const owner = randomUUID()
  await craft(b.db.admin, owner, [{ user: 'the Kube cluster\na kube node\nk.be written as such' }], { changedAt: '2026-11-02 08:00:00+00' })
  const count = async (pattern: string) => {
    const { status, body } = await searchOf(b.url, owner, `pattern=${encodeURIComponent(pattern)}&output_mode=count`)
    assert.equal(status, 200, pattern)
    return (body.results as { count: number }[])[0]?.count ?? 0
  }
  // Case matched, the control: one line.
  assert.equal(await count('kube'), 1)
  // Its own options: case ignored, as -i; `^` still at each line's start, not the text's alone.
  assert.equal(await count('(?i)KUBE'), 2)
  assert.equal(await count('(?i)^A KUBE'), 1)
  // A literal: `.` as written, never any character.
  assert.equal(await count('***=k.be'), 1)
})
