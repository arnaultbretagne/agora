import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createWebSocketStream, WebSocketServer } from 'ws'
import {
  captureNativeState,
  CLAUDE_NATIVE_FORMAT_ID,
  CLAUDE_NATIVE_FORMAT_VERSION,
  CustodyCaptureError,
  restoreNativeState,
} from './custody.js'
import { watchForSessionId } from './session-id-tap.js'

/**
 * The container entrypoint `packages/agent-registry`'s `claude-code` runtime definition names —
 * same seam as `apps/session-runtime-controller/src/fake-agent-server.ts`, adapted for a REAL
 * external ACP Agent process (`@agentclientprotocol/claude-agent-acp`) instead of an in-process
 * fake. Spawns a fresh child LAZILY on every WebSocket connection (same pattern
 * `fake-agent-server.ts` already uses, `createFakeAgent()` per connection) — NOT eagerly at
 * startup. Found live, on a real cluster: the real Agent process exits cleanly (`code=0`, no
 * stderr) if it sits idle for even a few seconds without receiving its first real ACP request —
 * spawning it at Pod startup and only later opening a WS connection (the real gap between
 * readiness and the controller's own `openACPConnection` call) reliably lost the race. Spawning at
 * connection time means its first bytes arrive within milliseconds, matching every case that
 * worked in the original spike. This does not weaken "one Session Runtime Pod = one Agora Session"
 * (docs/specs/08): in production exactly one real connection is ever opened per Pod; native state
 * lives on disk (`custody.ts`), not in the process, so even a reconnect after credential expiry
 * (docs/specs/04) is safe — a fresh child resuming from that same file is the exact same
 * "kill + fresh process + session/resume" path already proven to preserve context.
 *
 * `agents/claude-code/SPIKE.md`: the child needs `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS`/
 * `CLAUDE_CODE_OAUTH_TOKEN` specifically, but `pod-spec.ts` mounts Agora's own GENERIC contract
 * (`AGORA_BROKER_RELAY_ENDPOINT`, `AGORA_ONECLI_CA_PATH`, a stub directory — the same shape every
 * harness gets, verified live against a real value for the CA/relay pieces). Translating that
 * generic contract into what THIS specific harness needs is this image's own job (`childEnv`
 * below) — nothing OneCLI- or credential-specific is invented here, only read and renamed.
 */
export interface BridgeServerOptions {
  readonly port?: number
  /** Defaults to the real, npm-installed `claude-agent-acp` binary. Overridable so tests can spawn
   * a lightweight stub ACP process instead of requiring live Claude Max credentials. */
  readonly agentCommand?: readonly string[]
  readonly homeDir?: string
  readonly restore?: { readonly url: string; readonly credential: string } | undefined
  /** Defaults to translating `pod-spec.ts`'s generic `AGORA_*` env contract into what
   * `claude-agent-acp` needs (`claudeSpecificEnv`). Overridable so tests can spawn a stub agent
   * that doesn't need any of that translated. */
  readonly childEnv?: Record<string, string | undefined>
  /** Defaults to `process.env.AGORA_WORKSPACE_ROOT` (`pod-spec.ts`'s own fixed, writable mount) —
   * the real Agent needs a writable cwd to start at all (found live: it otherwise silently
   * `exit(0)`s with no stderr). Overridable for tests. */
  readonly cwd?: string
}

export interface RunningBridgeServer {
  readonly server: Server
  readonly port: number
  close(): Promise<void>
}

const DEFAULT_HOME = process.env.HOME ?? '/home/node'

function defaultAgentCommand(): readonly string[] {
  // Real Node module resolution (not a hardcoded relative path) — npm workspaces hoist this
  // package to the monorepo root's node_modules in normal installs, so a path fixed relative to
  // this file's own directory is wrong there (verified live: the image build's smoke-test caught
  // exactly this). `import.meta.resolve` walks the same lookup Node itself would.
  const entry = fileURLToPath(import.meta.resolve('@agentclientprotocol/claude-agent-acp'))
  return [process.execPath, entry, '--dangerously-skip-permissions']
}

// Matches `pod-spec.ts`'s own constants exactly — this file does not invent these paths, only
// consumes them. The stub file's own name is this harness's own choice (an operator deploying
// `RelayBundle.authStubs` must set a matching key) — no other harness needs to agree on it.
const RELAY_ENDPOINT_ENV = 'AGORA_BROKER_RELAY_ENDPOINT'
const ONECLI_CA_PATH_ENV = 'AGORA_ONECLI_CA_PATH'
const AUTH_STUBS_DIR_ENV = 'AGORA_ONECLI_STUBS_DIR'
const OAUTH_STUB_FILENAME = 'claude-code-oauth-token'

