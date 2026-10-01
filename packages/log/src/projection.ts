import { type LogStore, readEntries } from './store.ts'
import { project, type ProjectedObject } from './state.ts'
import { cursor, decode, encode, hash } from './json.ts'
import { measured } from './telemetry.ts'

export type ThreadRow = {
  position: string
  operation: 'upsert' | 'remove' | 'reset'
  kind: string | null
  id: string | null
  object: unknown
}
export interface Projector {
  name: string
  version: string
  fold: (entries: Awaited<ReturnType<LogStore['entries']>>) => ProjectedObject[]
}
export const core: Projector = { name: 'core', version: '2', fold: project }
export class Projections {
  readonly store: LogStore
  readonly registry: Map<string, Projector>
  private readonly sink: (line: string) => void
  constructor(store: LogStore, projectors: Projector[] = [core], sink: (line: string) => void = () => {}) {
    this.store = store
    this.sink = sink
    this.registry = new Map(projectors.map((p) => [p.name, p]))
  }
  async run(workstream: string, projector: Projector = core, rebuild = false): Promise<string> {
    return measured({ operation: 'project', stage: 'projection_commit', workstream },
      () => this.apply(workstream, projector, rebuild), this.sink)
  }
  private async apply(workstream: string, projector: Projector, rebuild: boolean): Promise<string> {
    this.registry.set(projector.name, projector)
    const client = await this.store.projector.connect()
    try {
      await client.query('BEGIN')
      const row = await client.query('SELECT id,last_thread_position FROM workstreams WHERE id=$1 FOR UPDATE', [
        workstream,
      ])
      if (!row.rowCount) throw new Error('unknown_workstream')
      let position = BigInt(row.rows[0].last_thread_position)
      const entries = await readEntries(client, workstream),
        source = entries.at(-1)?.position ?? '0'
      const checkpoint = await client.query(
        'SELECT version,position FROM checkpoints WHERE workstream=$1 AND projector=$2',
        [workstream, projector.name],
      )
      const previous = checkpoint.rows[0]
      if (!rebuild && previous?.version === projector.version && previous.position === source) {
        await client.query('COMMIT')
        return String(position)
      }
      const reset = rebuild || (previous && previous.version !== projector.version)
      const emit = async (operation: string, kind: string | null, id: string | null, value: unknown) => {
        await client.query(
          'INSERT INTO thread(workstream,position,operation,kind,id,object) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
          [workstream, String(++position), operation, kind, id, value === null ? null : encode(value)],
        )
      }
      if (reset) {
        const names = await client.query('SELECT projector FROM checkpoints WHERE workstream=$1', [workstream])
        if (names.rows.some((r) => !this.registry.has(r.projector))) throw new Error('projector_not_registered')
      }
      for (const selected of reset ? this.registry.values() : [projector]) {
        const objects = selected.fold(entries)
        const old = await client.query(
          'SELECT kind,id,object::text,first_position,last_position FROM objects WHERE workstream=$1 AND projector=$2',
          [workstream, selected.name],
        )
        const remaining = new Map(old.rows.map((o) => [o.id, o]))
        for (const item of objects) {
          const prior = remaining.get(item.id)
          remaining.delete(item.id)
          if (
            !prior ||
            hash(decode(prior.object)) !== hash(item.object) ||
            prior.first_position !== item.first_position ||
            prior.last_position !== item.last_position
          ) {
            const written = await client.query(
              'INSERT INTO objects(workstream,projector,kind,id,object,first_position,last_position) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(workstream,kind,id) DO UPDATE SET object=excluded.object,first_position=excluded.first_position,last_position=excluded.last_position WHERE objects.projector=excluded.projector',
              [
                workstream,
                selected.name,
                item.kind,
                item.id,
                encode(item.object),
                item.first_position,
                item.last_position,
              ],
            )
            if (written.rowCount !== 1) throw new Error('projector_object_conflict')
            if (!reset) await emit('upsert', item.kind, item.id, item.object)
          }
        }
        for (const prior of remaining.values()) {
          await client.query('DELETE FROM objects WHERE workstream=$1 AND projector=$2 AND id=$3', [
            workstream,
            selected.name,
            prior.id,
          ])
          if (!reset) await emit('remove', prior.kind, prior.id, null)
        }
        await client.query(
          'INSERT INTO checkpoints(workstream,projector,version,position) VALUES($1,$2,$3,$4) ON CONFLICT(workstream,projector) DO UPDATE SET version=excluded.version,position=excluded.position',
          [workstream, selected.name, selected.version, source],
        )
      }
      if (reset) {
        await emit('reset', null, null, null)
        const all = await client.query(
          'SELECT kind,id,object::text FROM objects WHERE workstream=$1 ORDER BY kind,id',
          [workstream],
        )
        for (const o of all.rows) await emit('upsert', o.kind, o.id, decode(o.object))
      }
      await client.query('UPDATE workstreams SET last_thread_position=$2 WHERE id=$1', [workstream, String(position)])
      await client.query('COMMIT')
      return String(position)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
  async objects(workstream: string): Promise<ProjectedObject[]> {
    const rows = await this.store.projector.query(
      'SELECT kind,id,object::text,first_position,last_position FROM objects WHERE workstream=$1 ORDER BY id',
      [workstream],
    )
    return rows.rows.map((r) => ({ ...r, object: decode(r.object) })) as ProjectedObject[]
  }
  async snapshot(workstream: string, after: string): Promise<{ rows: ThreadRow[]; end: string }> {
    cursor(after)
    const client = await this.store.projector.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const high = await client.query('SELECT last_thread_position FROM workstreams WHERE id=$1', [workstream])
      if (!high.rowCount) throw new Error('unknown_workstream')
      const end = high.rows[0].last_thread_position as string
      if (cursor(after) > cursor(end)) throw new Error('future_cursor')
      const reset = await client.query(
        "SELECT position FROM thread WHERE workstream=$1 AND position>$2 AND position<=$3 AND operation='reset' ORDER BY position DESC LIMIT 1",
        [workstream, after, end],
      )
      let rows: ThreadRow[]
      if (reset.rowCount) {
        const all = await client.query(
          'SELECT kind,id,object::text FROM objects WHERE workstream=$1 ORDER BY kind,id',
          [workstream],
        )
        rows = [
          ...(reset.rowCount
            ? [{ position: reset.rows[0].position, operation: 'reset' as const, kind: null, id: null, object: null }]
            : []),
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
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
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
/** Keep the cursor paired with its object state. A partial snapshot can be applied repeatedly. */
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
