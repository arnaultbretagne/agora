import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { Duplex } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { createFakeAgent, type FakeAgentNativeState, type FakeAgentOptions } from '@agora/acp'
import { captureSnapshot } from '@agora/custody'
import type pg from 'pg'
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
  /** Test-only failure injection (plans/07 "Capture failure after successful Handoff preserves old durable Anchor"): when true, the next capture call fails without writing anything, then resets itself. */
  failNextCapture(): void
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

/** plans/06: a fake but real-enough (session-scoped, idempotent, restorable) custody snapshot — opaque to every caller exactly like the real one. */
interface FakeSnapshot {
  readonly snapshotId: string
  readonly sessionId: string
  readonly generation: number
  readonly captureRequestId: string
  readonly syncedThroughSeq: number
  readonly nativeState: FakeAgentNativeState | undefined
  readonly createdAt: string
}

/**
 * `pool`, when given, is only used to satisfy `custody.snapshots.session_id`/`product.agent_anchors`
 * foreign keys against the SAME test database `suspendSession`'s Anchor commit runs against — the
 * actual capture/restore byte transport (checksum, one-time credential, checksum-mismatch handling)
 * is proven for real at the controller level (apps/session-runtime-controller/test/server.test.ts);
 * this double only needs FK-satisfying rows plus session-scoped native-state continuity.
 */
