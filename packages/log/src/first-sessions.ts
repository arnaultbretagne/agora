// A pool's first Session (docs/specs/log.md, "Sessions"): the catalogue offers each pool the settings of the last Session
// opened in it, else its harness's last, which ran on an older image. So that a newer image's settings — its models —
// are offered as soon as its pool is ready, the server opens one Session in each pool none has opened in: a Workstream
// of its own owner, a Create with no message, on the shortest lease.
import { randomUUID } from 'node:crypto'
import { telemetry } from './telemetry.ts'
import type { Workstreams } from './workstreams.ts'

/** The owner of the Workstreams that open them: no person's, so in no person's list. */
export const FIRST_SESSIONS_OWNER = '00000000-0000-4000-8000-0000000000f1'

export interface FirstSessionsOptions {
  /** How often the pools are looked at; 30 s. */
  readonly everyMs?: number
}

export class FirstSessions {
  private readonly workstreams: Workstreams
  private readonly options: FirstSessionsOptions
  /** Each pool's Workstream: kept while its Create is refused, so that a retry adds none. */
  private readonly workstreamOf = new Map<string, string>()
  /** The pools whose Create was accepted, in this process. */
  private readonly opened = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private looking: Promise<void> | null = null

  constructor(workstreams: Workstreams, options: FirstSessionsOptions = {}) {
    this.workstreams = workstreams
    this.options = options
    workstreams.firstSessions = this
  }

  async start(): Promise<void> {
    await this.look()
    this.timer = setInterval(() => void this.look(), this.options.everyMs ?? 30_000)
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    await this.looking
  }

  /** One look at a time: each ready pool, not kept for the tests, that no Session has opened in. */
  look(): Promise<void> {
    this.looking ??= (async () => {
      try {
        const [pools, latest] = await Promise.all([this.workstreams.pools(), this.workstreams.projections.lastSessions()])
        for (const pool of pools) {
          if (pool.testing || pool.readyReplicas < 1 || latest.pools.has(pool.name) || this.opened.has(pool.name)) continue
          const workstream = this.workstreamOf.get(pool.name) ?? randomUUID()
          this.workstreamOf.set(pool.name, workstream)
          await this.workstreams.options.store.create(workstream, FIRST_SESSIONS_OWNER)
          const answer = await this.workstreams.command(
            workstream,
            { id: randomUUID(), kind: 'Create', target: {}, body: { pool: pool.name, limits: { leaseSeconds: 60 } } },
            'agora',
          )
          if (answer.accepted) this.opened.add(pool.name)
        }
      } catch {
        telemetry({ operation: 'admission', outcome: 'failed', errorClass: 'database' }, this.workstreams.options.sink ?? (() => {}))
      } finally {
        this.looking = null
      }
    })()
    return this.looking
  }
}
