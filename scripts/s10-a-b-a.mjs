// S10 Step 2 — A → B → A, end to end against BOTH real adapters.
//
// No cluster here, so Kubernetes and OneCLI are stubbed exactly as in scripts/s9-end-to-end.mjs;
// everything else is real: two pinned adapters, both custody drivers, runtime-control's owner API
// and custody transport, PostgreSQL with its custody roles, and the control plane's own TURN_OFF,
// RESTORE and REFILL.
//
//   A = claude-code: plant a codeword, shut down (Save captured, A's Anchor advanced)
//   B = codex:       the Intent switches harness; B has no Anchor of its own, so it starts fresh
//                    and A's Anchor is untouched
//   A again:         the Intent switches back; A's own Anchor is found, its context resumed, and
//                    the facts appended while it was away are refilled
//
// It spends four real model calls (two per harness). Run it deliberately:
//
//   npm run build
//   DATABASE_URL=… CLAUDE_ADAPTER=<…/claude-agent-acp/dist/index.js> CODEX_ADAPTER=<…/codex-acp/dist/index.js> \
//     node scripts/s10-a-b-a.mjs
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import * as acp from '@agentclientprotocol/sdk'

import { createOwnerApi } from '../apps/runtime-control/dist/src/owner-api.js'
import { CustodyTransport } from '../apps/runtime-control/dist/src/custody-transport.js'
import { LaunchSeam } from '../apps/runtime-control/dist/src/launch-seam.js'
import { WakeLog } from '../apps/runtime-control/dist/src/wakes.js'
import { startCustodyAgent } from '../packages/harness-bridge/dist/src/custody-agent.js'
import { ClaudeCodeCustodyDriver } from '../harnesses/claude-code/dist/src/driver.js'
import { CodexCustodyDriver } from '../harnesses/codex/dist/src/driver.js'
import { createTurnOffExecutor } from '../apps/control-plane/dist/src/verbs/turn-off.js'
import { createRestoreExecutor } from '../apps/control-plane/dist/src/verbs/restore.js'
import { createRefillExecutor } from '../apps/control-plane/dist/src/verbs/refill.js'
import { createRuntimeControlCaptureSource } from '../apps/control-plane/dist/src/capture-source.js'
import { setWorkspaceRoot } from '../apps/control-plane/dist/src/workspace-root.js'
import { openSession, recordBridgeToken, bindAcpContext, appendFact, currentSession } from '../packages/journal/dist/src/index.js'
import { getAnchor, getSave, readPayload } from '../packages/custody/dist/src/index.js'
import { normalizeAnchor } from '../packages/observation/dist/src/index.js'

const ROOT = process.env.ABA_ROOT ?? join(tmpdir(), 'agora-s10-aba')
const WORKSPACE_ROOT = join(ROOT, 'work')
const CODEWORD = 'PISSENLIT-6620'
const CLAUDE_ADAPTER = process.env.CLAUDE_ADAPTER ?? '/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'
const CODEX_ADAPTER = process.env.CODEX_ADAPTER ?? '/usr/local/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js'

const HARNESSES = new Map([
  ['claude-code', { harnessId: 'claude-code', supportedFormats: [{ formatId: 'claude-code-transcript', formatVersion: 1 }], acceptedDriverRevisions: ['claude-code-transcript-1'], workspaceDeps: {} }],
  ['codex', { harnessId: 'codex', supportedFormats: [{ formatId: 'codex-rollout', formatVersion: 1 }], acceptedDriverRevisions: ['codex-rollout-1'], workspaceDeps: {} }],
])

