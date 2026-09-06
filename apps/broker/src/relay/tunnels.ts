// Open tunnel registry (003 verbs — REVOKE: "the relay is closed to affected traffic before
// changing authority and existing tunnels are terminated"; findings §3.2: tunnel-establishment
// audit rows are not an egress audit trail, so this registry exists to actually CLOSE sockets, not
// merely to log that they opened). Keyed by incarnation — the same identity GRANT/REVOKE act on.
import type { Socket } from 'node:net'

export class TunnelRegistry {
  readonly #byIncarnation = new Map<string, Set<Socket>>()

  register(incarnation: string, socket: Socket): void {
    const set = this.#byIncarnation.get(incarnation) ?? new Set()
    set.add(socket)
    this.#byIncarnation.set(incarnation, set)
    socket.once('close', () => {
      set.delete(socket)
      if (set.size === 0) this.#byIncarnation.delete(incarnation)
    })
  }

  /** Terminates every open tunnel for this incarnation — called before REVOKE narrows/detaches, never after. */
  terminateAll(incarnation: string): number {
    const set = this.#byIncarnation.get(incarnation)
    if (set === undefined) return 0
    const count = set.size
    for (const socket of set) socket.destroy()
    this.#byIncarnation.delete(incarnation)
    return count
  }

  openCountFor(incarnation: string): number {
    return this.#byIncarnation.get(incarnation)?.size ?? 0
  }
}
