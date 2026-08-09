import type pg from 'pg'
import { sweepProjector } from '@agora/store-pg'

export interface ProjectorSweepLoopHandle {
  /** Stops scheduling further ticks and resolves once any in-flight sweep has finished — safe to await before closing the pool. */
  stop(): Promise<void>
}

/** Drives `sweepProjector` on an interval — the actual "consume journal notifications" process. */
export function startProjectorSweepLoop(pool: pg.Pool, intervalMs = 200): ProjectorSweepLoopHandle {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<unknown> = Promise.resolve()

  const tick = (): void => {
    inFlight = sweepProjector(pool, new Date())
      .catch((error: unknown) => {
        process.stderr.write(`projector sweep failed: ${error instanceof Error ? error.message : String(error)}\n`)
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