/**
 * Translates Agora's generic per-Pod contract (`pod-spec.ts`'s own env/mount names, identical
 * across every harness) into exactly what `claude-agent-acp`/the real `claude` CLI read. Never
 * touches an upstream OneCLI bearer or a real provider credential — the relay endpoint carries no
 * embedded bearer (workload identity authenticates it, not a URL userinfo — `relay.ts`'s own
 * design), and the OAuth stub is the same fixed, non-secret placeholder every Session gets.
 */
export async function claudeSpecificEnv(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const relayEndpoint = env[RELAY_ENDPOINT_ENV]
  const caPath = env[ONECLI_CA_PATH_ENV]
  const stubsDir = env[AUTH_STUBS_DIR_ENV]
  if (!relayEndpoint || !caPath || !stubsDir) {
    throw new Error(`missing one of ${RELAY_ENDPOINT_ENV}/${ONECLI_CA_PATH_ENV}/${AUTH_STUBS_DIR_ENV} in the Pod's own environment`)
  }
  const stubPath = `${stubsDir}/${OAUTH_STUB_FILENAME}`
  let oauthPlaceholder: string
  try {
    oauthPlaceholder = (await readFile(stubPath, 'utf8')).trim()
  } catch (error) {
    throw new Error(`could not read the OneCLI auth stub at ${stubPath}: ${String(error)}`)
  }
  return {
    HTTPS_PROXY: relayEndpoint,
    HTTP_PROXY: relayEndpoint,
    NODE_EXTRA_CA_CERTS: caPath,
    CLAUDE_CODE_OAUTH_TOKEN: oauthPlaceholder,
  }
}

