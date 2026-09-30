// Opt-in, billed measurement against a real sandbox and gateway. No upstream secret enters Agora.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { HttpKube, privateKeyFrom, type Claim } from '@agora/executions'
import { GrantSigner } from '@agora/credentials'
import { mintBridgeToken } from '@agora/harness-bridge/token'
import { parseBundle } from '@agora/harness-bridge/anchor'
import { LogStore, type Entry } from '../src/store.ts'
import { LogDriver, claimName } from '../src/driver.ts'
import { core } from '../src/projection.ts'
import { hash, encode, object } from '../src/json.ts'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name}_required`)
  return value
}
async function until<T>(label: string, read: () => Promise<T | false | null | undefined>, ms = 90000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== false && value !== null && value !== undefined) return value
    if (Date.now() > end) throw new Error(`${label}_timeout`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
// Host-side measurement: resolve Pod IPs through the API, rather than cluster DNS on the host.
class LiveKube extends HttpKube {
  readonly addresses = new Map<string, string>()
  override async getClaim(name: string): Promise<Claim | null> {
    const claim = await super.getClaim(name)
    const podName = claim?.status?.sandbox?.name
    if (podName) {
      const pod = await this.getPod(podName)
      const ip = object(pod?.status)?.podIP
      if (typeof ip === 'string') this.addresses.set(podName, `${ip}:8080`)
    }
    return claim
  }
}
const namespace = process.env.LOG_LIVE_NAMESPACE ?? 'agora-sandboxes'
const kube = new LiveKube({
  apiBase: required('LOG_LIVE_KUBE_API'), namespace, tokenFile: required('LOG_LIVE_KUBE_TOKEN_FILE'),
})
const signingKey = privateKeyFrom(await readFile(required('LOG_LIVE_SIGNING_KEY_FILE'), 'utf8'))
const signer = new GrantSigner({
  proxy: required('LOG_LIVE_GATEWAY_PROXY'), keyFile: required('LOG_LIVE_GRANTS_KEY_FILE'),
  keyId: 'agora-grants-1', issuer: 'agora', audience: 'agora-gateway',
})
const store = new LogStore({
  writer: required('LOG_TEST_WRITER_URL'), projector: required('LOG_TEST_PROJECTOR_URL'),
  anchors: required('LOG_TEST_ANCHORS_URL'),
})
const driver = new LogDriver({
  store, kube, signingKey, tickMs: 250, renewSeconds: 20,
  address: (_service, pod) => {
    const address = kube.addresses.get(pod)
    if (!address) throw new Error('pod_address_unavailable')
    return address
  },
})
const output = required('LOG_LIVE_OUTPUT_DIR')
const workstream = randomUUID()
const measurements: Record<string, unknown>[] = []
const mintedTokens: string[] = []
const executions: string[] = []
let started = false
let transcript: Entry[] = []

async function bridgeInfo(execution: string): Promise<Record<string, unknown>> {
  const claim = await kube.getClaim(claimName(execution)), pod = claim?.status?.sandbox?.name
  assert.ok(pod, 'pod_missing')
  const response = await fetch(`http://${kube.addresses.get(pod)}/info`, {
    headers: { authorization: `Bearer ${mintBridgeToken(signingKey, pod)}` },
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(response.status, 200, 'bridge_info_refused')
  return await response.json() as Record<string, unknown>
}
async function control(execution: string, method: string, params: Record<string, unknown>) {
  const id = await driver.control(workstream, execution, method, params)
  const response = await until('control_reply', async () => (await store.entries(workstream))
    .find((e) => e.direction === 'in' && e.rpc_id === id && ['response', 'error'].includes(e.rpc_kind ?? '')))
  assert.equal(response.rpc_kind, 'response', 'control_error')
  return response
}
async function create(pool: string, anchor?: string) {
  const before = Date.now(), execution = randomUUID()
  const accepted = await driver.command(workstream, {
    id: randomUUID(), kind: 'Create', target: {}, body: {
      execution, pool, limits: { leaseSeconds: 60, turnCapSeconds: 120 }, ...(anchor ? { anchor } : {}),
    },
  })
  assert.equal(accepted.accepted, true, 'create_refused')
  executions.push(execution)
  const state = await until('session_open', async () => {
    const current = (await store.state(workstream)).current
    if (current?.ended || current?.lost) throw new Error('execution_failed')
    return current?.id === execution && current.session ? current : false
  })
  const credentials = await signer.mint({ label: `agora ${claimName(execution)}`, ttlSeconds: 600, profiles: ['anthropic'] })
  mintedTokens.push(credentials.token)
  // Supply the gateway JWT to the bridge through its existing transport; no lab UI attachment.
  await driver.attachCredentials(workstream, execution, credentials)
  await control(execution, 'session/set_config_option', {
    sessionId: state.acpId, configId: 'model', value: 'haiku',
  })
  measurements.push({ case: anchor ? 'native_restore_ready' : 'create_ready', ms: Date.now() - before })
  console.log(JSON.stringify(measurements.at(-1)))
  return { execution, session: state.session!, acpId: state.acpId! }
}
async function prompt(target: Awaited<ReturnType<typeof create>>, label: string, text: string, expected: string) {
  const before = Date.now(), firstPosition = (await store.entries(workstream)).at(-1)?.position ?? '0'
  const accepted = await driver.command(workstream, {
    id: randomUUID(), kind: 'Write', target: { execution: target.execution, session: target.session },
    body: { prompt: [{ type: 'text', text }] },
  })
  assert.equal(accepted.accepted, true, 'write_refused')
  if (!accepted.accepted) throw new Error('write_refused')
  const response = await until('prompt_reply', async () => {
    const state = await store.state(workstream)
    for (const permission of state.permissions.values()) {
      const params = object(permission.content.params), tool = object(params?.toolCall)
      const command = object(tool?.rawInput)?.command
      const options = Array.isArray(params?.options) ? params.options : []
      const once = options.map(object).find((o) => o?.kind === 'allow_once')
      const allowed = command === "printf 'LOG_CLAUDE_TOOL_OK\\n'" && once
      const answer = await driver.command(workstream, {
        id: randomUUID(), kind: 'RespondPermission',
        target: { execution: target.execution, session: target.session, requestPosition: permission.position },
        body: { requestId: permission.rpc_id, outcome: allowed
          ? { outcome: 'selected', optionId: once.optionId } : { outcome: 'cancelled' } },
      })
      assert.equal(answer.accepted, true, 'permission_answer_refused')
    }
    return (await store.entries(workstream)).find((e) =>
      e.direction === 'in' && e.rpc_id === accepted.requestId && ['response', 'error'].includes(e.rpc_kind ?? ''))
  })
  assert.equal(response.rpc_kind, 'response', 'prompt_error')
  assert.equal(object(response.content.result)?.stopReason, 'end_turn', 'prompt_not_completed')
  const entries = (await store.entries(workstream)).filter((e) => BigInt(e.position) > BigInt(firstPosition))
  const reply = entries.filter((e) => object(object(e.content.params)?.update)?.sessionUpdate === 'agent_message_chunk')
    .map((e) => String(object(object(object(e.content.params)?.update)?.content)?.text ?? '')).join('')
  assert.ok(reply.includes(expected), 'unexpected_model_reply')
  await driver.projections.run(workstream)
  const view = await driver.projections.objects(workstream)
  assert.equal(hash(view), hash(core.fold(await store.entries(workstream)).sort((a, b) => a.id.localeCompare(b.id))), 'incremental_view_mismatch')
  const incrementalHash = hash(view), beforeRebuild = performance.now()
  await driver.projections.run(workstream, core, true)
  assert.equal(hash(await driver.projections.objects(workstream)), incrementalHash, 'rebuild_mismatch')
  const info = await bridgeInfo(target.execution)
  const outbound = object(info.outbound), targets = object(outbound?.targets), anthropic = object(targets?.['api.anthropic.com:443'])
  assert.equal(anthropic?.lastStatus, 200, 'gateway_tunnel_failed')
  const result = { case: label, validatedTurnMs: Date.now() - before,
    postRebuildCheckMs: Math.round((performance.now() - beforeRebuild) * 100) / 100,
    stopReason: 'end_turn', gatewayLastStatus: anthropic?.lastStatus, gatewayTunnels: anthropic?.count,
    entries: entries.length, objects: view.length, projectionHash: incrementalHash }
  measurements.push(result)
  console.log(JSON.stringify(result))
}
async function stopAndExpire(execution: string) {
  const current = (await store.state(workstream)).executions.get(execution)
  if (current && !current.ended && !current.lost) {
    assert.equal((await driver.command(workstream, { id: randomUUID(), kind: 'Stop', target: { execution }, body: {} })).accepted, true)
  }
  await until('claim_expiry', async () => await kube.getClaim(claimName(execution)) === null, 100000)
  await until('canonical_end', async () => (await store.state(workstream)).executions.get(execution)?.ended)
}
try {
  await mkdir(output, { recursive: true, mode: 0o700 })
  await store.create(workstream, randomUUID())
  await driver.start()
  started = true
  const pool = (await kube.listPools('agora.bretagne.dev/harness=claude-code'))[0]
  assert.ok(pool, 'claude_pool_missing')
  const original = await create(pool.metadata.name)
  await prompt(original, 'real_response', 'Remember the test marker violet-cedar-471. Reply only LOG_CLAUDE_OK. Do not use tools.', 'LOG_CLAUDE_OK')
  await prompt(original, 'real_tool', "Use Bash to run exactly: printf 'LOG_CLAUDE_TOOL_OK\\n'. Then reply only LOG_CLAUDE_TOOL_OK. Do not read or modify files or call other tools.", 'LOG_CLAUDE_TOOL_OK')
  transcript = await store.entries(workstream)
  const pod = (await kube.getClaim(claimName(original.execution)))?.status?.sandbox?.name
  assert.ok(pod, 'pod_missing')
  const podSpec = object((await kube.getPod(pod))?.spec)
  const containers = Array.isArray(podSpec?.containers) ? podSpec.containers : []
  const image = object(containers[0])?.image
  const command = JSON.parse(process.env.LOG_LIVE_KUBECTL_COMMAND ?? '["kubectl"]') as string[]
  assert.ok(command[0], 'kubectl_command_missing')
  const capture = "import {readBundle,nativeDir} from '/app/packages/harness-bridge/src/anchor.ts'; const bundle=await readBundle('claude-code',nativeDir('claude-code',process.env.HOME,process.env.BRIDGE_WORKSPACE)); process.stdout.write(JSON.stringify(bundle))"
  const native = await promisify(execFile)(command[0], [...command.slice(1), 'exec', '-n', namespace, pod,
    '--', 'node', '--input-type=module', '-e', capture], { maxBuffer: 48 * 1024 * 1024 })
  const raw = Buffer.from(native.stdout), bundle = parseBundle(raw)
  assert.ok(bundle.stable && bundle.files.length > 0, 'native_capture_incomplete')
  const anchor = await driver.receiveAnchor(pod, bundle, raw)
  assert.equal(anchor.accepted, true, 'anchor_refused')
  if (!anchor.accepted) throw new Error('anchor_refused')
  await stopAndExpire(original.execution)
  const restored = await create(pool.metadata.name, anchor.command)
  assert.notEqual(restored.session, original.session, 'session_reused')
  assert.equal(restored.acpId, original.acpId, 'acp_context_not_restored')
  await prompt(restored, 'native_recall', 'What test marker did I ask you to remember? Reply only that marker. Do not use tools.', 'violet-cedar-471')
  await stopAndExpire(restored.execution)
  const diagnostics = await store.writer.query('SELECT reason,count(*)::text AS count FROM diagnostics WHERE workstream=$1 GROUP BY reason', [workstream])
  assert.equal(diagnostics.rowCount, 0, 'real_transcript_rejected_lines')
  const fixture = { harness: 'claude-code', capturedAt: new Date().toISOString(), workstream,
    image,
    entries: transcript, projectionHash: hash(core.fold(transcript).sort((a, b) => a.id.localeCompare(b.id))) }
  const encoded = encode(fixture)
  for (const token of mintedTokens) assert.equal(encoded.includes(token), false, 'jwt_in_fixture')
  await writeFile(join(output, 'claude-code.json'), encoded + '\n', { mode: 0o600 })
  await writeFile(join(output, 'report.json'), JSON.stringify({ date: new Date().toISOString(), measurements,
    diagnosticCount: diagnostics.rowCount, anchorBytes: raw.length, anchorFiles: bundle.files.length,
    newSession: restored.session !== original.session, sameAcpContext: restored.acpId === original.acpId }, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ result: 'passed', output }))
} finally {
  if (started) {
    for (const execution of executions) await stopAndExpire(execution).catch(() => {})
    await driver.stop()
  }
  await store.close()
}
