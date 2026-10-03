// Views and the thread (docs/specs/log.md, "Views", "The thread"). A projector keeps its fold in memory
// per Workstream and advances it by the entries after its checkpoint; it writes only what changed,
// under the projector's own lock (the `threads` row), never the capture lock. A version change
// rebuilds every projector and publishes a reset with the complete state.
import type { PoolClient } from 'pg'
import { type LogStore, readEntries, type Entry } from './store.ts'
import { CoreProjection, type ProjectedObject } from './state.ts'
import { cursor, decode, encode, hash } from './json.ts'

export type ThreadRow = {
  position: string
  operation: 'upsert' | 'remove' | 'reset'
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
export const core: Projector = { name: 'core', version: '2', create: () => new CoreProjection() }

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
      const locked = await client.query('SELECT last_position FROM threads WHERE workstream=$1 FOR UPDATE', [workstream])
      let position = BigInt(locked.rows[0].last_position)
      const emit = async (operation: string, kind: string | null, id: string | null, value: unknown) => {
        await client.query(
          'INSERT INTO thread(workstream,position,operation,kind,id,object) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
          [workstream, String(++position), operation, kind, id, value === null ? null : encode(value)],
        )
      }
      const checkpoints = new Map<string, { version: string; position: string }>(
        (
          await client.query('SELECT projector,version,position FROM checkpoints WHERE workstream=$1', [workstream])
        ).rows.map((r) => [r.projector as string, { version: r.version as string, position: r.position as string }]),
      )
      const previous = checkpoints.get(projector.name)
      const reset = rebuild || (previous !== undefined && previous.version !== projector.version)
      if (reset) {
        for (const name of checkpoints.keys()) if (!this.registry.has(name)) throw new Error('projector_not_registered')
        const entries = await readEntries(client, workstream)
        for (const selected of this.registry.values()) {
          const projection = selected.create()
          projection.apply(entries)
          await this.replace(client, workstream, selected, projection)
          this.memory.set(`${workstream}:${selected.name}`, { version: selected.version, projection })
        }
        await emit('reset', null, null, null)
        const all = await client.query('SELECT kind,id,object::text FROM objects WHERE workstream=$1 ORDER BY kind,id', [
          workstream,
        ])
        for (const o of all.rows) await emit('upsert', o.kind, o.id, decode(o.object))
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
          for (const id of changed) {
            const item = held.projection.objects.get(id)
            if (item) {
              await this.upsert(client, workstream, projector, item)
              await emit('upsert', item.kind, item.id, item.object)
            } else {
              const removed = await client.query(
                'DELETE FROM objects WHERE workstream=$1 AND projector=$2 AND id=$3 RETURNING kind',
                [workstream, projector.name, id],
              )
              if (removed.rowCount) await emit('remove', removed.rows[0].kind, id, null)
            }
          }
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
      await client.query('UPDATE threads SET last_position=$2 WHERE workstream=$1', [workstream, String(position)])
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
  ): Promise<void> {
    const written = await client.query(
      'INSERT INTO objects(workstream,projector,kind,id,object,first_position,last_position) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(workstream,kind,id) DO UPDATE SET object=excluded.object,first_position=excluded.first_position,last_position=excluded.last_position WHERE objects.projector=excluded.projector',
      [workstream, projector.name, item.kind, item.id, encode(item.object), item.first_position, item.last_position],
    )
    if (written.rowCount !== 1) throw new Error('projector_object_conflict')
  }
  /** Replaces a projector's objects with a rebuilt projection, removing obsolete ones. */
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
        await this.upsert(client, workstream, projector, item)
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
  /** docs/specs/log.md, "HTTP": every Workstream's view, the most recently changed first. */
  async views(): Promise<Record<string, unknown>[]> {
    const rows = await this.store.projector.query(
      "SELECT w.id, o.object::text AS object FROM workstreams w LEFT JOIN objects o ON o.workstream=w.id AND o.kind='workstream' AND o.projector=$1",
      [core.name],
    )
    // A Workstream with no entry yet has no view: listed as new, first.
    const views = rows.rows.map((r) =>
      r.object === null
        ? { id: r.id as string, title: 'New workstream', state: 'none', execution: null, session: null, pool: null, harness: null, anchor: null, changedAt: null }
        : (decode(r.object as string) as Record<string, unknown>),
    )
    return views.sort((a, b) => (a.changedAt === null ? -1 : b.changedAt === null ? 1 : String(b.changedAt).localeCompare(String(a.changedAt))))
  }

  async snapshot(workstream: string, after: string): Promise<{ rows: ThreadRow[]; end: string }> {
    cursor(after)
    const client = await this.store.projector.connect()
    let broken = false
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const exists = await client.query('SELECT id FROM workstreams WHERE id=$1', [workstream])
      if (!exists.rowCount) throw new Error('unknown_workstream')
      const high = await client.query('SELECT last_position FROM threads WHERE workstream=$1', [workstream])
      const end = (high.rows[0]?.last_position as string | undefined) ?? '0'
      if (cursor(after) > cursor(end)) throw new Error('future_cursor')
      const reset = await client.query(
        "SELECT position FROM thread WHERE workstream=$1 AND position>$2 AND position<=$3 AND operation='reset' ORDER BY position DESC LIMIT 1",
        [workstream, after, end],
      )
      let rows: ThreadRow[]
      if (reset.rowCount) {
        const all = await client.query('SELECT kind,id,object::text FROM objects WHERE workstream=$1 ORDER BY kind,id', [
          workstream,
        ])
        rows = [
          { position: reset.rows[0].position, operation: 'reset' as const, kind: null, id: null, object: null },
          ...all.rows.map((r) => ({ ...r, position: end, operation: 'upsert' as const, object: decode(r.object) })),
        ]
      } else {
        const changes = await client.query(
          'SELECT DISTINCT ON(kind,id) position,operation,kind,id,object::text FROM thread WHERE workstream=$1 AND position>$2 AND position<=$3 ORDER BY kind,id,position DESC',
          [workstream, after, end],
        )
        rows = changes.rows.map((r) => ({ ...r, object: r.object === null ? null : decode(r.object) }))
        rows.sort((a, b) => (cursor(a.position) < cursor(b.position) ? -1 : 1))
      }
      await client.query('COMMIT')
      return { rows, end }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => (broken = true))
      throw error
    } finally {
      client.release(broken)
    }
  }
  async tail(workstream: string, after: string): Promise<ThreadRow[]> {
    cursor(after)
    const rows = await this.store.projector.query(
      'SELECT position,operation,kind,id,object::text FROM thread WHERE workstream=$1 AND position>$2 ORDER BY position LIMIT 256',
      [workstream, after],
    )
    return rows.rows.map((r) => ({ ...r, object: r.object === null ? null : decode(r.object) }))
  }
}

/** Keeps the cursor paired with its object state. A partial snapshot can be applied repeatedly. */
export class ThreadClient {
  cursor = '0'
  readonly objects = new Map<string, unknown>()
  apply(row: ThreadRow): void {
    if (row.operation === 'reset') this.objects.clear()
    else if (row.id && row.operation === 'remove') this.objects.delete(row.id)
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
