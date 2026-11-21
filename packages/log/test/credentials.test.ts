// docs/specs/credentials.md, "On Agora's side": the execution's token before `initialize`, its renewal
// before a prompt, and the profiles a Create may name. Real bridges, a real signer.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { keys } from '@agora/testkit'
import { cluster, database, FakeKube, grants, Lab, lines, Server, until } from './support.ts'

async function started(t: { after(fn: () => Promise<void>): void }, base: Record<string, string> = {}, offered: string[] = []) {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  Object.assign(kube.baseProfiles, base)
  const signer = grants(offered)
  const db = await database()
  const lab = await Lab.start({ db, kube, keys: pair, credentials: signer.source })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  return { kube, lab, signer, ws: await lab.workstream() }
}

test('C10 at the claim, before initialize: a token naming the execution, with the base and the Create’s profiles', async (t) => {
  const { kube, lab, signer, ws } = await started(t, { 'claude-test': 'anthropic' })
  const [pod] = await kube.warmUp('claude-test')
  await until('the Pod warmed', () => signer.minted.some((m) => m.label === `agora warm ${pod!}`))
  const e = await lab.open(ws, { pool: 'claude-test', profiles: ['github:owner/repo:read'] })
  assert.equal(lab.executions.claimOf(e.id)?.status?.sandbox?.name, pod)
  const minted = signer.minted.filter((m) => m.label === `agora ${e.id}`)
  assert.equal(minted.length, 1)
  assert.deepEqual([minted[0]!.sub, [...minted[0]!.profiles]], [`agora ${e.id}`, ['anthropic', 'github:owner/repo:read', 'agora:read', 'previews']])
  const outbound = (await lab.executions.info(e.id)).outbound
  assert.equal(outbound.expiresAt, minted[0]!.expiresAt)
  const initialize = lines(await lab.entries(ws), 'out', 'initialize')[0]!
  const dispatched = (await lab.entries(ws)).find((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === initialize.position)!
  assert.ok(Date.parse(outbound.attachedAt!) <= Date.parse(dispatched.time), `${String(outbound.attachedAt)} before ${dispatched.time}`)
  // No warm token after the execution's.
  assert.ok(signer.minted.filter((m) => m.label === `agora warm ${pod!}`).every((m) => m.at < minted[0]!.at))
})

test('C29 an execution’s token is bound to its Pod’s address as its Sandbox records it, never one the Pod gives', async (t) => {
  const { kube, lab, signer, ws } = await started(t, { 'claude-test': 'anthropic' })
  const [pod] = await kube.warmUp('claude-test')
  kube.addresses.set(pod!, '10.244.0.78')
  const e = await lab.open(ws, { pool: 'claude-test', profiles: ['github:owner/repo:read'] })
  assert.equal(lab.executions.claimOf(e.id)?.status?.sandbox?.name, pod)
  const minted = signer.minted.filter((m) => m.label === `agora ${e.id}`)
  assert.deepEqual(minted.map((m) => m.ip), ['10.244.0.78'])
})

test('C10 a pool declaring no base profile and a Create naming none: a token naming the execution, with the default profiles alone', async (t) => {
  const { lab, signer, ws } = await started(t)
  const e = await lab.open(ws, { pool: 'mock-test' })
  assert.deepEqual(signer.minted.map((m) => [m.sub, [...m.profiles]]), [[`agora ${e.id}`, ['agora:read', 'previews']]])
  assert.equal((await lab.executions.info(e.id)).outbound.expiresAt, signer.minted[0]!.expiresAt)
})

test('C12 an execution whose token would run out during the next turn gets a new one before the prompt leaves', async (t) => {
  const { lab, signer, ws } = await started(t, { 'claude-test': 'anthropic' })
  // A token of turn + lease, 90 s: always less than a turn and a minute left by the next prompt.
  const e = await lab.open(ws, { pool: 'claude-test', limits: { leaseSeconds: 60, turnCapSeconds: 30 } })
  const first = signer.minted.filter((m) => m.label === `agora ${e.id}`)
  assert.equal(first.length, 1)
  assert.ok((await lab.write(ws, 'a turn')).accepted)
  await lab.turn(ws, 'done')
  const tokens = signer.minted.filter((m) => m.label === `agora ${e.id}`)
  assert.equal(tokens.length, 2)
  const prompt = lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!
  const dispatched = (await lab.entries(ws)).find((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === prompt.position)!
  assert.ok(tokens[1]!.at <= Date.parse(dispatched.time))
  assert.equal((await lab.executions.info(e.id)).outbound.expiresAt, tokens[1]!.expiresAt)
})

test('C12 control: a token lasting beyond the turn and a minute is not replaced before the prompt', async (t) => {
  const { lab, signer, ws } = await started(t, { 'claude-test': 'anthropic' })
  const e = await lab.open(ws, { pool: 'claude-test' })
  assert.ok((await lab.write(ws, 'a turn')).accepted)
  await lab.turn(ws, 'done')
  assert.equal(signer.minted.filter((m) => m.label === `agora ${e.id}`).length, 1)
})

test('C12 a token that cannot be renewed fails the prompt, credentials_refused, and nothing is sent', async (t) => {
  const { lab, signer, ws } = await started(t, { 'claude-test': 'anthropic' })
  await lab.open(ws, { pool: 'claude-test', limits: { leaseSeconds: 60, turnCapSeconds: 30 } })
  // Simulated: the signer refuses (stub).
  signer.fail = true
  assert.ok((await lab.write(ws, 'never sent')).accepted)
  const prompt = lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!
  const failed = await until('request.failed', async () => (await lab.entries(ws)).find((x) => x.kind === 'request.failed' && x.content.requestPosition === prompt.position))
  assert.equal(failed.content.reason, 'credentials_refused')
  assert.equal((await lab.entries(ws)).filter((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === prompt.position).length, 0)
  assert.equal([...(await lab.state(ws)).turns.values()].at(-1)?.status, 'failed')
})

/** Agora's MCP server, as `session/new` names it: every execution holds `agora:read` (docs/specs/credentials.md, "Default profiles"). */
const AGORA = { type: 'http', name: 'agora', url: 'https://mcp.agora.internal/mcp', headers: [] }

/** The MCP servers the execution's `session/new` named, as Agora sent it. */
async function opened(lab: Lab, ws: string): Promise<unknown> {
  const opening = lines(await lab.entries(ws), 'out', 'session/new')
  assert.equal(opening.length, 1)
  return (opening[0]!.content.params as { mcpServers?: unknown }).mcpServers
}

test('C43 an execution with vault:read, then one with vault:write: session/new names the vault’s MCP server, over HTTP, with no header, then Agora’s alone', async (t) => {
  const { lab, signer, ws } = await started(t, { 'claude-test': 'anthropic' })
  for (const [workstream, profile] of [[ws, 'vault:read'], [await lab.workstream(), 'vault:write']] as const) {
    const e = await lab.open(workstream, { pool: 'claude-test', profiles: [profile] })
    // The rights to reach it are in the token, through the gateway.
    assert.deepEqual([...signer.minted.find((m) => m.label === `agora ${e.id}`)!.profiles], ['anthropic', profile, 'agora:read', 'previews'])
    const servers = (await opened(lab, workstream)) as { type: string; name: string; url: string; headers: unknown[] }[]
    assert.deepEqual(servers, [{ type: 'http', name: 'vault', url: 'https://vault.bretagne.dev/mcp', headers: [] }, AGORA], profile)
    assert.equal(new URL(servers[0]!.url).origin, 'https://vault.bretagne.dev')
  }
})

test('C43 control: an execution with other profiles and none of the vault, and one with no profile: session/new names Agora’s MCP server alone, the default profiles’', async (t) => {
  const { lab, ws } = await started(t, { 'claude-test': 'anthropic' })
  await lab.open(ws, { pool: 'claude-test', profiles: ['github:owner/repo:read', 'internet'] })
  assert.deepEqual(await opened(lab, ws), [AGORA])
  const bare = await lab.workstream()
  await lab.open(bare, { pool: 'mock-test' })
  assert.deepEqual(await opened(lab, bare), [AGORA])
})

test('M1 an execution naming agora:read, then one naming none of Agora’s profiles: session/new names Agora’s MCP server, over HTTP, with no header, once each time', async (t) => {
  const { lab, ws } = await started(t, { 'claude-test': 'anthropic' })
  await lab.open(ws, { pool: 'claude-test', profiles: ['agora:read'] })
  assert.deepEqual(await opened(lab, ws), [AGORA])
  const unnamed = await lab.workstream()
  await lab.open(unnamed, { pool: 'claude-test', profiles: ['internet', 'github:owner/repo:read'] })
  assert.deepEqual(await opened(lab, unnamed), [AGORA])
})

test('C64 an execution with agora:delegate; one Agora gave agora:submit; one with both and agora:read: session/new names Agora’s MCP server once', async (t) => {
  const { lab, ws } = await started(t, { 'claude-test': 'anthropic' })
  const agora = [{ type: 'http', name: 'agora', url: 'https://mcp.agora.internal/mcp', headers: [] }]
  await lab.open(ws, { pool: 'claude-test', profiles: ['agora:delegate'] })
  assert.deepEqual(await opened(lab, ws), agora)
  // agora:submit is Agora's own: only a Create of Agora's names it (C65).
  for (const profiles of [['agora:submit'], ['agora:read', 'agora:delegate', 'agora:submit']]) {
    const delegate = await lab.workstream()
    assert.equal((await lab.workstreams.command(delegate, { id: randomUUID(), kind: 'Create', target: {}, body: { pool: 'claude-test', profiles } }, 'agora')).accepted, true)
    await until('session/new', async () => lines(await lab.entries(delegate), 'out', 'session/new').length > 0)
    assert.deepEqual(await opened(lab, delegate), agora, profiles.join(','))
  }
})

test('C14 a Create naming an unknown profile is refused, unknown_profile, and nothing is written', async (t) => {
  const { lab, ws } = await started(t)
  assert.deepEqual(await lab.command(ws, 'Create', {}, { pool: 'mock-test', profiles: ['dropbox:everything'] }), { accepted: false, reason: 'unknown_profile' })
  assert.equal((await lab.entries(ws)).length, 0)
  assert.equal(lab.kube.created.length, 0)
})

test('C33 a Create naming limits, the profile Agora gives itself, is refused, unknown_profile, and nothing is written', async (t) => {
  const { lab, ws } = await started(t)
  assert.deepEqual(await lab.command(ws, 'Create', {}, { pool: 'mock-test', profiles: ['limits'] }), { accepted: false, reason: 'unknown_profile' })
  assert.equal((await lab.entries(ws)).length, 0)
  assert.equal(lab.kube.created.length, 0)
  // Control: the same Create without it is accepted.
  assert.equal((await lab.command(ws, 'Create', {}, { pool: 'mock-test', profiles: [] })).accepted, true)
})

test('C20 github:A:write and github:B:read offered: a Create may name A read or write, not B write', async (t) => {
  const { lab, ws } = await started(t, {}, ['github:owner/a:write', 'github:owner/b:read'])
  const create = async (profiles: string[]) => lab.command(await lab.workstream(), 'Create', {}, { pool: 'mock-test', profiles })
  assert.ok((await create(['github:owner/a:read'])).accepted)
  assert.ok((await create(['github:owner/a:write', 'github:owner/b:read'])).accepted)
  assert.deepEqual(await lab.command(ws, 'Create', {}, { pool: 'mock-test', profiles: ['github:owner/b:write'] }), { accepted: false, reason: 'profile_not_offered' })
  assert.equal((await lab.entries(ws)).length, 0)
})

/** What the execution's bridge wrote for its agent: the claims of the token it holds (docs/specs/credentials.md, "The bridge"). */
function access(lab: Lab, execution: string): { sub?: string; profiles?: string[] } {
  const pod = lab.executions.claimOf(execution)?.status?.sandbox?.name
  const bridge = pod === undefined ? undefined : lab.kube.bridges.get(pod)
  if (bridge === undefined) throw new Error(`no bridge for ${execution}`)
  return JSON.parse(readFileSync(join(bridge.home, '.agora', 'access.json'), 'utf8')) as { sub?: string; profiles?: string[] }
}

test('C74 a person’s Create naming github:A:read, then one naming nothing: each execution holds agora:read and previews after its own, in the log, its token and its bridge’s access.json', async (t) => {
  const { lab, signer, ws } = await started(t, { 'claude-test': 'anthropic' })
  for (const [workstream, named] of [[ws, ['github:owner/repo:read']], [await lab.workstream(), []]] as const) {
    const e = await lab.open(workstream, { pool: 'claude-test', profiles: [...named] })
    const own = [...named, 'agora:read', 'previews']
    const create = (await lab.entries(workstream)).find((x) => x.kind === 'command' && x.content.kind === 'Create')!
    assert.deepEqual((create.content.body as { profiles?: unknown }).profiles, own, 'recorded with the command')
    assert.deepEqual((await lab.state(workstream)).current?.profiles, own)
    const view = (await lab.workstreams.projections.objects(workstream)).find((o) => o.kind === 'workstream')!.object
    assert.deepEqual(view.profiles, own, 'the Workstream view')
    const minted = signer.minted.filter((m) => m.label === `agora ${e.id}`)
    assert.deepEqual(minted.map((m) => [...m.profiles]), [['anthropic', ...own]])
    const file = await until('access.json', () => {
      try {
        const claims = access(lab, e.id)
        return claims.sub === `agora ${e.id}` ? claims : null
      } catch {
        return null
      }
    })
    assert.deepEqual(file.profiles, ['anthropic', ...own])
  }
})

test('C75 previews and agora:read in OFFERED_PROFILES or not: the offer leaves both out; a Create and a Scope may name them; another profile not offered, profile_not_offered; an unknown one, unknown_profile', async (t) => {
  for (const offered of [['github:owner/a:write', 'internet', 'previews', 'agora:read'], ['github:owner/a:write', 'internet']]) {
    const { lab, signer, ws } = await started(t, {}, offered)
    assert.deepEqual(signer.source.describe?.().offered, ['github:owner/a:write', 'internet'], offered.join(','))
    const named = await lab.command(ws, 'Create', {}, { pool: 'mock-test', profiles: ['previews', 'agora:read', 'internet'] })
    assert.ok(named.accepted, JSON.stringify(named))
    assert.deepEqual((await lab.state(ws)).current?.profiles, ['previews', 'agora:read', 'internet'], 'each once, as named')
    const e = (await lab.state(ws)).current!
    await until('the Session', async () => ((await lab.state(ws)).current?.session ? true : null))
    assert.ok((await lab.command(ws, 'Scope', { execution: e.id }, { profiles: ['agora:read'] })).accepted)
    assert.deepEqual((await lab.state(ws)).current?.profiles, ['agora:read'])
    // The refusals as before, beside a default: nothing written, by a Create in a Workstream of its own or by a Scope.
    const fresh = await lab.workstream()
    const before = (await lab.entries(ws)).length
    for (const kind of ['Create', 'Scope'] as const) {
      const command = (profiles: string[]) => (kind === 'Create' ? lab.command(fresh, 'Create', {}, { pool: 'mock-test', profiles }) : lab.command(ws, 'Scope', { execution: e.id }, { profiles }))
      assert.deepEqual(await command(['previews', 'github:owner/b:read']), { accepted: false, reason: 'profile_not_offered' }, kind)
      assert.deepEqual(await command(['agora:read', 'kubernetes:read']), { accepted: false, reason: 'profile_not_offered' }, kind)
      assert.deepEqual(await command(['agora:read', 'dropbox:everything']), { accepted: false, reason: 'unknown_profile' }, kind)
    }
    assert.deepEqual([(await lab.entries(fresh)).length, (await lab.entries(ws)).length], [0, before])
    assert.equal((await lab.state(ws)).current?.id, e.id)
  }
})

test('C75 the server started with OFFERED_PROFILES listing previews and agora:read, then without them: it starts each time, and GET /api/config offers neither', async (t) => {
  const db = await database()
  const c = await cluster()
  const dir = mkdtempSync(join(tmpdir(), 'grants-'))
  writeFileSync(join(dir, 'key.pem'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  let server: Server | undefined
  t.after(async () => {
    await server?.stop()
    await c.close()
    await db.drop()
  })
  for (const offered of ['github:owner/a:write,previews,internet,agora:read', 'github:owner/a:write,internet']) {
    server = await Server.start({ db, api: c.api, keys: c.keys, env: { GATEWAY_PROXY: '127.0.0.1:9', GRANTS_KEY_FILE: join(dir, 'key.pem'), OFFERED_PROFILES: offered } })
    const config = (await (await fetch(`${server.url}/api/config`)).json()) as { credentials: { offered: string[] } | null }
    assert.deepEqual(config.credentials?.offered, ['github:owner/a:write', 'internet'], offered)
    await server.stop()
    server = undefined
  }
})
