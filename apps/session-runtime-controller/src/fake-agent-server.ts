import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { Duplex } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { createFakeAgent, type FakeAgentNativeState } from '@agora/acp'
import { createWebSocketStream, WebSocketServer } from 'ws'

/**
 * The container entrypoint named by `FAKE_AGENT_DEFINITION.acpCommand`
 * (packages/agent-registry/src/fake-definition.ts) — wraps `@agora/acp`'s deterministic fake Agent
 * behind the `bridge.transport: 'websocket'` listener the Pod's `bridge.listenPort` declares, plus
 * the `/healthz` the PodSpec's readinessProbe checks (docs/specs/08). This process never runs
 * inside the controller; it is the OTHER end of the connection `openACPConnection` mints bridge
 * credentials for.
 *
 * docs/specs/07-custody.md "Restore contract" step 7 ("starts the ACP Agent only after restore
 * succeeds"): when `AGORA_CUSTODY_RESTORE_URL` is set, this process pulls its native state from the
 * controller (Pod-initiated, one-time-credentialed — this process holds no database credentials of
 * its own) and seeds it BEFORE opening the WebSocket/`/healthz` listener at all. A restore failure
 * never opens for readiness; it exits non-zero, which — combined with the Pod's
 * `restartPolicy: Never` — lands the Pod in `Failed` phase, which `reconciler.ts#deriveState`
 * already reports as `state: 'failed'` with no new reconciler logic required.
 */

export const FAKE_NATIVE_FORMAT_ID = 'agora-fake-native'
export const FAKE_NATIVE_FORMAT_VERSION = '1'

export function encodeFakeNativeState(state: FakeAgentNativeState): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(state))
}

export function decodeFakeNativeState(bytes: Uint8Array): FakeAgentNativeState {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { acpSessionId?: unknown }).acpSessionId !== 'string' ||
    typeof (parsed as { promptsSeen?: unknown }).promptsSeen !== 'number' ||
    !Array.isArray((parsed as { lastMessages?: unknown }).lastMessages)
  ) {
    throw new Error('restored bytes do not decode to a valid FakeAgentNativeState')
  }
  return parsed as FakeAgentNativeState
}

export interface FakeAgentServerOptions {
  readonly port?: number
  /** Pod-initiated pull: fetched and applied before the server ever listens. */
  readonly restore?: { readonly url: string; readonly credential: string } | undefined
}

export interface RunningFakeAgentServer {
  readonly server: Server
  readonly port: number
  close(): Promise<void>
}

async function pullRestoreState(restore: { readonly url: string; readonly credential: string }): Promise<FakeAgentNativeState> {
  const response = await fetch(restore.url, { headers: { authorization: `Bearer ${restore.credential}` } })
  if (!response.ok) throw new Error(`custody restore stream returned ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())

  const expectedSha256 = response.headers.get('x-agora-sha256')
  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  if (expectedSha256 && expectedSha256 !== actualSha256) {
    throw new Error(`custody restore checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`)
  }

  const formatId = response.headers.get('x-agora-format-id')
  if (formatId && formatId !== FAKE_NATIVE_FORMAT_ID) {
    throw new Error(`custody restore format mismatch: this Agent only reads '${FAKE_NATIVE_FORMAT_ID}', got '${formatId}'`)
  }

  return decodeFakeNativeState(bytes)
}

/**
 * Starts the fake Agent's HTTP+WS listener. Performs restore-before-ready (per `options.restore`)
 * and never opens the listener if that restore fails — callers (the real container entrypoint, or
 * a test standing in for a Pod) observe a rejected Promise instead of a listening server.
 */
export async function startFakeAgentServer(options: FakeAgentServerOptions = {}): Promise<RunningFakeAgentServer> {
  const stateCell: { current: FakeAgentNativeState | undefined } = { current: undefined }

  if (options.restore) {
    // docs/specs/07 step 6: "prevents overwrite of unexpected pre-existing native state" — a
    // freshly started process has none, so this is a defensive assertion, not a real guard today.
    if (stateCell.current) throw new Error('custody restore attempted on a Pod that already has native state')
    stateCell.current = await pullRestoreState(options.restore)
  }

  const httpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    if (req.method === 'GET' && req.url === '/custody') {
      const bytes = encodeFakeNativeState(
        stateCell.current ?? { acpSessionId: '', promptsSeen: 0, lastMessages: [] },
      )
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'x-agora-format-id': FAKE_NATIVE_FORMAT_ID,
        'x-agora-format-version': FAKE_NATIVE_FORMAT_VERSION,
        'x-agora-sha256': createHash('sha256').update(bytes).digest('hex'),
      })
      res.end(Buffer.from(bytes))
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
    createFakeAgent({ nativeState: stateCell, ...(stateCell.current ? { acpSessionId: stateCell.current.acpSessionId } : {}) }).connect(wire)
  })

  await new Promise<void>((resolve) => httpServer.listen(options.port ?? 0, resolve))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    server: httpServer,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close(() => {})
        httpServer.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href

if (isMain) {
  const port = Number(process.env.PORT ?? 8080)
  const restoreUrl = process.env.AGORA_CUSTODY_RESTORE_URL
  const restoreCredential = process.env.AGORA_CUSTODY_RESTORE_CREDENTIAL
  const restore = restoreUrl && restoreCredential ? { url: restoreUrl, credential: restoreCredential } : undefined

  startFakeAgentServer({ port, restore })
    .then((running) => {
      process.stdout.write(`fake-agent-server listening on :${running.port}\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`fake-agent-server: restore failed, exiting: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
