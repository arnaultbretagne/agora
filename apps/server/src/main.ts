// The server: the execution mechanics (packages/executions) and the log (packages/log) mounted together,
// serving the client (apps/web) at `/`; with TEST_ROUTES, the test routes and the page that plays the
// cases of docs/specs/executions.md, credentials.md and log.md. Configuration comes from the environment.
// With PREVIEW=true, a preview (docs/specs/preview.md): nothing of production, the mock agent in this process.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAnchorReceiver, createApi, ExecutionManager, HttpKube, privateKeyFrom, type KubeApi } from '@agora/executions'
import { Delegations, Files, Identity, LogStore, Merges, Workstreams, applyOwnerSchema, createMcpServer, describeRoles, loadRoles, logHttp, refuseUnproven, telemetry } from '@agora/log'
import { GrantSigner, OperatorGitHub, SubscriptionLimits, limitsHttp, offeredProfiles } from '@agora/credentials'
import { serveClient } from './client.ts'
import { MemoryFiles, NAMESPACE, PreviewKube, SHARED_OWNER, previewDatabase, previewKeys } from './preview.ts'
import { writeSeeds } from './seeds.ts'

function number(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
  return value
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

const sink = (line: string): void => console.log(line)
// docs/specs/preview.md: its database, migrated and given its conversations by the server itself; its key made here;
// its sandboxes in this process, pushing their anchors to this server's receiver.
const preview =
  process.env.PREVIEW === 'true'
    ? await (async () => {
        const database = previewDatabase(process.env)
        await applyOwnerSchema(database)
        const written = await writeSeeds(database, SHARED_OWNER)
        if (written > 0) console.log(`- preview: ${String(written)} conversations written`)
        const keys = previewKeys()
        return { database, keys, kube: new PreviewKube(keys.publicKey, `http://127.0.0.1:${String(number('ANCHOR_PORT', 8081))}/anchors`) }
      })()
    : null
const namespace = preview === null ? required('SANDBOX_NAMESPACE') : NAMESPACE
// docs/specs/log.md, "Identity": who calls port 8080, `oidc` or `none`, named; a preview's is `none`.
const identity = preview === null ? Identity.fromEnv(process.env) : Identity.none()
const audience = process.env.ANCHOR_AUDIENCE ?? 'agora-anchors'
const testRoutes = process.env.TEST_ROUTES === 'true'
const kube: KubeApi =
  preview?.kube ??
  new HttpKube({
    apiBase: process.env.KUBE_API ?? 'https://kubernetes.default.svc',
    namespace,
    tokenFile: process.env.KUBE_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
  })
// docs/specs/credentials.md: without the gateway, executions have no credential and no way out.
const credentials =
  process.env.GATEWAY_PROXY === undefined || process.env.GATEWAY_PROXY === ''
    ? undefined
    : new GrantSigner({
        proxy: process.env.GATEWAY_PROXY,
        keyFile: required('GRANTS_KEY_FILE'),
        keyId: process.env.GRANTS_KEY_ID ?? 'agora-grants-1',
        issuer: process.env.GRANTS_ISSUER ?? 'agora',
        audience: process.env.GRANTS_AUDIENCE ?? 'agora-gateway',
        // What the interface offers beyond the pools' base profiles; an unknown profile stops the server here.
        offered: offeredProfiles(process.env.OFFERED_PROFILES),
      })
// docs/specs/credentials.md, "Limits": the accounts' limits, read through the gateway from the server's
// own address (POD_IP), checked against the gateway's root (GATEWAY_CA_FILE). Without them, none.
const podAddress = process.env.POD_IP ?? ''
const limits =
  credentials === undefined || podAddress === ''
    ? undefined
    : new SubscriptionLimits({
        signer: credentials,
        address: podAddress,
        profiles: async () => (await executions.pools()).flatMap((pool) => pool.baseProfiles),
        ...(process.env.GATEWAY_CA_FILE ? { ca: readFileSync(process.env.GATEWAY_CA_FILE, 'utf8') } : {}),
      })
// docs/specs/files.md, "The server": the files' bucket; without it, the server does not start.
const store =
  preview === null
    ? new LogStore({ writer: required('LOG_WRITER_URL'), projector: required('LOG_PROJECTOR_URL'), anchors: required('LOG_ANCHORS_URL') }, 12, Files.fromEnv(process.env))
    : LogStore.owner(preview.database, 4, new MemoryFiles())
const executions = new ExecutionManager({
  kube,
  signingKey: preview?.keys.privateKey ?? privateKeyFrom(readFileSync(required('SIGNING_KEY_FILE'), 'utf8')),
  bridgePort: number('BRIDGE_PORT', 8080),
  // docs/specs/credentials.md: the pools' Pods are warmed with their base profiles.
  ...(credentials === undefined ? {} : { credentials }),
})
// A fault point for tests (docs/reliability/README.md, rule 4): AGORA_FAULT=<point>[:<method>] kills
// this process there, as a crash would.
const faultSpec = process.env.AGORA_FAULT
// docs/specs/roles.md, "Cards": the roles a Workstream may start as. A card that cannot be read stops the start, saying which.
const roles = loadRoles(process.env.ROLES_DIR ?? join(import.meta.dirname, '..', '..', '..', 'roles'))
const workstreams = new Workstreams({
  ...(faultSpec
    ? {
        fault: (point: string, detail: { method?: string | null }) => {
          const [at, method] = faultSpec.split(':')
          if (point === at && (method === undefined || detail.method === method)) process.kill(process.pid, 'SIGKILL')
        },
      }
    : {}),
  store,
  executions,
  defaults: { leaseSeconds: number('LEASE_SECONDS', 600), turnCapSeconds: number('TURN_CAP_SECONDS', 3600) },
  maxActive: number('MAX_ACTIVE', 4),
  renewSeconds: number('RENEW_SECONDS', 60),
  sink,
  roles,
  ...(credentials === undefined ? {} : { credentials }),
})

try {
  // docs/specs/delegation.md: the engine behind `spawn_agent`, `send_message`, `stop_agent` and `list_agents`; an approval held 4 min 30 s.
  new Delegations(workstreams, { approvalMs: number('APPROVAL_SECONDS', 270) * 1000 })
  // docs/specs/merge.md: the merge card, through the gateway from the server's own address, as the operator.
  // With the test routes, GITHUB_TEST_API stands in for GitHub behind the gateway (docs/specs/merge.md, G8).
  const githubTest = testRoutes && process.env.GITHUB_TEST_API ? process.env.GITHUB_TEST_API : null
  if (credentials !== undefined && podAddress !== '')
    new Merges(workstreams, {
      github: new OperatorGitHub({
        signer: credentials,
        address: podAddress,
        ...(process.env.GATEWAY_CA_FILE ? { ca: readFileSync(process.env.GATEWAY_CA_FILE, 'utf8') } : {}),
        ...(githubTest === null
          ? {}
          : {
              request: async (input) => {
                const r = await fetch(`${githubTest}${input.path}`, { method: input.method ?? 'GET', headers: { 'content-type': 'application/json' }, ...(input.body === undefined ? {} : { body: input.body }) })
                return { status: r.status, body: await r.text() }
              },
            }),
      }),
    })
  await workstreams.start()
} catch (error) {
  // Another server owns the database (docs/specs/log.md, "Database ownership"): refused, not failed.
  const owned = error instanceof Error && error.message === 'dispatch_owner_exists'
  telemetry({ operation: 'recover', outcome: owned ? 'refused' : 'failed', errorClass: owned ? 'conflict' : 'database' }, sink)
  process.exit(1)
}

const client = serveClient(process.env.CLIENT_DIR ?? join(import.meta.dirname, '..', '..', 'web', 'dist'))
const server = createApi({
  manager: executions,
  testRoutes,
  testPage: join(import.meta.dirname, '..', 'public', 'index.html'),
  // docs/specs/roles.md, "Cards": what `GET /api/config` says of the roles, never a persona.
  roles: describeRoles(roles),
  // docs/specs/log.md, "Identity": every route of the port asks for a proof, the health check alone excepted.
  handle: async (req, res) =>
    (new URL(req.url ?? '/', 'http://agora').pathname !== '/healthz' && (await refuseUnproven(identity, req, res))) ||
    (await limitsHttp(limits, req, res)) ||
    (await logHttp(workstreams, req, res, { testRoutes, identity, ...(credentials === undefined ? {} : { credentials }), ...(preview === null ? {} : { owner: SHARED_OWNER }) })) ||
    client(req, res),
  ...(credentials === undefined ? {} : { credentials }),
  // docs/specs/executions.md, "The server": a clean stop drains like a SIGTERM; a kill ends the process
  // on the spot, nothing drained or written. In a container the server is PID 1, which cannot SIGKILL
  // itself: it exits at once instead, with the status a kill leaves.
  onRestart: (mode) => (mode === 'kill' ? process.exit(137) : process.kill(process.pid, 'SIGTERM')),
})
server.listen(number('PORT', 8080), () => console.log(`- server ready on :${String(number('PORT', 8080))}`))
const receiver = createAnchorReceiver({
  receive: (pod, bundle, raw) => workstreams.receiveAnchor(pod, bundle, raw),
  namespace,
  verify: (token) => kube.reviewToken(token, audience),
})
receiver.listen(number('ANCHOR_PORT', 8081), () => console.log(`- anchor receiver on :${String(number('ANCHOR_PORT', 8081))}`))
// docs/specs/mcp.md: Agora's MCP server, on a port only the gateway reaches.
const mcp = createMcpServer(workstreams)
mcp.listen(number('MCP_PORT', 8082), () => console.log(`- MCP server on :${String(number('MCP_PORT', 8082))}`))

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // docs/specs/log.md, "Backpressure and shutdown": 5 s to drain, then whatever is left breaks uncleanly.
    const forceExit = setTimeout(() => process.exit(0), 8000)
    void workstreams
      .stop()
      .then(() => store.close())
      .finally(() => {
        clearTimeout(forceExit)
        server.close()
        receiver.close()
        mcp.close()
        process.exit(0)
      })
  })
}