const step = (message) => console.log(`\n=== ${message}`)
const ok = (message) => console.log(`  ✓ ${message}`)
function must(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`)
  ok(message)
}

const toReadable = (s) => new ReadableStream({ start(c) { s.on('data', (d) => c.enqueue(new Uint8Array(d))); s.on('end', () => c.close()); s.on('error', (e) => c.error(e)) } })
const toWritable = (s) => new WritableStream({ write: (c) => new Promise((res, rej) => s.write(Buffer.from(c), (e) => (e ? rej(e) : res()))) })

const initializeParams = {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  cwd: WORKSPACE_ROOT,
  mcpServers: [],
}

/** One adapter process, with per-connection streams — the same shape the bridge server has. */
function spawnAdapter(adapter, home) {
  const child = spawn('node', [adapter], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex') }, cwd: WORKSPACE_ROOT })
  const connect = async () => {
    let onData
    const readable = new ReadableStream({
      start(controller) {
        onData = (chunk) => controller.enqueue(new Uint8Array(chunk))
        child.stdout.on('data', onData)
      },
      cancel() {
        if (onData !== undefined) child.stdout.off('data', onData)
      },
    })
    const writable = new WritableStream({ write: (c) => new Promise((res, rej) => child.stdin.write(Buffer.from(c), (e) => (e ? rej(e) : res()))) })
    return { connectionId: randomUUID(), stream: { writable, readable }, close: async () => { if (onData !== undefined) child.stdout.off('data', onData) }, closed: new Promise(() => {}) }
  }
  return { child, connect }
}

/** The process-level handshake the bridge performs once. */
async function handshake(adapter) {
  const opened = await adapter.connect()
  const conn = acp.client({ name: 'aba-handshake' }).connect(acp.ndJsonStream(opened.stream.writable, opened.stream.readable))
  try {
    await conn.agent.request(acp.methods.agent.initialize, initializeParams)
  } finally {
    conn.close?.()
    await opened.close()
  }
}

async function prompt(adapter, contextId, text) {
  const opened = await adapter.connect()
  const replies = []
  const app = acp.client({ name: 'aba-prompt' })
  app.onNotification(acp.methods.client.session.update, (n) => {
    const chunk = (n?.params?.update ?? n?.update)?.content?.text
    if (typeof chunk === 'string') replies.push(chunk)
  })
  const conn = app.connect(acp.ndJsonStream(opened.stream.writable, opened.stream.readable))
  try {
    await conn.agent.request(acp.methods.agent.session.prompt, { sessionId: contextId, prompt: [{ type: 'text', text }] })
    return replies.join('')
  } finally {
    conn.close?.()
    await opened.close()
  }
}

class FakeK8s {
  namespace = 'agora-runs'
  #pods = new Map()
  async createPod(pod) { this.#pods.set(pod.metadata.name, pod); return pod }
  async getPod(name) { return this.#pods.get(name) }
  async listPods() { return { items: [...this.#pods.values()] } }
  async deletePod(name) { this.#pods.delete(name) }
  async getNode() { return undefined }
  // eslint-disable-next-line require-yield
  async *watchPods() { return }
  seed(name, pod) { this.#pods.set(name, pod) }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString: databaseUrl })
  setWorkspaceRoot(WORKSPACE_ROOT)

  await rm(ROOT, { recursive: true, force: true })
  await mkdir(WORKSPACE_ROOT, { recursive: true })
  const homeA = join(ROOT, 'home-a')
  const homeB = join(ROOT, 'home-b')
  const homeA2 = join(ROOT, 'home-a2')
  for (const home of [homeA, homeA2]) {
    await mkdir(join(home, '.claude'), { recursive: true })
    await cp(join(process.env.HOME, '.claude', '.credentials.json'), join(home, '.claude', '.credentials.json'))
  }
  await mkdir(join(homeB, '.codex'), { recursive: true })
  await cp(join(process.env.HOME, '.codex', 'auth.json'), join(homeB, '.codex', 'auth.json'))

  const workstreamId = randomUUID()
  await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1,$2,$3,$4)', [workstreamId, 'e2e', 'a-b-a', randomUUID()])
  const intent = async (harness) => {
    await pool.query(
      `INSERT INTO workstream_intent_events (workstream_id, intent_seq, intent, request_key, principal, revision_set)
       VALUES ($1, (SELECT coalesce(max(intent_seq),0)+1 FROM workstream_intent_events WHERE workstream_id = $1), $2::jsonb, $3, 'e2e', '{}'::jsonb)`,
      [workstreamId, JSON.stringify({ power: 'on', harness, model: 'x', effort: 'default', capabilities: [] }), randomUUID()],
    )
  }

  // --- runtime-control, shared by every incarnation ---------------------------------------------
  const k8s = new FakeK8s()
  const custody = new CustodyTransport({
    secret: 'aba-secret',
    readPayload: async (saveId) => readPayload(pool, saveId),
    writePayload: async (saveId, bytes) => {
      const client = await pool.connect()
      try {
        await client.query('INSERT INTO save_payloads (save_id, bytes) VALUES ($1,$2) ON CONFLICT (save_id) DO NOTHING', [saveId, Buffer.from(bytes)])
      } finally {
        client.release()
      }
    },
  })
  const obligations = { async obligationsFor() { return [] }, async record() {}, async discharge() { return false }, async outstanding() { return [] } }
  const settings = { namespace: 'agora-runs', startupDeadlineSeconds: 120, terminationGraceSeconds: 1, inventoryFreshnessMs: 5000, runtimeClassName: 'sandboxed', runAsUser: 10001, bridgeAuthSecretName: 'x', bridgeAuthSecretKey: 'y', bridgePort: 8765, ownerApiBaseUrl: 'http://127.0.0.1:0', relayHost: 'r', relayPort: 8444, relayCaConfigMapName: 'c' }
  const gate = { async decide() { return { kind: 'dispatch' } }, async record() {}, async retire() {} }
  const seams = new Map()
  const owner = createOwnerApi({ k8s, obligations, seams, gate, harnesses: [], settings, wakes: new WakeLog(), bridgeAuthSecret: 'aba-secret', custody })
  await new Promise((r) => owner.listen(0, '127.0.0.1', r))
  const ownerUrl = `http://127.0.0.1:${owner.address().port}`

  let currentPod = null
  const inventory = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ pods: currentPod === null ? [] : [currentPod], obligations: [], complete: true }))
  })
  await new Promise((r) => inventory.listen(0, '127.0.0.1', r))
  const inventoryUrl = `http://127.0.0.1:${inventory.address().port}`

  const facade = createServer(async (req, res) => {
    const target = (req.url ?? '').startsWith('/v1/workstreams/') ? inventoryUrl : ownerUrl
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

  /** Registers one incarnation: a Pod in the fake cluster, a seam, and an Agora Session. */
  async function incarnate(name, podUid, harness) {
    currentPod = { name, uid: podUid, forcedDeletion: false, incarnation: name, podIP: '127.0.0.1' }
    k8s.seed(name, {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name, uid: podUid },
      spec: { containers: [{ image: 'sha256:aba' }], nodeName: 'node-1' },
      status: { phase: 'Running', podIP: '127.0.0.1', containerStatuses: [{ imageID: 'sha256:aba', restartCount: 0 }] },
    })
    seams.set(name, new LaunchSeam(name))
    await pool.query(
      `INSERT INTO owner_attempts (attempt_key, workstream_id, epoch, operation, target_kind, target_id, payload_digest, state, dispatch_owner, revision_set)
       VALUES ($1,$2,1,'create_pod','reserved',$3,'d','settled','runtime-control','{}'::jsonb)`,
      [`attempt-${name}`, workstreamId, name],
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const opened = await openSession(client, workstreamId, { podUid, provenance: { harness } })
      await recordBridgeToken(client, opened.sessionId, `token-${name}`)
      await client.query('COMMIT')
      return opened.sessionId
    } finally {
      client.release()
    }
  }

  async function endAttribution(sessionId) {
    await pool.query('UPDATE sessions SET attribution_ended_at = now() WHERE id = $1', [sessionId])
  }

  const turnOffFor = () =>
    createTurnOffExecutor({
      inner: { async execute() {} },
      productPool: pool,
      enginePool: pool,
      capture: createRuntimeControlCaptureSource({ runtimeControlBaseUrl: controlPlaneView, pollIntervalMs: 200 }),
      imageDigest: 'sha256:aba',
      preservationBudgetMs: 20_000,
      logger: (m) => console.log(`  [turn-off] ${m}`),
    })

  const context = { workstreamId, intentSeq: 1, workGeneration: 1, claimToken: 'c', rule: 'POWER-002' }

  // ================= A: claude-code =============================================================
  step('A (claude-code): a live context with a codeword, then a shutdown that captures and anchors')
  await intent('claude-code')
  const sessionA = await incarnate('pod-a', 'uid-a', 'claude-code')
  const adapterA = spawnAdapter(CLAUDE_ADAPTER, homeA)
  await handshake(adapterA)
  let contextA
  {
    const opened = await adapterA.connect()
    const conn = acp.client({ name: 'aba-a' }).connect(acp.ndJsonStream(opened.stream.writable, opened.stream.readable))
    contextA = (await conn.agent.request(acp.methods.agent.session.new, { cwd: WORKSPACE_ROOT, mcpServers: [] })).sessionId
    conn.close?.()
    await opened.close()
  }
  await prompt(adapterA, contextA, `Remember this codeword for later: ${CODEWORD}. Reply with exactly: OK`)
  ok(`context ${contextA} holds the codeword`)
  {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await bindAcpContext(client, sessionA, { contextId: contextA, processGeneration: 0 })
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  }
  const agentA = startCustodyAgent({
    evidenceUrl: `${ownerUrl}/v1/pods/pod-a/evidence`,
    custodyUrlBase: `${ownerUrl}/v1/pods/pod-a/custody`,
    driver: new ClaudeCodeCustodyDriver({ harnessHome: homeA, workspaceRoot: WORKSPACE_ROOT }),
    podUid: 'uid-a',
    pollIntervalMs: 200,
  })
  adapterA.child.kill('SIGKILL')
  await new Promise((r) => adapterA.child.on('exit', r))
  await turnOffFor().execute('TURN_OFF', context)
  agentA.stop()
  await endAttribution(sessionA)

  const anchorA = await getAnchor(pool, workstreamId, 'claude-code')
  must(anchorA !== null, `A's Anchor is published (Save ${anchorA?.saveId})`)
  must((await getAnchor(pool, workstreamId, 'codex')) === null, 'and B has no Anchor: they are per (Workstream, harness)')

  // ================= B: codex ===================================================================
  step('B (codex): the Intent switches harness — B starts fresh and A\'s Anchor is untouched')
  await intent('codex')
  const saveA = await getSave(pool, anchorA.saveId)
  must(
    normalizeAnchor({ save: saveA, harness: HARNESSES.get('codex'), invalidated: false }) === 'none',
    'observation.anchor for codex is `none`, so SESSION-003 selects START, not RESTORE (CONT-007)',
  )

  const sessionB = await incarnate('pod-b', 'uid-b', 'codex')
  const adapterB = spawnAdapter(CODEX_ADAPTER, homeB)
  await handshake(adapterB)
  let contextB
  {
    const opened = await adapterB.connect()
    const conn = acp.client({ name: 'aba-b' }).connect(acp.ndJsonStream(opened.stream.writable, opened.stream.readable))
    contextB = (await conn.agent.request(acp.methods.agent.session.new, { cwd: WORKSPACE_ROOT, mcpServers: [] })).sessionId
    conn.close?.()
    await opened.close()
  }
  await prompt(adapterB, contextB, 'Reply with exactly: OK')
  {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await bindAcpContext(client, sessionB, { contextId: contextB, processGeneration: 0 })
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  }
  const agentB = startCustodyAgent({
    evidenceUrl: `${ownerUrl}/v1/pods/pod-b/evidence`,
    custodyUrlBase: `${ownerUrl}/v1/pods/pod-b/custody`,
    driver: new CodexCustodyDriver({ harnessHome: homeB, workspaceRoot: WORKSPACE_ROOT }),
    podUid: 'uid-b',
    pollIntervalMs: 200,
  })
  adapterB.child.kill('SIGKILL')
  await new Promise((r) => adapterB.child.on('exit', r))
  await turnOffFor().execute('TURN_OFF', context)
  agentB.stop()
  await endAttribution(sessionB)

  const anchorB = await getAnchor(pool, workstreamId, 'codex')
  must(anchorB !== null, `B's own Anchor is published (Save ${anchorB?.saveId})`)
  must((await getAnchor(pool, workstreamId, 'claude-code'))?.saveId === anchorA.saveId, 'and A\'s Anchor is exactly where it was')

  // --- facts appended while the Workstream was on B, which A never saw --------------------------
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const text of ['while you were on the other harness: ship it', 'and answer in French']) {
      await appendFact(client, workstreamId, {
        sessionId: sessionB,
        kind: 'acp.envelope',
        payloadRawText: JSON.stringify({ method: 'session/prompt', params: { sessionId: contextB, prompt: [{ type: 'text', text }] } }),
        acp: { direction: 'client_to_agent', rpcKind: 'request', method: 'session/prompt', correlatedMethod: null, rpcId: 1, commandId: null, connectionId: 'b', observationId: randomUUID(), frameSize: 10 },
      })
    }
    await client.query('COMMIT')
  } finally {
    client.release()
  }

  // ================= A again ====================================================================
  step('A again: the Intent switches back — A\'s own Anchor is restored, resumed and refilled')
  await intent('claude-code')
  const sessionA2 = await incarnate('pod-a2', 'uid-a2', 'claude-code')
  const adapterA2 = spawnAdapter(CLAUDE_ADAPTER, homeA2)
  await handshake(adapterA2)
  const agentA2 = startCustodyAgent({
    evidenceUrl: `${ownerUrl}/v1/pods/pod-a2/evidence`,
    custodyUrlBase: `${ownerUrl}/v1/pods/pod-a2/custody`,
    driver: new ClaudeCodeCustodyDriver({ harnessHome: homeA2, workspaceRoot: WORKSPACE_ROOT }),
    podUid: 'uid-a2',
    pollIntervalMs: 200,
  })

  await createRestoreExecutor({
    productPool: pool,
    runtimeControlBaseUrl: controlPlaneView,
    bridgePort: 8765,
    harnesses: HARNESSES,
    placementTimeoutMs: 20_000,
    pollIntervalMs: 200,
    connect: adapterA2.connect,
    logger: (m) => console.log(`  [restore] ${m}`),
  }).execute('RESTORE', { ...context, rule: 'SESSION-002' })

  const restored = await currentSession(pool, workstreamId)
  must(restored.sessionId === sessionA2, 'the restore belongs to the new Session (CONT-003)')
  must(restored.acpContextId === contextA, `and resumed A's OWN native context (${contextA}), not B's`)

  await createRefillExecutor({
    productPool: pool,
    runtimeControlBaseUrl: controlPlaneView,
    bridgePort: 8765,
    connect: adapterA2.connect,
    logger: (m) => console.log(`  [refill] ${m}`),
  }).execute('REFILL', { ...context, rule: 'SYNC-001' })

  const handoff = (await pool.query("SELECT * FROM command_dispatches WHERE workstream_id = $1 AND kind = 'handoff'", [workstreamId])).rows[0]
  must(handoff?.state === 'responded', `the missing tail was refilled and answered (${handoff?.state})`)

  const answer = await prompt(adapterA2, contextA, 'What was the codeword I asked you to remember? Reply with only the codeword.')
  must(answer.includes(CODEWORD), `A still knows its own codeword after the round trip: ${JSON.stringify(answer)}`)

  step('done')
  agentA2.stop()
  adapterA2.child.kill('SIGKILL')
  owner.close()
  inventory.close()
  facade.close()
  await pool.end()
  process.exit(0)
}

main().catch((error) => {
  console.error('\nA → B → A FAILED:', error)
  process.exit(1)
})
