// A Workstream's objects as the thread delivers them (docs/specs/assistant-ui.md, "The exchanges";
// docs/specs/log.md, "The thread"). Pure: no React, no browser API, so that Node tests run it as is.

export type Json = Record<string, unknown>
export type Kind = 'workstream' | 'turn' | 'element' | 'notice'

/** One object of the log's views: its kind, and the object whole, as last received. */
export interface ViewObject {
  readonly kind: Kind
  readonly id: string
  readonly object: Json
}

/** A server-sent event of the thread. */
export interface ThreadRow {
  readonly type: 'snapshot' | 'snapshot-end' | 'live'
  readonly position: string
  readonly operation?: 'upsert' | 'remove' | 'reset'
  readonly kind?: string | null
  readonly id?: string | null
  readonly object?: Json | null
}

export interface ThreadState {
  readonly objects: ReadonlyMap<string, ViewObject>
  /** The last position applied whole: `snapshot-end`'s, then each live row's. */
  readonly cursor: string
  /** Whether the snapshot read from `cursor` has ended: commands wait for it. */
  readonly complete: boolean
}

export const empty: ThreadState = { objects: new Map(), cursor: '0', complete: false }

/** Positions are decimal strings, compared as integers. */
export function after(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b)
}

function change(objects: Map<string, ViewObject>, row: ThreadRow): void {
  if (row.operation === 'reset') objects.clear()
  else if (row.operation === 'remove' && row.id) objects.delete(row.id)
  else if (row.operation === 'upsert' && row.id && row.object) objects.set(row.id, { kind: row.kind as Kind, id: row.id, object: row.object })
}

/** Applies one row; a live row at or before the cursor was already applied, and changes nothing. */
export function apply(state: ThreadState, row: ThreadRow): ThreadState {
  if (row.type === 'snapshot-end') return { ...state, cursor: row.position, complete: true }
  if (row.type === 'live' && !after(row.position, state.cursor)) return state
  const objects = new Map(state.objects)
  change(objects, row)
  return row.type === 'live' ? { objects, cursor: row.position, complete: state.complete } : { objects, cursor: state.cursor, complete: false }
}

/** The state a stream opens from: the same objects and cursor, the snapshot not yet read. */
export function reopen(state: ThreadState): ThreadState {
  return { ...state, complete: false }
}

export function ofKind(state: ThreadState, kind: Kind): ViewObject[] {
  return [...state.objects.values()].filter((o) => o.kind === kind)
}
