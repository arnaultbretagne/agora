// Isolate Session startup from journal/projector work and model generation on a real warm Pod.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { HttpKube, privateKeyFrom } from '@agora/executions'
import { GrantSigner } from '@agora/credentials'
import { mintBridgeToken } from '@agora/harness-bridge/token'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name}_required`)
  return value
}
const namespace = required('LOG_LIVE_NAMESPACE'), output = required('LOG_LIVE_OUTPUT_DIR')
const credentialOrder = process.env.LOG_STARTUP_AUTH ?? 'before'
assert.ok(['before', 'after'].includes(credentialOrder), 'invalid_credential_order')
const sdkWarm = process.env.LOG_STARTUP_SDK_WARM === 'true'
assert.ok(!sdkWarm || credentialOrder === 'before', 'sdk_warm_requires_credentials')
const kube = new HttpKube({ apiBase: required('LOG_LIVE_KUBE_API'), namespace, tokenFile: required('LOG_LIVE_KUBE_TOKEN_FILE') })
const signingKey = privateKeyFrom(await readFile(required('LOG_LIVE_SIGNING_KEY_FILE'), 'utf8'))
const signer = new GrantSigner({ proxy: required('LOG_LIVE_GATEWAY_PROXY'), keyFile: required('LOG_LIVE_GRANTS_KEY_FILE'),
  keyId: 'agora-grants-1', issuer: 'agora', audience: 'agora-gateway' })
const kubectl = JSON.parse(required('LOG_LIVE_KUBECTL_COMMAND')) as string[]
const execution = randomUUID(), name = `sbx-startup-${execution.slice(0, 8)}`
const results: Record<string, unknown>[] = []
let socket: WebSocket | undefined, podName: string | undefined, image: unknown
async function until<T>(read: () => Promise<T | false>, ms = 60000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== false) return value
    if (Date.now() >= end) throw new Error('startup_timeout')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
async function podExec(code: string): Promise<string> {
  assert.ok(podName)
  return (await promisify(execFile)(kubectl[0]!, [...kubectl.slice(1), 'exec', '-n', namespace, podName,
    '--', 'node', '--input-type=module', '-e', code], { maxBuffer: 2 * 1024 * 1024 })).stdout
}
try {
  await mkdir(output, { recursive: true, mode: 0o700 })
  const pool = (await kube.listPools('agora.bretagne.dev/harness=claude-code'))[0]!
  assert.ok(pool && Number(pool.status?.readyReplicas) > 0, 'ready_warm_pod_required')
  const before = performance.now()
  await kube.createClaim({ apiVersion: 'extensions.agents.x-k8s.io/v1beta1', kind: 'SandboxClaim',
    metadata: { name, labels: { 'app.kubernetes.io/managed-by': 'agora-startup', 'agora.bretagne.dev/execution-id': execution } },
    spec: { warmPoolRef: { name: pool.metadata.name }, lifecycle: { shutdownTime: new Date(Date.now() + 240000).toISOString(), shutdownPolicy: 'DeleteForeground' } } })
  const claim = await until(async () => {
    const value = await kube.getClaim(name)
    return value?.status?.conditions?.some((v) => v.type === 'Ready' && v.status === 'True') ? value : false
  })
  results.push({ case: 'warm_claim_ready', ms: performance.now() - before })
  podName = claim.status!.sandbox!.name
  const pod = await kube.getPod(podName!) as Record<string, any>
  image = pod.spec.containers[0].image
  const address = `${pod.status.podIP}:8080`, headers = { authorization: `Bearer ${mintBridgeToken(signingKey, podName!)}` }
  const info = async () => (await (await fetch(`http://${address}/info`, { headers })).json()) as Record<string, any>
  const credentials = await signer.mint({ label: `agora ${name}`, ttlSeconds: 600, profiles: ['anthropic'] })
  const attach = async () => assert.equal((await fetch(`http://${address}/credentials`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(credentials) })).status, 200)
  if (credentialOrder === 'before') await attach()
  const replies = new Map<string, { resolve: (value: any) => void }>()
  socket = new WebSocket(`ws://${address}/acp`, { headers })
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id !== undefined && message.method === undefined) replies.get(String(message.id))?.resolve(message)
  })
  socket.on('error', () => {})
  await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
  let next = 0
  async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
    const id = String(++next), started = performance.now()
    const reply = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { replies.delete(id); reject(new Error('rpc_timeout')) }, 90000)
      replies.set(id, { resolve: (value) => { clearTimeout(timer); replies.delete(id); resolve(value) } })
      socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
    assert.equal(reply.error, undefined, 'rpc_refused')
    const result = { case: method, ms: performance.now() - started }
    results.push(result)
    console.log(JSON.stringify(result))
    return reply.result
  }
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agora-startup-measurement', version: '0.0.0' } })
  const initial = await info()
  const cwd = initial.workspace
  let warmQuery: unknown
  if (sdkWarm) {
    // Exercise the SDK bundled with this exact adapter. Keep its input stream empty: no model call.
    warmQuery = JSON.parse(await podExec(`import assert from 'node:assert/strict';
      import {readFile,readdir} from 'node:fs/promises';
      import {createRequire} from 'node:module';
      import {pathToFileURL} from 'node:url';
      const root='/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp';
      const req=createRequire(root+'/package.json');
      const sdk=await import(pathToFileURL(req.resolve('@anthropic-ai/claude-agent-sdk')).href);
      const {claudeCliPath}=await import(root+'/dist/acp-agent.js');
      let adapterEnv;
      for(const pid of await readdir('/proc')) {
        if(!/^\\d+$/.test(pid)) continue;
        try {
          const cmd=await readFile('/proc/'+pid+'/cmdline','utf8');
          if(cmd.includes(root+'/dist/index.js')&&!cmd.includes('--input-type')) {
            adapterEnv=Object.fromEntries((await readFile('/proc/'+pid+'/environ','utf8'))
              .split('\\0').filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)]}));
            break;
          }
        } catch {}
      }
      assert.ok(adapterEnv?.HTTPS_PROXY,'adapter_proxy_required');
      const started=performance.now();
      const warm=await sdk.startup({options:{cwd:${JSON.stringify(cwd)},env:adapterEnv,
        pathToClaudeCodeExecutable:await claudeCliPath(),settingSources:['user','project','local']}});
      const startupMs=performance.now()-started;
      let release;
      const idle=new Promise(resolve=>{release=resolve});
      const input={async *[Symbol.asyncIterator](){await idle}};
      try {
        const reused=performance.now();
        const q=warm.query(input);
        await q.initializationResult();
        const reuseMs=performance.now()-reused;
        q.close();
        process.stdout.write(JSON.stringify({startupMs,reuseMs,modelPrompts:0,
          scope:'SDK startup/reuse proof after claim; the ACP adapter has no prewarm integration.'}));
      } finally {release();warm.close()}`))
  }
  for (const label of sdkWarm ? [] : ['first_query', 'second_query']) {
    const opened = await rpc('session/new', { cwd, mcpServers: [],
      _meta: { claudeCode: { options: { extraArgs: { 'debug-file': `/tmp/agora-cli-${label}.log` } } } } })
    results.at(-1)!.query = label
    results.at(-1)!.sessionId = opened.sessionId
    await rpc('session/close', { sessionId: opened.sessionId })
    if (credentialOrder === 'after' && label === 'first_query') await attach()
  }
  const phases = sdkWarm ? [] : JSON.parse(await podExec(`import {readFile} from 'node:fs/promises';
    const s=await readFile('/tmp/agora-acp-startup/agent.log','utf8');
    const allowed=new Set(['validate-cwd','resume-transcript','settings','prepare-query','sdk-initialize','models','modes','agents','register']);
    const rows=s.split('\\n').flatMap(l=>{const m=/\\[session\\/(create|load)\\] sessionId=([0-9a-f-]+) phase=([a-z-]+) durationMs=(\\d+) totalMs=(\\d+)/.exec(l);
    return m&&allowed.has(m[3])?[{operation:m[1],sessionId:m[2],phase:m[3],durationMs:Number(m[4]),totalMs:Number(m[5])}]:[]});
    process.stdout.write(JSON.stringify(rows))`))
  const sdkCliVersion = (await podExec(`import {claudeCliPath} from '/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js';
    import {execFileSync} from 'node:child_process';
    process.stdout.write(execFileSync(await claudeCliPath(),['--version'],{encoding:'utf8'}).trim())`)).trim()
  const outbound = (await info()).outbound
  const report = { date: new Date().toISOString(), image, sdkCliVersion, warmPodBeforeClaim: true,
    credentialsBeforeInitialize: credentialOrder === 'before', modelPrompts: 0, scope: 'Direct bridge/ACP timings; no journal, projector or model generation.', results, phases, outbound }
  if (sdkWarm) Object.assign(report, { warmQuery })
  const encoded = JSON.stringify(report, null, 2)
  assert.equal(encoded.includes(credentials.token), false, 'jwt_in_report')
  const path = join(output, sdkWarm ? 'startup-sdk-warm.json' : `startup-${credentialOrder}.json`)
  await writeFile(path, encoded + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ phases, warmQuery, outbound, report: path }))
} finally {
  socket?.close()
  const claim = await kube.getClaim(name)
  if (claim) await kube.patchClaim(name, { metadata: { uid: claim.metadata.uid },
    spec: { lifecycle: { shutdownTime: new Date().toISOString() } } })
}
