// P12 acceptance for codex: is the rollout file ALONE enough to resume a context in a home that has
// never seen it? Not a unit test — it spends two real model calls, so it is run deliberately:
//
//   npm run build
//   ADAPTER_PATH=<…/codex-acp/dist/index.js> node harnesses/codex/measure/custody-round-trip.mjs
//
// Plants a codeword in home A, kills the process, captures with THIS harness's driver, restores into
// home B (which has only the credential — the one thing no driver ever captures), resumes and asks
// for the codeword back.
import { spawn } from 'node:child_process'
import { cp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import { CodexCustodyDriver } from '../dist/src/driver.js'

const ROOT = process.env.ROUND_TRIP_ROOT ?? join(tmpdir(), 'agora-codex-round-trip')
const HOME_A = join(ROOT, 'home-a')
const HOME_B = join(ROOT, 'home-b')
const WORKSPACE_ROOT = join(ROOT, 'work')
const CODEWORD = 'GIROLLE-3308'
const CREDENTIALS = process.env.CREDENTIALS_PATH ?? join(process.env.HOME ?? '', '.codex', 'auth.json')
const ADAPTER = process.env.ADAPTER_PATH ?? '/usr/local/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js'

const toReadable = (s) => new ReadableStream({ start(c) { s.on('data', (d) => c.enqueue(new Uint8Array(d))); s.on('end', () => c.close()); s.on('error', (e) => c.error(e)) } })
const toWritable = (s) => new WritableStream({ write: (c) => new Promise((res, rej) => s.write(Buffer.from(c), (e) => (e ? rej(e) : res()))) })

const initializeParams = {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  cwd: WORKSPACE_ROOT,
  mcpServers: [],
}

function connect(home, name) {
  const child = spawn('node', [ADAPTER], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex') }, cwd: WORKSPACE_ROOT })
  const app = acp.client({ name })
  const replies = []
  app.onNotification(acp.methods.client.session.update, (n) => {
    const text = (n?.params?.update ?? n?.update)?.content?.text
    if (typeof text === 'string') replies.push(text)
  })
  return { child, conn: app.connect(acp.ndJsonStream(toWritable(child.stdin), toReadable(child.stdout))), replies }
}

async function main() {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(WORKSPACE_ROOT, { recursive: true })
  for (const home of [HOME_A, HOME_B]) {
    await mkdir(join(home, '.codex'), { recursive: true })
    await cp(CREDENTIALS, join(home, '.codex', 'auth.json'))
  }

  const a = connect(HOME_A, 'codex-round-trip-a')
  await a.conn.agent.request(acp.methods.agent.initialize, initializeParams)
  const created = await a.conn.agent.request(acp.methods.agent.session.new, { cwd: WORKSPACE_ROOT, mcpServers: [] })
  const contextId = created.sessionId
  console.log(`context: ${contextId}`)
  await a.conn.agent.request(acp.methods.agent.session.prompt, {
    sessionId: contextId,
    prompt: [{ type: 'text', text: `Remember this codeword for later: ${CODEWORD}. Reply with exactly: OK` }],
  })
  a.child.kill('SIGKILL')
  await new Promise((r) => a.child.on('exit', r))
  console.log('home A adapter killed')

  const captureStarted = Date.now()
  const captured = await new CodexCustodyDriver({ harnessHome: HOME_A, workspaceRoot: WORKSPACE_ROOT }).capture({ podUid: 'measured-pod', processGeneration: 0, contextId })
  const captureMs = Date.now() - captureStarted
  console.log(`captured ${captured.bytes.byteLength} bytes in ${captureMs}ms, checksum ${captured.checksum}`)
  const text = new TextDecoder().decode(captured.bytes)
  console.log(`payload carries the credential: ${text.includes('access_token') || text.includes('OPENAI_API_KEY')}`)

  const restoreStarted = Date.now()
  const placement = await new CodexCustodyDriver({ harnessHome: HOME_B, workspaceRoot: WORKSPACE_ROOT }).restore(captured.bytes)
  const restoreMs = Date.now() - restoreStarted
  console.log(`restored to ${placement.path} in ${restoreMs}ms`)

  const b = connect(HOME_B, 'codex-round-trip-b')
  await b.conn.agent.request(acp.methods.agent.initialize, initializeParams)
  await b.conn.agent.request(acp.methods.agent.session.resume, { sessionId: contextId, cwd: WORKSPACE_ROOT, mcpServers: [] })
  console.log('resumed in home B by session/resume')
  b.replies.length = 0
  await b.conn.agent.request(acp.methods.agent.session.prompt, { sessionId: contextId, prompt: [{ type: 'text', text: 'What was the codeword? Reply with only the codeword.' }] })
  const answer = b.replies.join('')
  console.log(`answer: ${JSON.stringify(answer)}`)
  console.log(`CODEWORD RECALLED: ${answer.includes(CODEWORD)}`)
  console.log(`RESULT captureMs=${captureMs} restoreMs=${restoreMs} bytes=${captured.bytes.byteLength}`)
  b.child.kill('SIGKILL')
  process.exit(answer.includes(CODEWORD) ? 0 : 1)
}

main().catch((error) => {
  console.error('ROUND TRIP FAILED:', error)
  process.exit(1)
})
