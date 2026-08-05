import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createWebSocketStream, WebSocketServer } from 'ws'
import {
  captureNativeState,
  CODEX_NATIVE_FORMAT_ID,
  CODEX_NATIVE_FORMAT_VERSION,
  CustodyCaptureError,
  restoreNativeState,
} from './custody.js'
import { watchForSessionId } from './session-id-tap.js'

/**
 * The container entrypoint `packages/agent-registry`'s `codex` runtime definition names — same
 * seam as `agents/claude-code/src/bridge-server.ts`, adapted for `@agentclientprotocol/codex-acp`.
 * Spawns a fresh child on every WebSocket connection, same pattern established there (and in
 * `fake-agent-server.ts`) — no reason to assume codex-acp's own idle behavior differs from
 * claude-agent-acp's without re-proving it, so this design is kept rather than re-litigated.
 *
 * `agents/codex/SPIKE.md`: the child needs `HTTPS_PROXY`/`SSL_CERT_FILE` (codex is a Rust binary —
 * `SSL_CERT_FILE` is the one it actually reads; `NODE_EXTRA_CA_CERTS` is set too for defensive
 * belt-and-suspenders, likely inert) specifically, but `pod-spec.ts` mounts Agora's own GENERIC
 * contract (`AGORA_BROKER_RELAY_ENDPOINT`, `AGORA_ONECLI_CA_PATH`, a stub directory — the same
 * shape every harness gets). Translating that generic contract into what THIS specific harness
 * needs is this image's own job (`childEnv` below).
 *
 * Unlike Claude Code (a placeholder OAuth token in an ENV VAR), codex-acp reads its credential from
 * a FILE (`$HOME/.codex/auth.json`), and — found live in the spike — validates its `id_token` as a
 * real JWT locally before ever touching the network. `ensureCodexAuthStub` below writes a fixed,
 * non-secret, structurally-valid-but-never-functional placeholder there before every spawn — the
 * harness image's own deterministic construction, not something an operator populates (unlike
 * Claude's simple string marker, this one has real internal shape requirements codex validates).
 */
export interface BridgeServerOptions {
  readonly port?: number
  /** Defaults to the real, npm-installed `codex-acp` binary. Overridable so tests can spawn a
   * lightweight stub ACP process instead of requiring live ChatGPT credentials. */
  readonly agentCommand?: readonly string[]
  readonly homeDir?: string
  readonly restore?: { readonly url: string; readonly credential: string } | undefined
  /** Defaults to translating `pod-spec.ts`'s generic `AGORA_*` env contract into what `codex-acp`
   * needs (`codexSpecificEnv`). Overridable so tests can spawn a stub agent that doesn't need any
   * of that translated. */
  readonly childEnv?: Record<string, string | undefined>
  /** Defaults to `process.env.AGORA_WORKSPACE_ROOT` (`pod-spec.ts`'s own fixed, writable mount).
   * Overridable for tests. */
  readonly cwd?: string
}

export interface RunningBridgeServer {
  readonly server: Server
  readonly port: number
  close(): Promise<void>
}

const DEFAULT_HOME = process.env.HOME ?? '/home/node'

async function defaultAgentCommand(): Promise<readonly string[]> {
  // Same robust resolution as `agents/claude-code`'s own fix: read the package's own "bin" field
  // from its package.json rather than assuming `import.meta.resolve`'s "main"/"exports" entry is
  // the runnable CLI (it happens to coincide here — codex-acp's package.json has `main` and `bin`
  // both pointing at `dist/index.js` — but resolving "bin" explicitly doesn't depend on that
  // coincidence holding across future versions).
  const packageJsonPath = fileURLToPath(import.meta.resolve('@agentclientprotocol/codex-acp/package.json'))
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { bin: string | Record<string, string> }
  const binRelative = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin['codex-acp']
  if (!binRelative) throw new Error("@agentclientprotocol/codex-acp's package.json names no 'codex-acp' bin entry")
  const entry = join(dirname(packageJsonPath), binRelative)
  return [process.execPath, entry]
}

// Matches `pod-spec.ts`'s own constants exactly — this file does not invent these paths, only
// consumes them.
const RELAY_ENDPOINT_ENV = 'AGORA_BROKER_RELAY_ENDPOINT'
const ONECLI_CA_PATH_ENV = 'AGORA_ONECLI_CA_PATH'
const AUTH_STUBS_DIR_ENV = 'AGORA_ONECLI_STUBS_DIR'

/**
 * Translates Agora's generic per-Pod contract (`pod-spec.ts`'s own env/mount names, identical
 * across every harness) into exactly what `codex-acp`/the real `codex` binary read. Never touches
 * an upstream OneCLI bearer or a real provider credential — the relay endpoint carries no embedded
 * bearer (workload identity authenticates it, not a URL userinfo — `relay.ts`'s own design).
 * `AUTH_STUBS_DIR_ENV` is still required (fails closed if missing, matching every other harness's
 * contract) even though nothing is read FROM it here — `ensureCodexAuthStub` writes the actual
 * credential-shaped placeholder straight to `$HOME/.codex/auth.json`, deterministically, needing no
 * externally-supplied stub content (see this module's own doc comment for why).
 */
