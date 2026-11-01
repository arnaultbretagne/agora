// The lists' bench (docs/specs/log.md, "The list", "Sub-streams"): a database, a projector folding views from
// command entries, the log's HTTP routes on their own server, and readers of a list's events and pages.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { decode, encode, fromFold, logHttp, LogStore, object, Projections, type Entry, type ProjectedObject, type ThreadRow, type Workstreams } from '../src/index.ts'
import { database, type Db } from './support.ts'

export const EMAIL = 'person@example.org'

/** A view folded from `command` entries carrying its fields: `changedAt` moves only when a field changes, as the core view's does. */
export const views = fromFold('list-test', '1', (entries: readonly Entry[]): ProjectedObject[] => {
  if (!entries.length) return []
  let fields: Record<string, unknown> = {},
    changedAt = ''
  for (const e of entries) {
    const next = { ...fields, ...(e.content as Record<string, unknown>) }
    if (encode(next) !== encode(fields)) {
      fields = next
      changedAt = e.time
    }
  }
  return [
    {
      kind: 'workstream',
      id: entries[0]!.workstream,
      object: { title: 'New workstream', state: 'ready', harness: 'mock', question: null, usage: null, ...fields, changedAt },
      first_position: entries[0]!.position,
      last_position: entries.at(-1)!.position,
    },
  ]
})

export interface Bench {
  readonly db: Db
  readonly projections: Projections
  readonly url: string
  /** A Workstream of `owner` — of its parent's, with one —, its first entry written and projected. */
  workstream(owner: string, fields: Record<string, unknown>, parent?: string): Promise<string>
  /** An entry written, a second after the one before; projected unless `project` is false. */
  write(ws: string, fields: Record<string, unknown>, project?: boolean): Promise<void>
}

/** A database, the projector above, and the log's HTTP routes on their own server: no agent needed. */
export async function bench(t: { after(fn: () => Promise<void>): void }): Promise<Bench> {
  const db = await database()
  const store = new LogStore(db.urls)
  const projections = new Projections(store, [views])
  const server = createServer((req, res) => {
    void logHttp({ options: { store }, projections } as unknown as Workstreams, req, res, { testRoutes: false }).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await store.close()
    await db.drop()
  })
  let clock = Date.parse('2026-11-01T08:00:00.000Z')
  const positions = new Map<string, number>()
  const bench: Bench = {
    db,
    projections,
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    async workstream(owner, fields, parent) {
      const ws = randomUUID()
      await store.create(ws, owner, parent ?? null)
      await bench.write(ws, fields)
      return ws
    },
    async write(ws, fields, project = true) {
      const position = (positions.get(ws) ?? 0) + 1
      positions.set(ws, position)
      clock += 1000
      await db.admin.query("INSERT INTO entries(workstream,position,time,kind,content) VALUES($1,$2,$3,'command',$4::jsonb)", [
        ws,
        position,
        new Date(clock).toISOString(),
        encode(fields),
      ])
      await db.admin.query('UPDATE workstreams SET last_position=$2 WHERE id=$1', [ws, position])
      if (project) await projections.run(ws, views)
    },
  }
  return bench
}

export interface ListRead {
  status: number
  body: Record<string, unknown>
  snapshot: ThreadRow[]
  end: string | null
  live: ThreadRow[]
}

/**
 * Reads a list's events: the snapshot to `snapshot-end`, then `during` once, then live rows while
 * `more` asks for them.
 */
export async function readList(
  url: string,
  query: string,
  options: { email?: string; during?: () => Promise<void>; more?: (live: readonly ThreadRow[]) => boolean } = {},
): Promise<ListRead> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 15_000)
  try {
    const response = await fetch(`${url}/api/workstreams/list?${query}`, {
      signal: abort.signal,
      headers: options.email ? { 'x-forwarded-email': options.email } : {},
    })
    if (!response.headers.get('content-type')?.startsWith('text/event-stream'))
      return { status: response.status, body: object(decode(await response.text())) ?? {}, snapshot: [], end: null, live: [] }
    const read: ListRead = { status: response.status, body: {}, snapshot: [], end: null, live: [] }
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return read
      buffer += decoder.decode(value, { stream: true })
      for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
        const { type, ...row } = object(decode(buffer.slice(0, at).replace(/^data: /, ''))) ?? {}
        buffer = buffer.slice(at + 2)
        if (type === 'snapshot') read.snapshot.push(row as unknown as ThreadRow)
        else if (type === 'live') read.live.push(row as unknown as ThreadRow)
        else if (type === 'snapshot-end') {
          read.end = String(row.position)
          await options.during?.()
        }
        if (read.end !== null && !(options.more?.(read.live) ?? false)) {
          abort.abort()
          return read
        }
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

export const page = async (url: string, query: string) => {
  const response = await fetch(`${url}/api/workstreams/page?${query}`)
  return {
    status: response.status,
    body: (object(decode(await response.text())) ?? {}) as { rows?: { id: string; title: string; changedAt: string }[]; next?: string | null; reason?: string },
  }
}
export const titles = (rows: readonly ThreadRow[]) => rows.map((r) => (r.object as { title: string }).title)
