// S9 Step 2 acceptance: the custody driver round-trip on the REAL adapter. Not a unit test — it
// spends two real model calls, so it is run deliberately:
//
//   npm run build -w @agora/harness-claude-code
//   ADAPTER_PATH=<path to claude-agent-acp/dist/index.js> node measure/custody-round-trip.mjs
//
//   home A: session/new -> plant a codeword (one real model call) -> SIGKILL the process
//   capture: ClaudeCodeCustodyDriver.capture() over home A
//   home B: a FRESH home with no projects/ at all -> driver.restore() -> session/resume
//   -> ask for the codeword back (one real model call)
//
// If the codeword comes back, the one file the driver captured is genuinely sufficient for native
// continuity across a process death AND a different home. Two model calls total, both deliberate.
import { spawn } from 'node:child_process'
import { mkdir, cp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as acp from '@agentclientprotocol/sdk'
import { ClaudeCodeCustodyDriver, transcriptPath } from '../dist/src/driver.js'

const ROOT = process.env.ROUND_TRIP_ROOT ?? join(tmpdir(), 'agora-custody-round-trip')
const HOME_A = join(ROOT, 'home-a')
const HOME_B = join(ROOT, 'home-b')
const WORKSPACE_ROOT = join(ROOT, 'work')
const CODEWORD = 'MIRABELLE-7241'
// The ambient credential, copied into each throwaway home. It is the ONE thing the driver never
// captures, so the experiment has to supply it separately — which is the exclusion, demonstrated.
const CREDENTIALS = process.env.CREDENTIALS_PATH ?? join(process.env.HOME ?? '', '.claude', '.credentials.json')
// The adapter's BIN entry, never the bare specifier: resolving the package lands on the
// library main, which exits cleanly without serving ACP (findings §2.2).
const ADAPTER = process.env.ADAPTER_PATH ?? '/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'

const toReadable = (s) =>
  new ReadableStream({
    start(controller) {
      s.on('data', (c) => controller.enqueue(new Uint8Array(c)))
      s.on('end', () => controller.close())
      s.on('error', (e) => controller.error(e))
    },
  })
const toWritable = (s) => new WritableStream({ write: (c) => new Promise((res, rej) => s.write(Buffer.from(c), (e) => (e ? rej(e) : res()))) })

function connect(home, name, onText) {
  const child = spawn('node', [ADAPTER], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') },
    cwd: WORKSPACE_ROOT,
  })
  const app = acp.client({ name })
  app.onNotification(acp.methods.client.session.update, (n) => {
    const update = n?.params?.update ?? n?.update
    const text = update?.content?.text
    if (typeof text === 'string' && onText) onText(text)
  })
  const conn = app.connect(acp.ndJsonStream(toWritable(child.stdin), toReadable(child.stdout)))
  return { child, conn }
}

const initializeParams = {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  cwd: WORKSPACE_ROOT,
  mcpServers: [],
}

async function main() {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(WORKSPACE_ROOT, { recursive: true })
  // Both homes get ONLY the credential — no projects/, no settings, no installation state. That is
  // the driver's own exclusion list, applied to the experiment itself.
  for (const home of [HOME_A, HOME_B]) {
    await mkdir(join(home, '.claude'), { recursive: true })
    await cp(CREDENTIALS, join(home, '.claude', '.credentials.json'))
  }

  // ---- home A: plant the codeword -------------------------------------------------------------
  const a = connect(HOME_A, 'round-trip-a')
  await a.conn.agent.request(acp.methods.agent.initialize, initializeParams)
  const created = await a.conn.agent.request(acp.methods.agent.session.new, { cwd: WORKSPACE_ROOT, mcpServers: [] })
  const contextId = created.sessionId
  console.log(`context: ${contextId}`)

  const planted = await a.conn.agent.request(acp.methods.agent.session.prompt, {
    sessionId: contextId,
    prompt: [{ type: 'text', text: `Remember this codeword for later: ${CODEWORD}. Reply with exactly: OK` }],
  })
  console.log(`plant stopReason: ${planted.stopReason}`)

  const expected = transcriptPath({ harnessHome: HOME_A, workspaceRoot: WORKSPACE_ROOT, contextId })
  console.log(`driver expects the transcript at: ${expected}`)
  console.log(`it is there: ${await stat(expected).then(() => true, () => false)}`)

  // The process dies with no warning — exactly the case a Save exists for.
  a.child.kill('SIGKILL')
  await new Promise((resolve) => a.child.on('exit', resolve))
  console.log('home A adapter killed')

  // ---- capture ---------------------------------------------------------------------------------
  const driverA = new ClaudeCodeCustodyDriver({ harnessHome: HOME_A, workspaceRoot: WORKSPACE_ROOT })
  const captureStarted = Date.now()
  const captured = await driverA.capture({ podUid: 'measured-pod', processGeneration: 0, contextId })
  const captureMs = Date.now() - captureStarted
  console.log(`captured ${captured.byteLength ?? captured.bytes.byteLength} bytes in ${captureMs}ms, checksum ${captured.checksum}`)
  console.log(`payload carries the credential: ${new TextDecoder().decode(captured.bytes).includes('sk-ant') || new TextDecoder().decode(captured.bytes).includes('oauth')}`)

  // ---- home B: restore into a home that has never seen this context ----------------------------
  const driverB = new ClaudeCodeCustodyDriver({ harnessHome: HOME_B, workspaceRoot: WORKSPACE_ROOT })
  const restoreStarted = Date.now()
  const placement = await driverB.restore(captured.bytes)
  const restoreMs = Date.now() - restoreStarted
  console.log(`restored to ${placement.path} in ${restoreMs}ms`)

  const replies = []
  const b = connect(HOME_B, 'round-trip-b', (text) => replies.push(text))
  await b.conn.agent.request(acp.methods.agent.initialize, initializeParams)

  let resumedBy = 'session/resume'
  try {
    await b.conn.agent.request(acp.methods.agent.session.resume, { sessionId: contextId, cwd: WORKSPACE_ROOT, mcpServers: [] })
  } catch (error) {
    console.log(`session/resume failed (${error?.message ?? error}); falling back to session/load`)
    resumedBy = 'session/load'
    await b.conn.agent.request(acp.methods.agent.session.load, { sessionId: contextId, cwd: WORKSPACE_ROOT, mcpServers: [] })
  }
  console.log(`resumed in home B by ${resumedBy}`)

  const asked = await b.conn.agent.request(acp.methods.agent.session.prompt, {
    sessionId: contextId,
    prompt: [{ type: 'text', text: 'What was the codeword I asked you to remember? Reply with only the codeword.' }],
  })
  const answer = replies.join('')
  console.log(`ask stopReason: ${asked.stopReason}`)
  console.log(`answer: ${JSON.stringify(answer)}`)
  console.log(`CODEWORD RECALLED: ${answer.includes(CODEWORD)}`)
  console.log(`RESULT captureMs=${captureMs} restoreMs=${restoreMs} bytes=${captured.bytes.byteLength} resumedBy=${resumedBy}`)

  b.child.kill('SIGKILL')
  process.exit(0)
}

main().catch((error) => {
  console.error('ROUND TRIP FAILED:', error)
  process.exit(1)
})
