import { createPool, requireDatabaseUrl } from '@agora/store-pg'
import { createHttpBrokerGrantClient } from './broker-grant-client.js'
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
const brokerControlBaseUrl = requireEnv('BROKER_CONTROL_BASE_URL')
const pool = createPool(requireDatabaseUrl())

startProjectorSweepLoop(pool)

const server = createServer({
  pool,
  controllerTransport: { baseUrl: controllerBaseUrl, fetch },
  brokerGrantClient: createHttpBrokerGrantClient(brokerControlBaseUrl),
  connections: new SessionConnectionRegistry(),
})

server.listen(port, () => {
  process.stdout.write(`web listening on :${port} (controller=${controllerBaseUrl}, broker=${brokerControlBaseUrl})\n`)
})