export function codexSpecificEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const relayEndpoint = env[RELAY_ENDPOINT_ENV]
  const caPath = env[ONECLI_CA_PATH_ENV]
  const stubsDir = env[AUTH_STUBS_DIR_ENV]
  if (!relayEndpoint || !caPath || !stubsDir) {
    throw new Error(`missing one of ${RELAY_ENDPOINT_ENV}/${ONECLI_CA_PATH_ENV}/${AUTH_STUBS_DIR_ENV} in the Pod's own environment`)
  }
  return {
    HTTPS_PROXY: relayEndpoint,
    HTTP_PROXY: relayEndpoint,
    SSL_CERT_FILE: caPath,
    NODE_EXTRA_CA_CERTS: caPath,
    // Found in codex-acp's own README: hides the interactive browser-based ChatGPT-login auth
    // method — this harness never uses it (auth is the OneCLI gateway substitution below), and a
    // headless Pod has no browser to hide it FROM in the first place, but this is the documented
    // belt-and-suspenders switch, matching Claude's own `--dangerously-skip-permissions` posture.
    NO_BROWSER: '1',
    // codex-acp's own default per the spike (never set explicitly, observed `currentModeId:
    // "agent"`) — set explicitly rather than relying on an implicit default that could change.
    // NOT verified against a real tool call in the spike (every canary prompt was pure
    // conversation, no file edit or shell command was ever triggered) — genuine gap, called out in
    // `agents/codex/SPIKE.md` and this plan's own Evidence, not silently assumed safe.
    INITIAL_AGENT_MODE: 'agent',
  }
}

/** codex-acp validates its credential file's `id_token` as a real JWT locally before ever touching
 * the network (found live in the spike: a bare placeholder string fails this check before any
 * request is attempted). This constructs a structurally-valid-but-inert one (`alg: "none"`, no real
 * signature) the exact same way the spike's own verification script did — fixed, non-secret,
 * deterministic, never functional on its own; the real credential substitution happens entirely at
 * the OneCLI gateway, keyed off the linked account, not off anything in this file's content. */
export async function ensureCodexAuthStub(homeDir: string): Promise<void> {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: 'onecli-managed', email: 'onecli-managed@example.invalid' })).toString('base64url')
  const placeholderIdToken = `${header}.${payload}.`
  const authJson = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: placeholderIdToken,
      access_token: 'onecli-managed',
      refresh_token: 'onecli-managed',
      account_id: '00000000-0000-0000-0000-000000000000',
    },
    last_refresh: new Date(0).toISOString(),
  }
  const codexDir = join(homeDir, '.codex')
  await mkdir(codexDir, { recursive: true })
  await writeFile(join(codexDir, 'auth.json'), JSON.stringify(authJson))
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
  if (formatId && formatId !== CODEX_NATIVE_FORMAT_ID) {
    throw new Error(`custody restore format mismatch: this Agent only reads '${CODEX_NATIVE_FORMAT_ID}', got '${formatId}'`)
  }
  return bytes
}

/** Splits a byte stream into newline-delimited frames — same shape as `agents/claude-code`'s own,
 * minimal here since this tap only reads, it never needs to reassemble for replay. */
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

/** Spawns one fresh Agent process. Logs its exit for the life of the Pod. `detached: true` on
 * Linux makes the child its own process group leader — required so `killAgentTree` below can kill
 * it AND the native `codex` process it launches in one shot (same finding `agents/claude-code`
 * made live: a plain `child.kill()` leaves the native process orphaned). */
function spawnAgent(agentCommand: readonly string[], childEnv: Record<string, string | undefined>, cwd: string | undefined): ChildProcessWithoutNullStreams {
  const [command, ...args] = agentCommand
  if (!command) throw new Error('agentCommand must name an executable')
  const child = spawn(command, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true, ...(cwd ? { cwd } : {}) })
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  child.on('error', (error) => {
    process.stderr.write(`codex bridge-server: agent process failed to start: ${String(error)}\n`)
  })
  child.on('exit', (code, signal) => {
    process.stderr.write(`codex bridge-server: agent process exited (code=${code}, signal=${signal})\n`)
  })
  return child
}

/** Kills the Agent process's whole process group (see `spawnAgent`'s own doc). Falls back to a
 * plain `child.kill()` if the group is already gone (ESRCH) or `pid` was never assigned. */
function killAgentTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
      return
    } catch {
      // Group already gone, or this platform doesn't support negative-pid group kill — fall through.
    }
  }
  child.kill()
}

/**
 * Starts the bridge's HTTP+WS listener. Performs restore-before-ready and never opens the listener
 * if that restore fails — same fail-closed contract as `fake-agent-server.ts`'s own
 * `startFakeAgentServer`. The Agent process itself is NOT spawned here — only on each WS
 * connection, below (see this module's own doc comment).
 */
export async function startBridgeServer(options: BridgeServerOptions = {}): Promise<RunningBridgeServer> {
  const homeDir = options.homeDir ?? DEFAULT_HOME
  const sessionIdCell: { current: string | undefined } = { current: undefined }

  if (options.restore) {
    const bytes = await pullRestoreBytes(options.restore)
    const { sessionId } = await restoreNativeState(homeDir, bytes)
    sessionIdCell.current = sessionId
  }

  const agentCommand = options.agentCommand ?? (await defaultAgentCommand())
  const childEnv = options.childEnv ?? { ...process.env, ...codexSpecificEnv(process.env) }
  const childCwd = options.cwd ?? process.env.AGORA_WORKSPACE_ROOT
  if (!options.childEnv) await ensureCodexAuthStub(homeDir)

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
            'x-agora-format-id': CODEX_NATIVE_FORMAT_ID,
            'x-agora-format-version': CODEX_NATIVE_FORMAT_VERSION,
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

    ws.once('close', () => {
      liveChildren.delete(child)
      killAgentTree(child)
    })
  })

  await new Promise<void>((resolve) => httpServer.listen(options.port ?? 0, resolve))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    server: httpServer,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const child of liveChildren) killAgentTree(child)
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
      process.stdout.write(`codex bridge-server listening on :${running.port}\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`codex bridge-server: startup failed, exiting: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