export async function startFakeController(agentOptions: FakeAgentOptions = {}, pool?: pg.Pool): Promise<FakeControllerHandle> {
  // Per-Session native state, keyed by the sessionId carried in the minted WS URL — this is what
  // lets a suspend (WS closes) then resume (a NEW WS to the SAME session-scoped URL) actually
  // observe continuity, and what `custody-snapshots` captures / `restoreFrom` seeds.
  const sessionStates = new Map<string, { current: FakeAgentNativeState | undefined }>()
  const snapshotsByRequestId = new Map<string, FakeSnapshot>()
  const snapshotsById = new Map<string, FakeSnapshot>()

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
  wss.on('connection', (ws, req) => {
    openSockets.add(ws)
    ws.once('close', () => openSockets.delete(ws))
    const sessionId = new URL(req.url ?? '/', 'http://internal').searchParams.get('session') ?? ''
    const stateCell = sessionStates.get(sessionId) ?? { current: undefined }
    sessionStates.set(sessionId, stateCell)
    const duplex = createWebSocketStream(ws)
    const { readable, writable } = Duplex.toWeb(duplex)
    const wire = acp.ndJsonStream(writable as WritableStream<Uint8Array>, readable as ReadableStream<Uint8Array>)
    createFakeAgent({ ...agentOptions, nativeState: stateCell }).connect(wire)
  })
  await new Promise<void>((resolve) => agentHttpServer.listen(0, resolve))
  const agentPort = (agentHttpServer.address() as { port: number }).port

  const dematerializeCalls: string[] = []
  const sessions = new Map<string, { agentId: string; runtimeDefinitionVersion: string }>()
  let failNextCapture = false

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
              {
                // plans/07: a second, independent Agent identity for A-to-B-to-A cross-Agent tests —
                // functionally identical to 'fake-agent' (same WS handler), just a distinct agentId
                // so it gets its own Session/Anchor lane.
                agentId: 'fake-agent-b',
                runtimeDefinitionVersion: 'v1',
                label: 'Fake Agent B (tests)',
                description: 'A second deterministic in-process fake ACP Agent identity for cross-Agent tests.',
                availability: 'enabled',
              },
            ],
          }),
        )
        return
      }

      const match = /^\/v1\/sessions\/([^/]+)\/runtime(\/acp-connections|\/custody-snapshots)?$/.exec(url.pathname)
      if (!match?.[1]) {
        res.writeHead(404)
        res.end()
        return
      }
      const sessionId = match[1]
      const suffix = match[2] ?? ''

      if (suffix === '/acp-connections' && req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            transport: 'websocket',
            url: `ws://127.0.0.1:${agentPort}/?session=${encodeURIComponent(sessionId)}`,
            credential: 'fake-test-credential',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        )
        return
      }
      if (suffix === '/custody-snapshots' && req.method === 'POST') {
        if (failNextCapture) {
          failNextCapture = false
          res.writeHead(422, { 'content-type': 'application/problem+json' })
          res.end(JSON.stringify({ type: 'about:blank', title: 'injected capture failure', status: 422, code: 'capture_transport_failed' }))
          return
        }
        const requestId = req.headers['x-request-id']
        if (typeof requestId !== 'string') {
          res.writeHead(400)
          res.end()
          return
        }
        const body = await readJson(req)
        const syncedThroughSeq = Number(body['syncedThroughSeq'] ?? 0)
        const idempotencyKey = `${sessionId}:${requestId}`
        let snapshot = snapshotsByRequestId.get(idempotencyKey)
        if (!snapshot) {
          const priorGenerations = [...snapshotsById.values()].filter((s) => s.sessionId === sessionId).length
          const createdAt = new Date()
          snapshot = {
            snapshotId: randomUUID(),
            sessionId,
            generation: priorGenerations + 1,
            captureRequestId: requestId,
            syncedThroughSeq,
            nativeState: sessionStates.get(sessionId)?.current,
            createdAt: createdAt.toISOString(),
          }
          if (pool) {
            const client = await pool.connect()
            try {
              await captureSnapshot(client, {
                snapshotId: snapshot.snapshotId,
                sessionId: snapshot.sessionId,
                generation: snapshot.generation,
                captureRequestId: snapshot.captureRequestId,
                formatId: 'fake-test-format',
                formatVersion: '1',
                adapterVersion: '1',
                syncedThroughSeq: snapshot.syncedThroughSeq,
                payload: new TextEncoder().encode(JSON.stringify(snapshot.nativeState ?? {})),
                createdAt,
              })
            } finally {
              client.release()
            }
          }
          snapshotsByRequestId.set(idempotencyKey, snapshot)
          snapshotsById.set(snapshot.snapshotId, snapshot)
        }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            snapshotId: snapshot.snapshotId,
            sessionId: snapshot.sessionId,
            generation: snapshot.generation,
            captureRequestId: snapshot.captureRequestId,
            formatId: 'fake-test-format',
            formatVersion: '1',
            adapterVersion: '1',
            syncedThroughSeq: snapshot.syncedThroughSeq,
            sha256: '0'.repeat(64),
            sizeBytes: 0,
            createdAt: snapshot.createdAt,
          }),
        )
        return
      }
      if (suffix === '' && req.method === 'PUT') {
        const body = await readJson(req)
        const agentId = String(body['agentId'] ?? '')
        const runtimeDefinitionVersion = String(body['runtimeDefinitionVersion'] ?? '')
        const restoreFrom = typeof body['restoreFrom'] === 'string' ? body['restoreFrom'] : undefined
        if (restoreFrom) {
          const snapshot = snapshotsById.get(restoreFrom)
          if (!snapshot) {
            res.writeHead(409, { 'content-type': 'application/problem+json' })
            res.end(JSON.stringify({ type: 'about:blank', title: 'unknown snapshot', status: 409, code: 'custody_snapshot_not_found' }))
            return
          }
          // Restore-before-start, faithfully enough: the next WS connection for this Session
          // starts from the restored state rather than empty (the real restore-stream transport
          // itself is proven at the controller level, apps/session-runtime-controller/test).
          sessionStates.set(sessionId, { current: snapshot.nativeState })
        }
        sessions.set(sessionId, { agentId, runtimeDefinitionVersion })
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ sessionId, agentId, runtimeDefinitionVersion, state: 'ready', podUid: 'fake-pod-uid', failure: null }))
        return
      }
      if (suffix === '' && req.method === 'GET') {
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
    failNextCapture() {
      failNextCapture = true
    },
    async close() {
      for (const ws of openSockets) ws.terminate()
      await new Promise<void>((resolve) => controllerHttpServer.close(() => resolve()))
      await new Promise<void>((resolve) => agentHttpServer.close(() => resolve()))
    },
  }
}
