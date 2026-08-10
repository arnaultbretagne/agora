import { createPool, failStrandedPromptCommands, requireDatabaseUrl } from '@agora/store-pg'
import { createHttpBrokerGrantClient } from './broker-grant-client.js'
import { SessionConnectionRegistry } from './connections.js'
import { DEFAULT_IDLE_AFTER_MS, startIdleReaper } from './idle-reaper.js'
import { startProjectorSweepLoop } from './projector-loop.js'
import { SessionPromptQueue } from './prompt-queue.js'
import { createServer } from './server.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const port = Number(process.env.PORT ?? 8080)
const controllerBaseUrl = requireEnv('SESSION_RUNTIME_CONTROLLER_URL')
const brokerControlBaseUrl = requireEnv('BROKER_CONTROL_BASE_URL')
const pool = createPool(requireDatabaseUrl())

startProjectorSweepLoop(pool)

const controllerTransport = { baseUrl: controllerBaseUrl, fetch }
const brokerGrantClient = createHttpBrokerGrantClient(brokerControlBaseUrl)
const connections = new SessionConnectionRegistry()

// Reclaims Session Runtimes nobody is using — without it the run namespace's concurrency cap is a
// countdown rather than a bound, and four abandoned Sessions wedge the platform for everyone
// (which is exactly what happened on 2026-08-07). Suspends, never kills: history survives and the
// conversation resumes on demand.
const idleAfterMs = Number(process.env.SESSION_IDLE_AFTER_MS ?? DEFAULT_IDLE_AFTER_MS)
startIdleReaper({ pool, transport: controllerTransport, brokerGrantClient, connections, idleAfterMs })

// One prompt turn in flight per Session (docs/specs/03) — see `prompt-queue.ts` for why a queue
// rather than a refusal, and which Agent behaviours forced that choice.
const promptQueue = new SessionPromptQueue()

/**
 * Prompts can only progress through a live ACP connection, and connections die with the process
 * that opened them. Anything still `accepted` or `dispatching` at startup therefore belongs to a
 * previous life and will never move again — so settle it now, rather than leave a Command that a
 * client can poll forever and a turn whose open `ended_at` makes its Session un-reapable.
 */
void pool
  .connect()
  .then(async (client) => {
    try {
      return await failStrandedPromptCommands(client, new Date())
    } finally {
      client.release()
    }
  })
  .then((swept) => {
    if (swept.commands > 0 || swept.turns > 0 || swept.sessions > 0) {
      process.stdout.write(
        `startup: settled ${swept.commands} stranded prompt command(s), closed ${swept.turns} abandoned turn(s), released ${swept.sessions} Session(s) from busy\n`,
      )
    }
  })
  .catch((error: unknown) => {
    // Never fatal: a web process that refuses to start because of a cleanup query is worse than
    // one that starts with some stale rows still to settle on the next boot.
    process.stderr.write(`startup: could not settle stranded prompt commands: ${error instanceof Error ? error.message : String(error)}\n`)
  })

const server = createServer({
  pool,
  controllerTransport,
  brokerGrantClient,
  connections,
  promptQueue,
})

server.listen(port, () => {
  process.stdout.write(
    `web listening on :${port} (controller=${controllerBaseUrl}, broker=${brokerControlBaseUrl}, idle-reap after ${Math.round(idleAfterMs / 60000)}min)\n`,
  )
})
