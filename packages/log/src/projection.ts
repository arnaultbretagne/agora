// Views and the thread (docs/specs/log.md, "Views", "The thread"). A projector keeps its fold in memory
// per Workstream and advances it by the entries after its checkpoint; it writes only what changed,
// each object with the thread position of its change, under the projector's own lock (the `threads`
// row), never the capture lock. A version change rebuilds every projector and publishes a reset with
// the complete state; so does a removal.
import type { PoolClient } from 'pg'
import { type LogStore, readEntries, type Entry } from './store.ts'
import { CoreProjection, type ProjectedObject } from './state.ts'
import { cursor, decode, encode, hash } from './json.ts'

export type ThreadRow = {
  position: string
  operation: 'upsert' | 'reset'
  kind: string | null
  id: string | null
  object: unknown
}
export interface Projection {
  readonly objects: Map<string, ProjectedObject>
  position: string
  apply(entries: readonly Entry[]): Set<string>
}
export interface Projector {
  name: string
  version: string
  create(): Projection
}
export const core: Projector = { name: 'core', version: '8', create: () => new CoreProjection() }

/** What lies under a Workstream, at every depth (docs/specs/log.md, "Sub-streams"). */
export type Below = { count: number; live: number; waiting: number }
/** A Workstream's row in its list (docs/specs/log.md, "The list"): what a list shows of its view and of what lies under it. */
export type ListRow = {
  id: string
  parent: string | null
  depth: number
  title: unknown
  state: unknown
  harness: unknown
  question: unknown
  below: Below
  changedAt: string
}
export const LIST_PAGE = 50
/** The states of a Workstream with an execution: those a folded parent counts as live. */
const LIVE = new Set(['starting', 'ready', 'interrupted'])

function listRow(workstream: string, line: { parent: string | null; depth: number }, view: Record<string, unknown>, children: readonly ListRow[]): ListRow | null {
  // A view with no entry yet has no time to be listed by.
  if (typeof view.changedAt !== 'string') return null
  const below: Below = { count: 0, live: 0, waiting: 0 }
  let changedAt = view.changedAt
  for (const child of children) {
    const under = child.below ?? { count: 0, live: 0, waiting: 0 }
    below.count += 1 + under.count
    below.live += (LIVE.has(String(child.state)) ? 1 : 0) + under.live
    below.waiting += (child.question ? 1 : 0) + under.waiting
    if (Date.parse(child.changedAt) > Date.parse(changedAt)) changedAt = child.changedAt
  }
  return {
    id: workstream,
    parent: line.parent,
    depth: line.depth,
    title: view.title ?? null,
    state: view.state ?? null,
    harness: view.harness ?? null,
    question: view.question ?? null,
    below,
    changedAt,
  }
}

/** A list row as the thread's rows travel: an upsert of a `workstream` object. */
const listed = (r: { workstream: string; position: string; row: string }): ThreadRow => ({
  position: r.position,
  operation: 'upsert',
  kind: 'workstream',
  id: r.workstream,
  object: decode(r.row),
})

