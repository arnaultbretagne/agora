import { createServer, type Server } from 'node:http'
import { Duplex } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { createFakeAgent, type FakeAgentOptions } from '@agora/acp'
import { createWebSocketStream, WebSocketServer } from 'ws'

/**
 * Stands in for the real Session Runtime controller (apps/session-runtime-controller) purely over
 * HTTP + WebSocket — apps/web (a deployable) must never import that controller's source directly
 * (scripts/check-architecture.mjs: "no deployable imports another deployable"), so this test
 * harness re-implements just enough of its wire contract to exercise apps/web's own orchestration
 * code against a REAL server and a REAL `@agora/acp` fake Agent over a REAL WebSocket, the same
 * construction proven live in P04's cluster verification.
 */
export interface FakeControllerHandle {
  readonly baseUrl: string
  readonly fetch: typeof fetch
  readonly dematerializeCalls: readonly string[]
  close(): Promise<void>
}

function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

export async function startFakeController(agentOptions: FakeAgentOptions = {}): Promise<FakeControllerHandle> {
  const agentHttpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200)
      res.end('ok')
      return
    }
    res.writeHead(404)
    res.end()
  })
  const openSockets = new Set<import('ws').WebSocket>()
  const wss = new WebSocketServer({ server: agentHttpServer })
  wss.on('connection', (ws) => {
    openSockets.add(ws)
    ws.once('close', () => openSockets.delete(ws))
    const duplex = createWebSocketStream(ws)
    const { readable, writable } = Duplex.toWeb(duplex)
    const wire = acp.ndJsonStream(writable as WritableStream<Uint8Array>, readable as ReadableStream<Uint8Array>)
    createFakeAgent(agentOptions).connect(wire)
  })
  await new Promise<void>((resolve) => agentHttpServer.listen(0, resolve))
  const agentPort = (agentHttpServer.address() as { port: number }).port

  const dematerializeCalls: string[] = []
  const sessions = new Map<string, { agentId: string; runtimeDefinitionVersion: string }>()

  const controllerHttpServer: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://internal')

      if (url.pathname === '/v1/agents' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            registryRevision: 'fake-test-revision',
            items: [
              {
                agentId: 'fake-agent',
                runtimeDefinitionVersion: 'v1',
                label: 'Fake Agent (tests)',
                description: 'Deterministic in-process fake ACP Agent for tests.',
                availability: 'enabled',
              },
            ],
          }),
        )
        return
      }

      const match = /^\/v1\/sessions\/([^/]+)\/runtime(\/acp-connections)?$/.exec(url.pathname)
      if (!match?.[1]) {
        res.writeHead(404)
        res.end()
        return
      }
      const sessionId = match[1]
      const isAcpConnections = Boolean(match[2])

      if (isAcpConnections && req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            transport: 'websocket',
            url: `ws://127.0.0.1:${agentPort}/`,
            credential: 'fake-test-credential',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        )
        return
      }
      if (req.method === 'PUT') {
        const body = await readJson(req)
        const agentId = String(body['agentId'] ?? '')
        const runtimeDefinitionVersion = String(body['runtimeDefinitionVersion'] ?? '')
        sessions.set(sessionId, { agentId, runtimeDefinitionVersion })
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ sessionId, agentId, runtimeDefinitionVersion, state: 'ready', podUid: 'fake-pod-uid', failure: null }))
        return
      }
      if (req.method === 'GET') {
        const session = sessions.get(sessionId)
        if (!session) {
          res.writeHead(404, { 'content-type': 'application/problem+json' })
          res.end(JSON.stringify({ type: 'about:blank', title: 'not materialized', status: 404, code: 'session_runtime_not_materialized' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            sessionId,
            agentId: session.agentId,
            runtimeDefinitionVersion: session.runtimeDefinitionVersion,
            state: 'ready',
            podUid: 'fake-pod-uid',
            failure: null,
          }),
        )
        return
      }
      if (req.method === 'DELETE') {
        dematerializeCalls.push(sessionId)
        const existed = sessions.delete(sessionId)
        res.writeHead(existed ? 202 : 204, { 'content-type': 'application/json' })
        res.end(existed ? JSON.stringify({ sessionId, agentId: '', runtimeDefinitionVersion: '', state: 'terminating', podUid: null, failure: null }) : '')
        return
      }
      res.writeHead(405)
      res.end()
    })()
  })
  await new Promise<void>((resolve) => controllerHttpServer.listen(0, resolve))
  const controllerPort = (controllerHttpServer.address() as { port: number }).port

  return {
    baseUrl: `http://127.0.0.1:${controllerPort}`,
    fetch,
    dematerializeCalls,
    async close() {
      for (const ws of openSockets) ws.terminate()
      await new Promise<void>((resolve) => controllerHttpServer.close(() => resolve()))
      await new Promise<void>((resolve) => agentHttpServer.close(() => resolve()))
    },
  }
}
