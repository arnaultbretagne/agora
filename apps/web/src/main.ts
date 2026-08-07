import { createPool, requireDatabaseUrl } from '@agora/store-pg'
import { createHttpBrokerGrantClient } from './broker-grant-client.js'
import { SessionConnectionRegistry } from './connections.js'
import { DEFAULT_IDLE_AFTER_MS, startIdleReaper } from './idle-reaper.js'
import { startProjectorSweepLoop } from './projector-loop.js'
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

const server = createServer({
  pool,
  controllerTransport,
  brokerGrantClient,
  connections,
})

server.listen(port, () => {
  process.stdout.write(
    `web listening on :${port} (controller=${controllerBaseUrl}, broker=${brokerControlBaseUrl}, idle-reap after ${Math.round(idleAfterMs / 60000)}min)\n`,
  )
})