/** A page cursor: the last row's `changedAt` and id. */
function pageCursor(text: string): [string, string] {
  const comma = text.lastIndexOf(',')
  const changedAt = text.slice(0, comma),
    id = text.slice(comma + 1)
  if (comma < 1 || Number.isNaN(Date.parse(changedAt)) || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid_cursor')
  return [changedAt, id]
}

/** A projector from a pure fold over all entries: simple, and quadratic; for tests and small views. */
export function fromFold(name: string, version: string, fold: (entries: readonly Entry[]) => ProjectedObject[]): Projector {
  return {
    name,
    version,
    create() {
      const seen: Entry[] = []
      const projection: Projection = {
        objects: new Map(),
        position: '0',
        apply(entries) {
          seen.push(...entries)
          projection.position = seen.at(-1)?.position ?? projection.position
          const next = new Map(fold(seen).map((o) => [o.id, o]))
          const changed = new Set<string>()
          for (const [id, o] of next) {
            const previous = projection.objects.get(id)
            if (previous === undefined || encode(previous) !== encode(o)) changed.add(id)
          }
          for (const id of projection.objects.keys()) if (!next.has(id)) changed.add(id)
          projection.objects.clear()
          for (const [id, o] of next) projection.objects.set(id, o)
          return changed
        },
      }
      return projection
    },
  }
}

export class Projections {
  readonly store: LogStore
  readonly registry: Map<string, Projector>
  private readonly memory = new Map<string, { version: string; projection: Projection }>()
  constructor(store: LogStore, projectors: Projector[] = [core]) {
    this.store = store
    this.registry = new Map(projectors.map((p) => [p.name, p]))
  }
  /** Projects what is new; returns the thread's last position. */
  async run(workstream: string, projector: Projector = core, rebuild = false): Promise<string> {
    this.registry.set(projector.name, projector)
    const client = await this.store.projector.connect()
    let broken = false
    try {
      await client.query('BEGIN')
      await client.query('INSERT INTO threads(workstream) VALUES($1) ON CONFLICT DO NOTHING', [workstream])
      const locked = await client.query('SELECT last_position,reset_position FROM threads WHERE workstream=$1 FOR UPDATE', [workstream])
      let position = BigInt(locked.rows[0].last_position)
      let resetAt = BigInt(locked.rows[0].reset_position)
      // A reset takes the next position, and every object one after it: the complete state, in order.
      const reset = async () => {
        resetAt = ++position
        const renumbered = await client.query(
          'UPDATE objects o SET position=$2::bigint+n.rank FROM (SELECT kind,id,row_number() OVER (ORDER BY kind,id) AS rank FROM objects WHERE workstream=$1) n WHERE o.workstream=$1 AND o.kind=n.kind AND o.id=n.id',
          [workstream, String(resetAt)],
        )
        position += BigInt(renumbered.rowCount ?? 0)
        const views = await client.query("SELECT object::text FROM objects WHERE workstream=$1 AND kind='workstream'", [workstream])
        for (const v of views.rows) await this.list(client, workstream, decode(v.object))
      }
      const checkpoints = new Map<string, { version: string; position: string }>(
        (
          await client.query('SELECT projector,version,position FROM checkpoints WHERE workstream=$1', [workstream])
        ).rows.map((r) => [r.projector as string, { version: r.version as string, position: r.position as string }]),
      )
      const previous = checkpoints.get(projector.name)
      if (rebuild || (previous !== undefined && previous.version !== projector.version)) {
        for (const name of checkpoints.keys()) if (!this.registry.has(name)) throw new Error('projector_not_registered')
        const entries = await readEntries(client, workstream)
        for (const selected of this.registry.values()) {
          const projection = selected.create()
          projection.apply(entries)
          await this.replace(client, workstream, selected, projection)
          this.memory.set(`${workstream}:${selected.name}`, { version: selected.version, projection })
        }
        await reset()
      } else {
        const key = `${workstream}:${projector.name}`
        const from = previous?.position ?? '0'
        let held = this.memory.get(key)
        if (!held || held.version !== projector.version || held.projection.position !== from) {
          // A fresh process, or a failed run: fold up to the checkpoint without writing anything.
          const projection = projector.create()
          projection.apply(await readEntries(client, workstream).then((all) => all.filter((e) => cursor(e.position) <= cursor(from))))
          projection.position = from
          held = { version: projector.version, projection }
          this.memory.set(key, held)
        }
        const delta = await readEntries(client, workstream, from)
        if (delta.length) {
          const changed = held.projection.apply(delta)
          let removed = false
          for (const id of changed) {
            const item = held.projection.objects.get(id)
            if (item) {
              await this.upsert(client, workstream, projector, item, String(++position))
              if (item.kind === 'workstream') await this.list(client, workstream, item.object)
            } else {
              const deleted = await client.query('DELETE FROM objects WHERE workstream=$1 AND projector=$2 AND id=$3', [workstream, projector.name, id])
              removed ||= Boolean(deleted.rowCount)
            }
          }
          // A removal leaves no object to carry it: the client is given the complete state instead.
          if (removed) await reset()
          await client.query(
            'INSERT INTO checkpoints(workstream,projector,version,position) VALUES($1,$2,$3,$4) ON CONFLICT(workstream,projector) DO UPDATE SET version=excluded.version,position=excluded.position',
            [workstream, projector.name, projector.version, delta.at(-1)!.position],
          )
        } else if (!previous) {
          await client.query(
            'INSERT INTO checkpoints(workstream,projector,version,position) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [workstream, projector.name, projector.version, from],
          )
        }
      }
      await client.query('UPDATE threads SET last_position=$2,reset_position=$3 WHERE workstream=$1', [workstream, String(position), String(resetAt)])
      await client.query('COMMIT')
      return String(position)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => (broken = true))
      for (const name of this.registry.keys()) this.memory.delete(`${workstream}:${name}`)
      throw error
    } finally {
      client.release(broken)
    }
  }
  private async upsert(
    client: PoolClient,
    workstream: string,
    projector: Projector,
    item: ProjectedObject,
    position: string,
  ): Promise<void> {
    // An element's type in its own column, for search (docs/specs/search.md).
    const type = item.kind === 'element' && typeof item.object.type === 'string' ? item.object.type : null
    const written = await client.query(
      'INSERT INTO objects(workstream,projector,kind,id,object,first_position,last_position,type,position) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) ON CONFLICT(workstream,kind,id) DO UPDATE SET object=excluded.object,first_position=excluded.first_position,last_position=excluded.last_position,type=excluded.type,position=excluded.position WHERE objects.projector=excluded.projector',
      [workstream, projector.name, item.kind, item.id, encode(item.object), item.first_position, item.last_position, type, position],
    )
    if (written.rowCount !== 1) throw new Error('projector_object_conflict')
  }
  /** Replaces a projector's objects with a rebuilt projection, removing obsolete ones; the reset that follows numbers them. */
  private async replace(
    client: PoolClient,
    workstream: string,
    projector: Projector,
    projection: Projection,
  ): Promise<void> {
    const old = await client.query(
      'SELECT id,object::text,first_position,last_position FROM objects WHERE workstream=$1 AND projector=$2',
      [workstream, projector.name],
    )
    const remaining = new Map(old.rows.map((o) => [o.id as string, o]))
    for (const item of projection.objects.values()) {
      const prior = remaining.get(item.id)
      remaining.delete(item.id)
      if (
        !prior ||
        hash(decode(prior.object)) !== hash(item.object) ||
        prior.first_position !== item.first_position ||
        prior.last_position !== item.last_position
      )
        await this.upsert(client, workstream, projector, item, '0')
    }
    for (const id of remaining.keys())
      await client.query('DELETE FROM objects WHERE workstream=$1 AND projector=$2 AND id=$3', [
        workstream,
        projector.name,
        id,
      ])
    await client.query(
      'INSERT INTO checkpoints(workstream,projector,version,position) VALUES($1,$2,$3,$4) ON CONFLICT(workstream,projector) DO UPDATE SET version=excluded.version,position=excluded.position',
      [workstream, projector.name, projector.version, projection.position],
    )
  }
  /**
   * Writes a Workstream's row in its list — its parent's, or its owner's for a root —, then its parent's row
   * in its own, up to the root (docs/specs/log.md, "The list", "Up the line"). Each list's row is locked
   * before the row it orders is computed, from the sub-stream up, and stays locked until the transaction
   * commits: positions commit in their order, and what a row counts below it is what the lines written
   * before it committed. A row as stored ends the climb.
   */
  private async list(client: PoolClient, workstream: string, view: unknown): Promise<void> {
    let current: string | null = workstream
    let own: unknown = view
    while (current !== null) {
      const line = (await client.query('SELECT owner, parent, depth FROM workstreams WHERE id=$1', [current])).rows[0] as
        | { owner: string; parent: string | null; depth: number }
        | undefined
      if (line === undefined) return
      const list = line.parent ?? line.owner
      await client.query('INSERT INTO lists(owner) VALUES($1) ON CONFLICT DO NOTHING', [list])
      await client.query('SELECT last_position FROM lists WHERE owner=$1 FOR UPDATE', [list])
      if (own === undefined) {
        const stored = await client.query("SELECT object::text FROM objects WHERE workstream=$1 AND kind='workstream' AND id=$1", [current])
        own = stored.rowCount ? decode(stored.rows[0].object) : {}
      }
      const children = (await client.query('SELECT row::text FROM listings WHERE owner=$1', [current])).rows.map((r) => decode(r.row) as ListRow)
      const row = listRow(current, line, (own ?? {}) as Record<string, unknown>, children)
      if (row === null) return
      const prior = await client.query('SELECT row::text FROM listings WHERE workstream=$1', [current])
      if (prior.rowCount && hash(decode(prior.rows[0].row)) === hash(row)) return
      const next = (await client.query('UPDATE lists SET last_position=last_position+1 WHERE owner=$1 RETURNING last_position', [list])).rows[0]
        .last_position as string
      await client.query(
        'INSERT INTO listings(workstream,owner,position,changed_at,title,row) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(workstream) DO UPDATE SET position=excluded.position,changed_at=excluded.changed_at,title=excluded.title,row=excluded.row',
        [current, list, next, row.changedAt, typeof row.title === 'string' ? row.title : '', encode(row)],
      )
      current = line.parent
      own = undefined
    }
  }
  /** Whether a Workstream exists and belongs to one of `owners`; any owner when none are given. */
  async belongs(workstream: string, owners: readonly string[] | null): Promise<boolean> {
    const found = await this.store.projector.query('SELECT owner FROM workstreams WHERE id=$1', [workstream])
    return found.rowCount === 1 && (owners === null || owners.includes(found.rows[0].owner as string))
  }
  /** docs/specs/log.md, "HTTP": a Workstream's row, one of `owners`' when they are given; null before its first entry. */
  async row(workstream: string, owners: readonly string[] | null): Promise<ListRow | null> {
    const found = await this.store.projector.query('SELECT l.row::text, w.owner FROM listings l JOIN workstreams w ON w.id=l.workstream WHERE l.workstream=$1', [
      workstream,
    ])
    if (!found.rowCount || (owners !== null && !owners.includes(found.rows[0].owner as string))) return null
    return decode(found.rows[0].row) as ListRow
  }
  /**
   * At start: an element projected without its type — by a server of the schema before — gets it
   * (docs/specs/search.md); a Workstream with a view and no row in its list gets one. The number of rows written.
   */
  async backfill(): Promise<number> {
    await this.store.projector.query("UPDATE objects SET type = object->>'type' WHERE kind = 'element' AND type IS NULL AND object ? 'type'")
    const missing = await this.store.projector.query(
      "SELECT o.workstream FROM objects o LEFT JOIN listings l ON l.workstream=o.workstream WHERE o.kind='workstream' AND o.id=o.workstream AND l.workstream IS NULL",
    )
    let written = 0
    for (const { workstream } of missing.rows as { workstream: string }[]) {
      const client = await this.store.projector.connect()
      let broken = false
      try {
        await client.query('BEGIN')
        // The projector's lock, as a run takes it: a run and a back-fill never write the row together.
        await client.query('INSERT INTO threads(workstream) VALUES($1) ON CONFLICT DO NOTHING', [workstream])
        await client.query('SELECT last_position FROM threads WHERE workstream=$1 FOR UPDATE', [workstream])
        const view = await client.query("SELECT object::text FROM objects WHERE workstream=$1 AND kind='workstream' AND id=$1", [workstream])
        const listed = await client.query('SELECT 1 FROM listings WHERE workstream=$1', [workstream])
        if (view.rowCount && !listed.rowCount) {
          await this.list(client, workstream, decode(view.rows[0].object))
          written++
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => (broken = true))
        throw error
      } finally {
        client.release(broken)
      }
    }
    return written
  }
  /** docs/specs/log.md, "The list": from zero, the most recent page; from C, the rows written in (C, H]; then H. */
  async listSnapshot(owner: string, after: string): Promise<{ rows: ThreadRow[]; end: string }> {
    cursor(after)
    const client = await this.store.projector.connect()
    let broken = false
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const high = await client.query('SELECT last_position FROM lists WHERE owner=$1', [owner])
      const end = (high.rows[0]?.last_position as string | undefined) ?? '0'
      if (cursor(after) > cursor(end)) throw new Error('future_cursor')
      const rows =
        after === '0'
          ? await client.query('SELECT workstream,position,row::text FROM listings WHERE owner=$1 ORDER BY changed_at DESC,workstream DESC LIMIT $2', [
              owner,
              LIST_PAGE,
            ])
          : await client.query('SELECT workstream,position,row::text FROM listings WHERE owner=$1 AND position>$2 AND position<=$3 ORDER BY position', [
              owner,
              after,
              end,
            ])
      await client.query('COMMIT')
      return { rows: rows.rows.map(listed), end }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => (broken = true))
      throw error
    } finally {
      client.release(broken)
    }
  }
  async listTail(owner: string, after: string): Promise<ThreadRow[]> {
    cursor(after)
    const rows = await this.store.projector.query(
      'SELECT workstream,position,row::text FROM listings WHERE owner=$1 AND position>$2 ORDER BY position LIMIT 256',
      [owner, after],
    )
    return rows.rows.map(listed)
  }
  /** docs/specs/log.md, "The list": the rows older than a page cursor, whose title holds a text when one is given. */
  /**
   * docs/specs/log.md, "The list": the rows of a list older than a page cursor; with a title, of every list of
   * the owner's when `tree`, sub-streams included at any depth.
   */
  async listPage(list: string, before: string | null, title: string | null, tree = false): Promise<{ rows: ListRow[]; next: string | null }> {
    const params: unknown[] = [list, LIST_PAGE + 1]
    const searching = title !== null && title.trim() !== ''
    let where = searching && tree ? 'w.owner=$1' : 'l.owner=$1'
    if (before !== null) {
      const [changedAt, id] = pageCursor(before)
      params.push(changedAt, id)
      where += ` AND (l.changed_at,l.workstream) < ($${params.length - 1}::timestamptz,$${params.length}::uuid)`
    }
    if (searching) {
      params.push(title.trim().toLowerCase())
      where += ` AND strpos(lower(l.title),$${params.length}) > 0`
    }
    const rows = await this.store.projector.query(
      `SELECT l.row::text FROM listings l JOIN workstreams w ON w.id=l.workstream WHERE ${where} ORDER BY l.changed_at DESC,l.workstream DESC LIMIT $2`,
      params,
    )
    const page = rows.rows.map((r) => decode(r.row as string) as ListRow)
    const more = page.length > LIST_PAGE
    if (more) page.pop()
    const last = page.at(-1)
    return { rows: page, next: more && last ? `${last.changedAt},${last.id}` : null }
  }
  /** Lets go of a Workstream's projections in memory; the next run folds up to its checkpoint again. */
  forget(workstream: string): void {
    for (const name of this.registry.keys()) this.memory.delete(`${workstream}:${name}`)
  }
  async objects(workstream: string): Promise<ProjectedObject[]> {
    const rows = await this.store.projector.query(
      'SELECT kind,id,object::text,first_position,last_position FROM objects WHERE workstream=$1 ORDER BY id',
      [workstream],
    )
    return rows.rows.map((r) => ({ ...r, object: decode(r.object) })) as ProjectedObject[]
  }
  /**
   * docs/specs/log.md, "HTTP" (`GET /api/pools`): per pool and per harness, the view most recently changed
   * among those with a Session's settings — what its last Session gave. Only those views leave PostgreSQL.
   */
  async lastSessions(): Promise<{ pools: Map<string, Record<string, unknown>>; harnesses: Map<string, Record<string, unknown>> }> {
    const rows = await this.store.projector.query(
      `SELECT DISTINCT ON (scope, name) scope, name, object::text AS object FROM (
         SELECT 'pool' AS scope, object->>'pool' AS name, object FROM objects WHERE kind='workstream' AND projector=$1 AND jsonb_typeof(object->'settings')='array'
         UNION ALL
         SELECT 'harness', object->>'harness', object FROM objects WHERE kind='workstream' AND projector=$1 AND jsonb_typeof(object->'settings')='array'
       ) settled WHERE name IS NOT NULL ORDER BY scope, name, (object->>'changedAt')::timestamptz DESC NULLS LAST`,
      [core.name],
    )
    const last = { pools: new Map<string, Record<string, unknown>>(), harnesses: new Map<string, Record<string, unknown>>() }
    for (const r of rows.rows as { scope: string; name: string; object: string }[])
      (r.scope === 'pool' ? last.pools : last.harnesses).set(r.name, decode(r.object) as Record<string, unknown>)
    return last
  }

  /**
   * docs/specs/log.md, "The thread": from C, the objects changed in (C, H] — every object, after a `reset`
   * in (C, H] or from zero —, in position order; then H.
   */
  async snapshot(workstream: string, after: string): Promise<{ rows: ThreadRow[]; end: string }> {
    cursor(after)
    const client = await this.store.projector.connect()
    let broken = false
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const exists = await client.query('SELECT id FROM workstreams WHERE id=$1', [workstream])
      if (!exists.rowCount) throw new Error('unknown_workstream')
      const high = await client.query('SELECT last_position,reset_position FROM threads WHERE workstream=$1', [workstream])
      const end = (high.rows[0]?.last_position as string | undefined) ?? '0',
        resetAt = (high.rows[0]?.reset_position as string | undefined) ?? '0'
      if (cursor(after) > cursor(end)) throw new Error('future_cursor')
      const whole = after === '0' || cursor(resetAt) > cursor(after)
      const changed = await client.query(
        `SELECT position,kind,id,object::text FROM objects WHERE workstream=$1${whole ? '' : ' AND position>$2'} ORDER BY position,kind,id`,
        whole ? [workstream] : [workstream, after],
      )
      const rows: ThreadRow[] = changed.rows.map(upserted)
      if (cursor(resetAt) > cursor(after)) rows.unshift(resetRow(resetAt))
      await client.query('COMMIT')
      return { rows, end }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => (broken = true))
      throw error
    } finally {
      client.release(broken)
    }
  }
  /** The live rows after C, in one statement: a `reset` after C first, then the objects changed after C. */
  async tail(workstream: string, after: string): Promise<ThreadRow[]> {
    cursor(after)
    const found = await this.store.projector.query(
      `SELECT t.reset_position, o.position, o.kind, o.id, o.object::text AS object FROM threads t
       LEFT JOIN LATERAL (SELECT position,kind,id,object FROM objects WHERE workstream=t.workstream AND position>$2 ORDER BY position LIMIT 256) o ON true
       WHERE t.workstream=$1 ORDER BY o.position`,
      [workstream, after],
    )
    const rows: ThreadRow[] = found.rows.filter((r) => r.position !== null).map(upserted)
    const resetAt = found.rows[0]?.reset_position as string | undefined
    if (resetAt !== undefined && cursor(resetAt) > cursor(after)) rows.unshift(resetRow(resetAt))
    return rows
  }
}

const upserted = (r: { position: string; kind: string; id: string; object: string }): ThreadRow => ({
  position: r.position,
  operation: 'upsert',
  kind: r.kind,
  id: r.id,
  object: decode(r.object),
})
const resetRow = (position: string): ThreadRow => ({ position, operation: 'reset', kind: null, id: null, object: null })

/** Keeps the cursor paired with its object state. A partial snapshot can be applied repeatedly. */
export class ThreadClient {
  cursor = '0'
  readonly objects = new Map<string, unknown>()
  apply(row: ThreadRow): void {
    if (row.operation === 'reset') this.objects.clear()
    else if (row.id) this.objects.set(row.id, row.object)
  }
  snapshotEnd(position: string): void {
    if (cursor(position) < cursor(this.cursor)) throw new Error('cursor_regressed')
    this.cursor = position
  }
  live(row: ThreadRow): void {
    if (cursor(row.position) > cursor(this.cursor)) {
      this.apply(row)
      this.cursor = row.position
    }
  }
}
