// Ticks (ADR 0003): a dedicated client LISTENs on the notification channel; any notification and
// the poll timer both request the same scan. Duplicate requests coalesce into at most one queued
// scan, so notification storms cannot multiply effects and a lost notification loses nothing.
import pg from 'pg'
import { NOTIFY_CHANNEL } from './authoring.js'

export interface TickSourceOptions {
  readonly pool: pg.Pool
  /** Connection string for the dedicated LISTEN client. */
  readonly connectionString: string
  readonly scan: () => Promise<void>
  readonly pollIntervalMs: number
  readonly reconnectDelayMs?: number
  readonly logger?: (message: string) => void
}

export interface TickSource {
  stop(): Promise<void>
}

interface CoalescedRunner {
  run(): Promise<void>
  dispose(): void
}

export function createCoalescedRunner(scan: () => Promise<void>, logger: (message: string) => void): CoalescedRunner {
  let running = false
  let queued = false
  const run = async (): Promise<void> => {
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      await scan()
    } catch (error) {
      logger(`scan failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      running = false
      if (queued) {
        queued = false
        void run()
      }
    }
  }
  return {
    run,
    dispose: () => {
      queued = false
    },
  }
}

export async function startTickSource(options: TickSourceOptions): Promise<TickSource> {
  const logger = options.logger ?? (() => {})
  const runner = createCoalescedRunner(options.scan, logger)

  const poll = setInterval(() => {
    void runner.run()
  }, options.pollIntervalMs)
  poll.unref?.()

  let stopping = false
  let listener: pg.Client | null = null
  let reconnect: NodeJS.Timeout | null = null

  const connect = async (): Promise<void> => {
    while (!stopping) {
      const client = new pg.Client({ connectionString: options.connectionString })
      try {
        await client.connect()
        await client.query(`LISTEN ${NOTIFY_CHANNEL}`)
        client.on('notification', () => {
          void runner.run()
        })
        client.on('error', (error: Error) => {
          logger(`tick listener error: ${error.message}`)
        })
        client.on('end', () => {
          if (!stopping && listener === client) {
            listener = null
            scheduleReconnect()
          }
        })
        listener = client
        return
      } catch (error) {
        await client.end().catch(() => {})
        if (stopping) return
        logger(`tick listener reconnect failed: ${error instanceof Error ? error.message : String(error)}`)
        await new Promise<void>((resolve) => {
          reconnect = setTimeout(resolve, options.reconnectDelayMs ?? 1_000)
          reconnect.unref?.()
        })
      }
    }
  }

  const scheduleReconnect = (): void => {
    if (stopping || reconnect !== null) return
    reconnect = setTimeout(() => {
      reconnect = null
      void connect()
    }, options.reconnectDelayMs ?? 1_000)
    reconnect.unref?.()
  }

  await connect()

  return {
    stop: async () => {
      stopping = true
      clearInterval(poll)
      if (reconnect !== null) clearTimeout(reconnect)
      runner.dispose()
      const current = listener
      listener = null
      if (current !== null) await current.end().catch(() => {})
    },
  }
}
