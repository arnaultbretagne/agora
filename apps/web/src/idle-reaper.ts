import type pg from 'pg'
import { listIdleSessions } from '@agora/store-pg'
import type { BrokerGrantClient } from './broker-grant-client.js'
import type { SessionConnectionRegistry } from './connections.js'
import { suspendSession } from './orchestration.js'
import type { SessionRuntimeControlTransport } from '@agora/session-runtime-control'

/**
 * Reclaims Session Runtimes that have stopped being used.
 *
 * WHY THIS EXISTS, from a real outage: `agora-runs` caps concurrent Session Runtimes, and nothing
 * ever gave a slot back. Four Sessions — one idle for fifteen hours — held every slot, so every new
 * Session was refused with `exceeded quota` and the platform was wedged for everyone. Capping
 * concurrency without reclaiming it is not a bound, it is a countdown.
 *
 * WHY IT SUSPENDS RATHER THAN KILLS. The OLD system's reaper (agora ADR 0008) simply killed the
 * process. `docs/specs/08-session-runtime-control.md` deliberately does not allow that here: idle
 * collection may happen "only after asking the control plane to perform a durable suspension", and
 * MUST NOT "silently delete a healthy resumable context whose latest state has no committed
 * custody". `suspendSession` is that durable suspension — cancel live work, capture custody, commit
 * the Anchor, then dematerialize — so the Pod goes away, the slot comes back, and the conversation
 * resumes later with its history intact. A user cannot tell a reaped Session from one they left.
 *
 * WHY THE CONTROL PLANE OWNS IT, when ADR 0008 argued for putting the reaper next to the process:
 * the controller's database role is a member of `agora_custody_runtime` only (002-access.sql) and
 * cannot read product truth at all, so it cannot see turns and therefore cannot know what is idle.
 * The spec's own "ask the control plane" phrasing points the same way.
 */
export interface IdleReaperOptions {
  readonly pool: pg.Pool
  readonly transport: SessionRuntimeControlTransport
  readonly brokerGrantClient: BrokerGrantClient
  readonly connections: SessionConnectionRegistry
  /**
   * How long a Session may sit with nothing happening before its Runtime is reclaimed.
   *
   * One hour by default, and not an arbitrary round number: the harness's prompt cache is what a
   * warm Runtime is actually holding, and it expires on that same order. Before it lapses, keeping
   * the Pod costs a slot but saves a re-read; after, the Pod is holding a slot for nothing. The OLD
   * system reached the same figure from the same reasoning (`cacheTtlFor`, agora ADR 0008 "the
   * per-harness cache TTL is product knowledge").
   */
  readonly idleAfterMs?: number
  readonly intervalMs?: number
  readonly now?: () => Date
  /** Test seam: defaults to writing one line per reclaimed Session to stdout. */
  readonly log?: (message: string) => void
}

export interface IdleReaperHandle {
  stop(): Promise<void>
}

export const DEFAULT_IDLE_AFTER_MS = 60 * 60_000
const DEFAULT_INTERVAL_MS = 60_000

/** One pass. Exported so a test can drive it deterministically instead of waiting on a timer. */
export async function reapIdleSessions(options: IdleReaperOptions): Promise<readonly string[]> {
  const now = options.now ?? (() => new Date())
  const idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`))

  const client = await options.pool.connect()
  let idle: Awaited<ReturnType<typeof listIdleSessions>>
  try {
    idle = await listIdleSessions(client, new Date(now().getTime() - idleAfterMs))
  } finally {
    client.release()
  }

  const reaped: string[] = []
  for (const session of idle) {
    try {
      await suspendSession({
        pool: options.pool,
        transport: options.transport,
        brokerGrantClient: options.brokerGrantClient,
        connections: options.connections,
        sessionId: session.sessionId,
        // Deterministic, and derived from the activity timestamp that made this Session eligible:
        // a retried sweep for the SAME idleness reuses the SAME custody capture request id rather
        // than allocating a second generation for one request (docs/specs/13), while a Session that
        // wakes up and goes idle again later gets a genuinely new one.
        idempotencyKey: `idle-reap:${session.lastActivityAt.toISOString()}`,
        now,
      })
      reaped.push(session.sessionId)
      log(`idle-reaper: suspended session ${session.sessionId} (idle since ${session.lastActivityAt.toISOString()})`)
    } catch (error) {
      // One stuck Session must not stop the sweep from reclaiming the others — that would turn a
      // single bad Session into the same wedge this exists to prevent.
      process.stderr.write(`idle-reaper: could not suspend ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return reaped
}

export function startIdleReaper(options: IdleReaperOptions): IdleReaperHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<unknown> = Promise.resolve()

  const tick = (): void => {
    inFlight = reapIdleSessions(options)
      .catch((error: unknown) => {
        process.stderr.write(`idle-reaper sweep failed: ${error instanceof Error ? error.message : String(error)}\n`)
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs)
      })
  }
  timer = setTimeout(tick, intervalMs)

  return {
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await inFlight
    },
  }
}
