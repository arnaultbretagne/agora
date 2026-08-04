import { createPool, requireDatabaseUrl } from '@agora/store-pg'
import { SessionConnectionRegistry } from './connections.js'
import { startProjectorSweepLoop } from './projector-loop.js'
import { createServer } from './server.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const port = Number(process.env.PORT ?? 8080)
const controllerBaseUrl = requireEnv('SESSION_RUNTIME_CONTROLLER_URL')
const pool = createPool(requireDatabaseUrl())

startProjectorSweepLoop(pool)

const server = createServer({
  pool,
  controllerTransport: { baseUrl: controllerBaseUrl, fetch },
  connections: new SessionConnectionRegistry(),
})

server.listen(port, () => {
  process.stdout.write(`web listening on :${port} (controller=${controllerBaseUrl})\n`)
})
