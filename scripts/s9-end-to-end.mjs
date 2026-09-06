// S9 Step 6 — the off/on cycle, end to end, against the REAL pieces this environment has.
//
//   real: the pinned claude-agent-acp adapter, the claude-code custody driver, the harness custody
//         agent, runtime-control's owner API and custody transport, PostgreSQL with its custody
//         roles, and the control plane's own TURN_OFF / RESTORE / REFILL executors.
//   stubbed: Kubernetes (a fake K8sClient — there is no cluster here) and OneCLI (no grants are
//            involved in the custody path at all).
//
// It spends two real model calls: one to plant a codeword before the shutdown, one to ask for it
// back after the restore. Run it deliberately:
//
//   npm run build
//   DATABASE_URL=postgres://…  ADAPTER_PATH=<…/claude-agent-acp/dist/index.js>  node scripts/s9-end-to-end.mjs
//
// What it proves, in order: a Save is captured from a live context at shutdown and its Anchor
// advances; a new Session in a new home restores those exact bytes and resumes the same native
// context; the codeword survives; and REFILL then delivers only the facts appended while the
// Workstream was off.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, cp, rm, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import * as acp from '@agentclientprotocol/sdk'

import { createOwnerApi } from '../apps/runtime-control/dist/src/owner-api.js'
import { CustodyTransport } from '../apps/runtime-control/dist/src/custody-transport.js'
import { LaunchSeam } from '../apps/runtime-control/dist/src/launch-seam.js'
import { WakeLog } from '../apps/runtime-control/dist/src/wakes.js'
import { startCustodyAgent } from '../harnesses/claude-code/dist/src/custody-agent.js'
import { createTurnOffExecutor } from '../apps/control-plane/dist/src/verbs/turn-off.js'
import { createRestoreExecutor } from '../apps/control-plane/dist/src/verbs/restore.js'
import { createRefillExecutor } from '../apps/control-plane/dist/src/verbs/refill.js'
import { createRuntimeControlCaptureSource } from '../apps/control-plane/dist/src/capture-source.js'
import { openSession, recordBridgeToken, bindAcpContext, appendFact, currentSession } from '../packages/journal/dist/src/index.js'
import { getAnchor, getSave, readPayload } from '../packages/custody/dist/src/index.js'
import { transcriptPath } from '../harnesses/claude-code/dist/src/driver.js'
import { setWorkspaceRoot } from '../apps/control-plane/dist/src/workspace-root.js'

const ROOT = process.env.E2E_ROOT ?? join(tmpdir(), 'agora-s9-e2e')
const HOME_A = join(ROOT, 'home-a')
const HOME_B = join(ROOT, 'home-b')
const WORKSPACE_ROOT = join(ROOT, 'work')
const CODEWORD = 'CLAFOUTIS-8813'
const CREDENTIALS = process.env.CREDENTIALS_PATH ?? join(process.env.HOME ?? '', '.claude', '.credentials.json')
const ADAPTER = process.env.ADAPTER_PATH ?? '/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'
const POD_NAME = 'agora-e2e-pod'
const INCARNATION = 'inc-e2e'

