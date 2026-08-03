import { createServer } from 'node:http'
import { Duplex } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { createFakeAgent } from '@agora/acp'
import { createWebSocketStream, WebSocketServer } from 'ws'

/**
 * The container entrypoint named by `FAKE_AGENT_DEFINITION.acpCommand`
 * (packages/agent-registry/src/fake-definition.ts) — wraps `@agora/acp`'s deterministic fake Agent
 * behind the `bridge.transport: 'websocket'` listener the Pod's `bridge.listenPort` declares, plus
 * the `/healthz` the PodSpec's readinessProbe checks (docs/specs/08). This process never runs
 * inside the controller; it is the OTHER end of the connection `openACPConnection` mints bridge
 * credentials for.
 */

const PORT = Number(process.env.PORT ?? 8080)

const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: httpServer })

wss.on('connection', (ws) => {
  const duplex = createWebSocketStream(ws)
  const { readable, writable } = Duplex.toWeb(duplex)
  const wire = acp.ndJsonStream(writable as WritableStream<Uint8Array>, readable as ReadableStream<Uint8Array>)
  createFakeAgent().connect(wire)
})

httpServer.listen(PORT, () => {
  process.stdout.write(`fake-agent-server listening on :${PORT}\n`)
})
