// The engine's wake source, owner side (engine.md — Watches and recovery sweeps): a bounded log of
// Workstream ids that changed, fed by the live watch. A cursor older than anything retained (or a
// first-ever poll) cannot be trusted incrementally — the caller gets a full relist instead, never a
// silent gap. Sweeping only active work rows is insufficient (ENGINE-012): the relist enumerates
// every currently live Workstream, not only ones with a recent event.
export interface WakeEvent {
  readonly workstreamId: string
  readonly cursor: string
}

export class WakeLog {
  #events: WakeEvent[] = []
  #seq = 0
  readonly #limit: number

  constructor(limit = 2000) {
    this.#limit = limit
  }

  push(workstreamId: string): void {
    this.#seq += 1
    this.#events.push({ workstreamId, cursor: String(this.#seq) })
    if (this.#events.length > this.#limit) this.#events.splice(0, this.#events.length - this.#limit)
  }

  currentCursor(): string {
    return String(this.#seq)
  }

  /** True when `cursor` is old enough that events since it may already have been trimmed. */
  needsRelist(cursor: string | null): boolean {
    if (cursor === null || cursor === '0') return true
    const oldest = this.#events[0]?.cursor
    return oldest === undefined ? Number(cursor) < this.#seq : Number(cursor) < Number(oldest) - 1
  }

  since(cursor: string): readonly WakeEvent[] {
    const after = Number(cursor)
    return this.#events.filter((event) => Number(event.cursor) > after)
  }
}

export interface WakesResponse {
  readonly cursor: string
  readonly resync: boolean
  readonly events: readonly WakeEvent[]
}

/**
 * Serves one `/v1/wakes` read: an untrusted cursor gets every currently live Workstream (from a
 * fresh relist) so a restarted process or an evicted poller never misses a footprint change;
 * otherwise the incremental log since that cursor.
 */
export async function readWakes(log: WakeLog, requestedCursor: string | null, relist: () => Promise<readonly string[]>): Promise<WakesResponse> {
  if (log.needsRelist(requestedCursor)) {
    const workstreamIds = await relist()
    return { cursor: log.currentCursor(), resync: true, events: workstreamIds.map((workstreamId) => ({ workstreamId, cursor: log.currentCursor() })) }
  }
  const events = log.since(requestedCursor!)
  return { cursor: events.length > 0 ? events[events.length - 1]!.cursor : requestedCursor!, resync: false, events }
}