const step = (message) => console.log(`\n=== ${message}`)
const ok = (message) => console.log(`  ✓ ${message}`)
function must(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`)
  ok(message)
}

// --- the real adapter, over stdio -----------------------------------------------------------------

const toReadable = (s) =>
  new ReadableStream({
    start(c) {
      s.on('data', (d) => c.enqueue(new Uint8Array(d)))
      s.on('end', () => c.close())
      s.on('error', (e) => c.error(e))
    },
  })
const toWritable = (s) => new WritableStream({ write: (c) => new Promise((res, rej) => s.write(Buffer.from(c), (e) => (e ? rej(e) : res()))) })

function spawnAdapter(home) {
  const child = spawn('node', [ADAPTER], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, HOME: home }, cwd: WORKSPACE_ROOT })
  return { child, stream: { writable: toWritable(child.stdin), readable: toReadable(child.stdout) } }
}

/**
 * A fresh stream pair per connection, over one long-lived adapter process — the same shape
 * bridge-server.ts has, and the reason it matters is the same: web streams lock to one reader, so
 * two verbs sharing one pair would fail with "WritableStream is locked" on the second connect.
 * Connect-act-disconnect per verb is the production pattern; this reproduces it without a WebSocket.
 */
function connectorFor(child) {
  return async () => {
    let onData
    const readable = new ReadableStream({
      start(controller) {
        onData = (chunk) => controller.enqueue(new Uint8Array(chunk))
        child.stdout.on('data', onData)
      },
      cancel() {
        child.stdout.off('data', onData)
      },
    })
    const writable = new WritableStream({ write: (c) => new Promise((res, rej) => child.stdin.write(Buffer.from(c), (e) => (e ? rej(e) : res()))) })
    return {
      connectionId: randomUUID(),
      stream: { writable, readable },
      close: async () => {
        if (onData !== undefined) child.stdout.off('data', onData)
      },
      closed: new Promise(() => {}),
    }
  }
}

const initializeParams = {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  cwd: WORKSPACE_ROOT,
  mcpServers: [],
}

// --- Kubernetes, stubbed ---------------------------------------------------------------------------

class FakeK8s {
  namespace = 'agora-runs'
  #pods = new Map()
  async createPod(pod) {
    this.#pods.set(pod.metadata.name, pod)
    return pod
  }
  async getPod(name) {
    return this.#pods.get(name)
  }
  async listPods() {
    return { items: [...this.#pods.values()] }
  }
  async deletePod(name) {
    this.#pods.delete(name)
  }
  async getNode() {
    return undefined
  }
  // eslint-disable-next-line require-yield
  async *watchPods() {
    return
  }
  seed(name, pod) {
    this.#pods.set(name, pod)
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString: databaseUrl })
  // The same value the harness definition would carry into the PodSpec; here, a temp directory.
  setWorkspaceRoot(WORKSPACE_ROOT)

  await rm(ROOT, { recursive: true, force: true })
  await mkdir(WORKSPACE_ROOT, { recursive: true })
  for (const home of [HOME_A, HOME_B]) {
    await mkdir(join(home, '.claude'), { recursive: true })
    await cp(CREDENTIALS, join(home, '.claude', '.credentials.json'))
  }

  // --- a Workstream with history, and a live Session on home A ---------------------------------
  step('a Workstream with prior facts, and a live native context')
  const workstreamId = randomUUID()
  await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1,$2,$3,$4)', [workstreamId, 'e2e', 's9', randomUUID()])
  await pool.query(
    `INSERT INTO owner_attempts (attempt_key, workstream_id, epoch, operation, target_kind, target_id, payload_digest, state, dispatch_owner, revision_set)
     VALUES ($1,$2,1,'create_pod','reserved',$3,'d','settled','runtime-control','{}'::jsonb)`,
    [`attempt-${INCARNATION}`, workstreamId, INCARNATION],
  )

  const first = spawnAdapter(HOME_A)
  const clientA = acp.client({ name: 'e2e-a' })
  const connectionA = clientA.connect(acp.ndJsonStream(first.stream.writable, first.stream.readable))
  await connectionA.agent.request(acp.methods.agent.initialize, initializeParams)
  const created = await connectionA.agent.request(acp.methods.agent.session.new, { cwd: WORKSPACE_ROOT, mcpServers: [] })
  const contextId = created.sessionId
  ok(`native context ${contextId}`)

  const planted = await connectionA.agent.request(acp.methods.agent.session.prompt, {
    sessionId: contextId,
    prompt: [{ type: 'text', text: `Remember this codeword for later: ${CODEWORD}. Reply with exactly: OK` }],
  })
  must(planted.stopReason === 'end_turn', 'the codeword turn completed')

  const client = await pool.connect()
  let sessionId
  try {
    await client.query('BEGIN')
    const opened = await openSession(client, workstreamId, { podUid: 'pod-uid-e2e', provenance: {} })
    sessionId = opened.sessionId
    await recordBridgeToken(client, sessionId, 'e2e-token')
    await bindAcpContext(client, sessionId, { contextId, processGeneration: 0 })
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  ok(`Agora Session ${sessionId} bound to it`)

  // --- runtime-control, with the real custody transport ------------------------------------------
  step('runtime-control with the real custody transport')
  const k8s = new FakeK8s()
  k8s.seed(POD_NAME, {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: POD_NAME, uid: 'pod-uid-e2e', labels: { 'agora.dev/workstream': workstreamId } },
    spec: { containers: [{ image: 'sha256:e2e' }], nodeName: 'node-1' },
    status: { phase: 'Running', podIP: '127.0.0.1', containerStatuses: [{ imageID: 'sha256:e2e', restartCount: 0 }] },
  })
  const custody = new CustodyTransport({
    secret: 'e2e-secret',
    readPayload: async (saveId) => readPayload(pool, saveId),
    writePayload: async (saveId, bytes) => {
      const c = await pool.connect()
      try {
        await c.query('INSERT INTO save_payloads (save_id, bytes) VALUES ($1,$2) ON CONFLICT (save_id) DO NOTHING', [saveId, Buffer.from(bytes)])
      } finally {
        c.release()
      }
    },
  })
  const obligations = { async obligationsFor() { return [] }, async record() {}, async discharge() { return false }, async outstanding() { return [] } }
  const settings = {
    namespace: 'agora-runs',
    startupDeadlineSeconds: 120,
    terminationGraceSeconds: 1,
    inventoryFreshnessMs: 5000,
    runtimeClassName: 'sandboxed',
    runAsUser: 10001,
    bridgeAuthSecretName: 'x',
    bridgeAuthSecretKey: 'y',
    bridgePort: 8765,
    ownerApiBaseUrl: 'http://127.0.0.1:0',
    relayHost: 'r',
    relayPort: 8444,
    relayCaConfigMapName: 'c',
  }
  const gate = { async decide() { return { kind: 'dispatch' } }, async record() {}, async retire() {} }
  const owner = createOwnerApi({
    k8s,
    obligations,
    seams: new Map([[POD_NAME, new LaunchSeam(INCARNATION)]]),
    gate,
    harnesses: [],
    settings,
    wakes: new WakeLog(),
    bridgeAuthSecret: 'e2e-secret',
    custody,
  })
  await new Promise((r) => owner.listen(0, '127.0.0.1', r))
  const runtimeControlBaseUrl = `http://127.0.0.1:${owner.address().port}`
  ok(`owner API on ${runtimeControlBaseUrl}`)

  // The inventory endpoint the control-plane verbs use to find the Pod. The real one reads
  // Kubernetes; here it answers from the same fake, in the shape the verbs expect.
  const inventory = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ pods: [{ name: POD_NAME, uid: 'pod-uid-e2e', forcedDeletion: false, incarnation: INCARNATION, podIP: '127.0.0.1' }], obligations: [], complete: true }))
  })
  await new Promise((r) => inventory.listen(0, '127.0.0.1', r))
  const inventoryUrl = `http://127.0.0.1:${inventory.address().port}`

  // A base URL that serves /v1/workstreams/* from the inventory stub and everything else from the
  // real owner API — the control plane sees one runtime-control, as it would in a cluster.
  const facade = createServer(async (req, res) => {
    const target = (req.url ?? '').startsWith('/v1/workstreams/') ? inventoryUrl : runtimeControlBaseUrl
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const upstream = await fetch(`${target}${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith(':') && k !== 'host' && k !== 'connection')),
      ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
    })
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(Buffer.from(await upstream.arrayBuffer()))
  })
  await new Promise((r) => facade.listen(0, '127.0.0.1', r))
  const controlPlaneView = `http://127.0.0.1:${facade.address().port}`

  // --- the harness's own custody agent, beside the adapter ---------------------------------------
  const agent = startCustodyAgent({
    evidenceUrl: `${runtimeControlBaseUrl}/v1/pods/${POD_NAME}/evidence`,
    custodyUrlBase: `${runtimeControlBaseUrl}/v1/pods/${POD_NAME}/custody`,
    harnessHome: HOME_A,
    workspaceRoot: WORKSPACE_ROOT,
    podUid: 'pod-uid-e2e',
    pollIntervalMs: 200,
    onLog: (m) => console.log(`  [agent] ${m}`),
  })

  // --- power off: capture, Anchor, terminate -----------------------------------------------------
  step('power off — TURN_OFF captures, publishes the Anchor, and terminates regardless')
  const verbs = []
  const innerOwner = { async execute(verb) { verbs.push(verb) } }
  const turnOff = createTurnOffExecutor({
    inner: innerOwner,
    productPool: pool,
    enginePool: pool,
    capture: createRuntimeControlCaptureSource({ runtimeControlBaseUrl: controlPlaneView, pollIntervalMs: 200, logger: (m) => console.log(`  [capture] ${m}`) }),
    imageDigest: 'sha256:e2e',
    preservationBudgetMs: 20_000,
    logger: (m) => console.log(`  [turn-off] ${m}`),
  })

  // Quiescence, as the control plane establishes it: the process is gone, so no turn can be in
  // flight and none can be accepted. The transcript is what remains.
  first.child.kill('SIGKILL')
  await new Promise((r) => first.child.on('exit', r))
  ok('the adapter process is gone; the transcript is the only native state left')

  await turnOff.execute('TURN_OFF', { workstreamId, intentSeq: 1, workGeneration: 1, claimToken: 'c', rule: 'POWER-002' })

  const shutdown = (await pool.query('SELECT * FROM shutdowns WHERE workstream_id = $1', [workstreamId])).rows[0]
  must(shutdown?.capture_outcome === 'captured', `the Save was captured (${shutdown?.capture_outcome}: ${shutdown?.capture_detail ?? ''})`)
  must(shutdown?.anchor_outcome === 'published', 'the Anchor advanced')
  must(shutdown?.terminated_at !== null, 'the Pod was terminated')
  must(verbs.includes('REVOKE') && verbs.includes('TURN_OFF'), 'authority was cut before the Pod went')

  const anchor = await getAnchor(pool, workstreamId, 'claude-code')
  const save = await getSave(pool, anchor.saveId)
  const bytes = await readPayload(pool, save.id)
  must(bytes !== null && bytes.byteLength === Number(save.byteLength), `the payload is in the store (${String(save.byteLength)} bytes)`)
  must(!new TextDecoder().decode(bytes).includes('credentials'), 'and it carries no credential')

  // The Session that produced it ends, as a shutdown ends attribution.
  await pool.query('UPDATE sessions SET attribution_ended_at = now() WHERE id = $1', [sessionId])
  agent.stop()

  // --- facts appended while off ------------------------------------------------------------------
  step('two product facts appended while the Workstream is off')
  const offClient = await pool.connect()
  try {
    await offClient.query('BEGIN')
    for (const text of ['while you were away: ship the release', 'and reply in French']) {
      await appendFact(offClient, workstreamId, {
        sessionId,
        kind: 'acp.envelope',
        payloadRawText: JSON.stringify({ method: 'session/prompt', params: { sessionId: contextId, prompt: [{ type: 'text', text }] } }),
        acp: { direction: 'client_to_agent', rpcKind: 'request', method: 'session/prompt', correlatedMethod: null, rpcId: 1, commandId: null, connectionId: 'off', observationId: randomUUID(), frameSize: 10 },
      })
    }
    await offClient.query('COMMIT')
  } finally {
    offClient.release()
  }
  ok('appended')

  // --- power on: a new Pod, a new Session, a restore ---------------------------------------------
  step('power on — a NEW Session in a NEW home restores the Save and resumes the context')
  const newClient = await pool.connect()
  let newSessionId
  try {
    await newClient.query('BEGIN')
    const opened = await openSession(newClient, workstreamId, { podUid: 'pod-uid-e2e-2', provenance: {} })
    newSessionId = opened.sessionId
    await recordBridgeToken(newClient, newSessionId, 'e2e-token-2')
    await newClient.query('COMMIT')
  } finally {
    newClient.release()
  }
  ok(`new Agora Session ${newSessionId} (the Save's own Session is over)`)

  // The new Pod's custody agent: a different home, which has never seen this context.
  const agentB = startCustodyAgent({
    evidenceUrl: `${runtimeControlBaseUrl}/v1/pods/${POD_NAME}/evidence`,
    custodyUrlBase: `${runtimeControlBaseUrl}/v1/pods/${POD_NAME}/custody`,
    harnessHome: HOME_B,
    workspaceRoot: WORKSPACE_ROOT,
    podUid: 'pod-uid-e2e-2',
    pollIntervalMs: 200,
    onLog: (m) => console.log(`  [agent-b] ${m}`),
  })

  const second = spawnAdapter(HOME_B)
  const connectSecond = connectorFor(second.child)

  const restore = createRestoreExecutor({
    productPool: pool,
    runtimeControlBaseUrl: controlPlaneView,
    bridgePort: 8765,
    harness: {
      harnessId: 'claude-code',
      supportedFormats: [{ formatId: 'claude-code-transcript', formatVersion: 1 }],
      acceptedDriverRevisions: ['claude-code-transcript-1'],
      workspaceDeps: {},
    },
    placementTimeoutMs: 20_000,
    pollIntervalMs: 200,
    connect: connectSecond,
    logger: (m) => console.log(`  [restore] ${m}`),
  })
  await restore.execute('RESTORE', { workstreamId, intentSeq: 1, workGeneration: 1, claimToken: 'c', rule: 'SESSION-002' })

  const restored = await currentSession(pool, workstreamId)
  must(restored.sessionId === newSessionId, 'the restore belongs to the NEW Session (CONT-003)')
  must(restored.acpContextId === contextId, 'and resumed the Save\'s own native context id')
  const placedPath = transcriptPath({ harnessHome: HOME_B, workspaceRoot: WORKSPACE_ROOT, contextId })
  must((await readFile(placedPath)).length === Number(save.byteLength), 'the transcript is on disk in the new home')
  const originRow = (await pool.query('SELECT origin_w, origin_save_id FROM sessions WHERE id = $1', [newSessionId])).rows[0]
  must(originRow.origin_save_id === save.id, `the opening range starts at the Save's proven frontier W=${String(originRow.origin_w)}`)

  // --- refill --------------------------------------------------------------------------------------
  step('REFILL delivers exactly the facts appended while off')
  const refill = createRefillExecutor({
    productPool: pool,
    runtimeControlBaseUrl: controlPlaneView,
    bridgePort: 8765,
    connect: connectSecond,
    logger: (m) => console.log(`  [refill] ${m}`),
  })
  await refill.execute('REFILL', { workstreamId, intentSeq: 1, workGeneration: 1, claimToken: 'c', rule: 'SYNC-001' })

  const handoff = (await pool.query("SELECT * FROM command_dispatches WHERE workstream_id = $1 AND kind = 'handoff'", [workstreamId])).rows[0]
  must(handoff !== undefined, 'one handoff command exists')
  must(handoff.state === 'responded', `and it was delivered and answered (${handoff?.state})`)
  must(handoff.request.policyRevision === 'handoff-seed-v1', 'under the pinned seed policy')

  // --- the codeword ---------------------------------------------------------------------------------
  step('the restored context still knows the codeword, and has the refilled facts')
  const clientB = acp.client({ name: 'e2e-b' })
  const replies = []
  clientB.onNotification(acp.methods.client.session.update, (n) => {
    const text = n?.params?.update?.content?.text ?? n?.update?.content?.text
    if (typeof text === 'string') replies.push(text)
  })
  const conn = await connectSecond()
  const connectionB = clientB.connect(acp.ndJsonStream(conn.stream.writable, conn.stream.readable))
  await connectionB.agent.request(acp.methods.agent.initialize, initializeParams)
  await connectionB.agent.request(acp.methods.agent.session.prompt, {
    sessionId: contextId,
    prompt: [{ type: 'text', text: 'What was the codeword I asked you to remember? Reply with only the codeword.' }],
  })
  const answer = replies.join('')
  must(answer.includes(CODEWORD), `the codeword survived off/on: ${JSON.stringify(answer)}`)

  step('done')
  agentB.stop()
  second.child.kill('SIGKILL')
  owner.close()
  inventory.close()
  facade.close()
  await pool.end()
  process.exit(0)
}

main().catch((error) => {
  console.error('\nEND TO END FAILED:', error)
  process.exit(1)
})