async function pullRestoreBytes(restore: { readonly url: string; readonly credential: string }): Promise<Uint8Array> {
  const response = await fetch(restore.url, { headers: { authorization: `Bearer ${restore.credential}` } })
  if (!response.ok) throw new Error(`custody restore stream returned ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())

  const expectedSha256 = response.headers.get('x-agora-sha256')
  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  if (expectedSha256 && expectedSha256 !== actualSha256) {
    throw new Error(`custody restore checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`)
  }
  const formatId = response.headers.get('x-agora-format-id')
  if (formatId && formatId !== CLAUDE_NATIVE_FORMAT_ID) {
    throw new Error(`custody restore format mismatch: this Agent only reads '${CLAUDE_NATIVE_FORMAT_ID}', got '${formatId}'`)
  }
  return bytes
}

/** Splits a byte stream into newline-delimited frames — same shape as `packages/acp`'s own spike
 * NDJSON buffering, minimal here since this tap only reads, it never needs to reassemble for replay. */
function ndjsonFrames(onFrame: (frame: Uint8Array) => void): (chunk: Uint8Array) => void {
  let pending = new Uint8Array(0)
  return (chunk: Uint8Array) => {
    const merged = new Uint8Array(pending.byteLength + chunk.byteLength)
    merged.set(pending)
    merged.set(chunk, pending.byteLength)
    let start = 0
    for (let i = 0; i < merged.byteLength; i += 1) {
      if (merged[i] === 0x0a) {
        onFrame(merged.slice(start, i + 1))
        start = i + 1
      }
    }
    pending = merged.slice(start)
  }
}

function bridgeChildStdio(
  child: ChildProcessWithoutNullStreams,
  onSessionId: (sessionId: string) => void,
): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
  const tap = watchForSessionId(onSessionId)
  const splitAgentFrames = ndjsonFrames(tap.observeAgentToClient)
  const splitClientFrames = ndjsonFrames(tap.observeClientToAgent)

  let closed = false
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout.on('data', (chunk: Buffer) => {
        splitAgentFrames(new Uint8Array(chunk))
        if (!closed) controller.enqueue(new Uint8Array(chunk))
      })
      child.stdout.on('end', () => {
        if (!closed) {
          closed = true
          controller.close()
        }
      })
    },
    cancel() {
      closed = true
    },
  })
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      splitClientFrames(chunk)
      child.stdin.write(chunk)
    },
    close() {
      child.stdin.end()
    },
  })
  return { readable, writable }
}

/** Spawns one fresh Agent process. Logs its exit for the life of the Pod (previously invisible:
 * `/healthz` only ever checks the bridge itself, so a dead child left every subsequent request
 * hanging silently — found live, on a real cluster, not by inspection). */
function spawnAgent(agentCommand: readonly string[], childEnv: Record<string, string | undefined>, cwd: string | undefined): ChildProcessWithoutNullStreams {
  const [command, ...args] = agentCommand
  if (!command) throw new Error('agentCommand must name an executable')
  const child = spawn(command, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) })
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  child.on('error', (error) => {
    process.stderr.write(`claude-code bridge-server: agent process failed to start: ${String(error)}\n`)
  })
  child.on('exit', (code, signal) => {
    process.stderr.write(`claude-code bridge-server: agent process exited (code=${code}, signal=${signal})\n`)
  })
  return child
}

/**
 * Starts the bridge's HTTP+WS listener. Performs restore-before-ready and never opens the listener
 * if that restore fails — same fail-closed contract as `fake-agent-server.ts`'s own
 * `startFakeAgentServer`. The Agent process itself is NOT spawned here (see this module's own doc
 * comment) — only on each WS connection, below.
 */
export async function startBridgeServer(options: BridgeServerOptions = {}): Promise<RunningBridgeServer> {
  const homeDir = options.homeDir ?? DEFAULT_HOME
  const sessionIdCell: { current: string | undefined } = { current: undefined }

  if (options.restore) {
    const bytes = await pullRestoreBytes(options.restore)
    const { sessionId } = await restoreNativeState(homeDir, bytes)
    sessionIdCell.current = sessionId
  }

  const agentCommand = options.agentCommand ?? defaultAgentCommand()
  const childEnv = options.childEnv ?? { ...process.env, ...(await claudeSpecificEnv(process.env)) }
  // Found live, on a real cluster: without an explicit `cwd`, the child inherits THIS process's
  // own — the image's build-time WORKDIR, root-owned and read-only to the non-root user every
  // Session Runtime Pod actually runs as. The real Agent needs a writable directory to even start
  // (silently `exit(0)`, no stderr, when it doesn't get one) — `AGORA_WORKSPACE_ROOT`
  // (`pod-spec.ts`'s own fixed, PVC-backed mount) is exactly that.
  const childCwd = options.cwd ?? process.env.AGORA_WORKSPACE_ROOT

  const httpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    if (req.method === 'GET' && req.url === '/custody') {
      const sessionId = sessionIdCell.current
      if (!sessionId) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('no ACP session has been opened on this Pod yet')
        return
      }
      captureNativeState(homeDir, sessionId)
        .then(({ bytes, sha256 }) => {
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.length),
            'x-agora-format-id': CLAUDE_NATIVE_FORMAT_ID,
            'x-agora-format-version': CLAUDE_NATIVE_FORMAT_VERSION,
            'x-agora-sha256': sha256,
            'x-agora-native-session-id': sessionId,
          })
          res.end(Buffer.from(bytes))
        })
        .catch((error: unknown) => {
          const status = error instanceof CustodyCaptureError ? 404 : 500
          res.writeHead(status, { 'content-type': 'text/plain' })
          res.end(error instanceof Error ? error.message : String(error))
        })
      return
    }
    res.writeHead(404)
    res.end()
  })

  const liveChildren = new Set<ChildProcessWithoutNullStreams>()
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws) => {
    // The WS protocol upgrade already completed by the time this handler runs — a spawn failure
    // can only ever close the connection afterward, never prevent 'open' on the client side.
    // `spawn()` itself never throws synchronously for a bad command (ENOENT surfaces async via
    // 'error') — found live, chasing exactly this: a broken agentCommand silently left the
    // connection open forever instead of closing it. `once` (not `on`) because either 'error' or
    // 'exit' alone is enough to know the child is unusable; the other must not double-close `ws`.
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnAgent(agentCommand, childEnv, childCwd)
    } catch (error) {
      ws.close(1011, error instanceof Error ? error.message : String(error))
      return
    }
    liveChildren.add(child)
    let bridged = false
    const failClosed = (detail: string) => {
      liveChildren.delete(child)
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1011, detail)
    }
    child.once('error', (error) => failClosed(`agent process failed to start: ${String(error)}`))
    child.once('exit', (code, signal) => {
      liveChildren.delete(child)
      // Once the pipes below are wired, an exit is ordinary connection teardown, not a startup
      // failure to report — `bridged` is scoped to THIS connection's own child, unlike
      // `sessionIdCell`, which is shared across the whole Pod's lifetime.
      if (!bridged) failClosed(`agent process exited before it was ready (code=${code}, signal=${signal})`)
    })

    const duplex = createWebSocketStream(ws)
    const { readable: clientReadable, writable: clientWritable } = Duplex.toWeb(duplex)
    const { readable: agentReadable, writable: agentWritable } = bridgeChildStdio(child, (sessionId) => {
      sessionIdCell.current = sessionId
    })
    bridged = true
    void (clientReadable as ReadableStream<Uint8Array>).pipeTo(agentWritable).catch(() => {})
    void agentReadable.pipeTo(clientWritable as WritableStream<Uint8Array>).catch(() => {})
  })

  await new Promise<void>((resolve) => httpServer.listen(options.port ?? 0, resolve))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    server: httpServer,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const child of liveChildren) child.kill()
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

  startBridgeServer({ port, restore })
    .then((running) => {
      process.stdout.write(`claude-code bridge-server listening on :${running.port}\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`claude-code bridge-server: startup failed, exiting: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
