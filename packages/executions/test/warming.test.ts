// Warming (docs/specs/credentials.md, "On Agora's side"): the mechanics hand the pools' waiting Pods a
// token with their base profiles, renew it, and stop at the claim. Real bridges, a real signer.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GrantSigner } from '@agora/credentials'
import { mintBridgeToken } from '@agora/harness-bridge/token'
import type { Credentials, OutboundView } from '@agora/harness-bridge/outbound'
import { keys } from '@agora/testkit'
import { claimName, ExecutionManager, type CredentialSource, type Handler } from '../src/manager.ts'
import { FakeKube } from './fake-kube.ts'

async function until<T>(what: string, find: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await find()
    if (found !== undefined && found !== null && found !== false) return found
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const quiet: Handler = { async claim() {}, async connected() { return true }, async line() {}, async closed() {} }

/** A real signer, and what it minted: label, profiles, the token's own claims. */
function signer(): { source: CredentialSource; minted: { label: string; profiles: readonly string[]; sub: string; exp: number; at: number }[]; delay: (label: string) => number } {
  const dir = mkdtempSync(join(tmpdir(), 'grants-'))
  writeFileSync(join(dir, 'key.pem'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const real = new GrantSigner({ proxy: '127.0.0.1:9', keyFile: join(dir, 'key.pem'), keyId: 'k', issuer: 'agora', audience: 'agora-gateway' })
  const minted: { label: string; profiles: readonly string[]; sub: string; exp: number; at: number }[] = []
  const box = { delay: (_label: string) => 0 }
  return {
    minted,
    get delay() {
      return box.delay
    },
    set delay(value) {
      box.delay = value
    },
    source: {
      describe: () => real.describe(),
      async mint(input) {
        await new Promise((resolve) => setTimeout(resolve, box.delay(input.label)))
        const credentials = await real.mint(input)
        const payload = JSON.parse(Buffer.from(credentials.token.split('.')[1]!, 'base64url').toString()) as { sub: string; exp: number }
        minted.push({ label: input.label, profiles: input.profiles ?? [], sub: payload.sub, exp: payload.exp, at: Date.now() })
        return credentials
      },
    },
  }
}

async function outbound(kube: FakeKube, privateKey: Parameters<typeof mintBridgeToken>[0], pod: string): Promise<OutboundView> {
  const info = await fetch(`http://${kube.address('', pod)}/info`, { headers: { authorization: `Bearer ${mintBridgeToken(privateKey, pod)}` } })
  return ((await info.json()) as { outbound: OutboundView }).outbound
}

async function lab(t: { after(fn: () => Promise<void>): void }, options: { warmTtlSeconds?: number } = {}) {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  const grants = signer()
  const manager = new ExecutionManager({
    kube,
    signingKey: pair.privateKey,
    bridgePort: 8080,
    bridgeAddress: kube.address,
    tickMs: 100,
    reconnectMs: 200,
    credentials: grants.source,
    warmEveryMs: 200,
    ...options,
  })
  t.after(async () => {
    await manager.stop()
    await kube.closeAll()
  })
  return { kube, manager, grants, privateKey: pair.privateKey }
}

test('C8 a warm Pod of a pool declaring anthropic gets a token naming it, with that profile only; a pool declaring none, nothing', async (t) => {
  const { kube, manager, grants, privateKey } = await lab(t)
  kube.baseProfiles['claude-test'] = 'anthropic'
  const [declared] = await kube.warmUp('claude-test')
  const [bare] = await kube.warmUp('mock-test')
  await manager.start(quiet)
  const attached = await until('the warm token attached', async () => (await outbound(kube, privateKey, declared!)).proxy !== null)
  assert.ok(attached)
  const warm = grants.minted.filter((m) => m.label === `agora warm ${declared!}`)
  assert.equal(warm.length, 1)
  assert.deepEqual([warm[0]!.sub, [...warm[0]!.profiles]], [`agora warm ${declared!}`, ['anthropic']])
  assert.equal((await outbound(kube, privateKey, declared!)).expiresAt, new Date(warm[0]!.exp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
  // The other pool's Pod: nothing minted, no way out.
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(grants.minted.filter((m) => m.label.includes(bare!)).length, 0)
  assert.equal((await outbound(kube, privateKey, bare!)).proxy, null)
  assert.deepEqual((await manager.pools()).map((p) => [p.name, [...p.baseProfiles], p.refusedProfile]), [
    ['mock-test', [], null],
    ['claude-test', ['anthropic'], null],
  ])
})

test('C8 a pool declaring a repository among its base profiles gets no warm token, and shows the refused profile', async (t) => {
  const { kube, manager, grants } = await lab(t)
  kube.baseProfiles['claude-test'] = 'anthropic,github:o/r:read'
  await kube.warmUp('claude-test')
  await manager.start(quiet)
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(grants.minted.length, 0)
  assert.equal((await manager.pools()).find((p) => p.name === 'claude-test')?.refusedProfile, 'github:o/r:read')
})

test('C9 a warm Pod waiting beyond two thirds of its token’s life gets a new one before it expires', async (t) => {
  // A 60 s token, the shortest the signer gives: renewed after 40 s.
  const { kube, manager, grants, privateKey } = await lab(t, { warmTtlSeconds: 60 })
  kube.baseProfiles['claude-test'] = 'anthropic'
  const [pod] = await kube.warmUp('claude-test')
  await manager.start(quiet)
  await until('first token', () => grants.minted.length === 1)
  const first = grants.minted[0]!
  await until('a new token', () => grants.minted.length === 2, 50_000)
  const second = grants.minted[1]!
  assert.ok(second.at < first.exp * 1000, 'renewed before the first expired')
  assert.ok(second.at - first.at >= 39_000, `renewed after ${String(second.at - first.at)} ms`)
  await until('the new one attached', async () => (await outbound(kube, privateKey, pod!)).expiresAt === new Date(second.exp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
})

test('C11 a warm token being handed over when the claim binds the Pod: the execution’s token is the one in place', async (t) => {
  const { kube, manager, grants, privateKey } = await lab(t)
  kube.baseProfiles['claude-test'] = 'anthropic'
  const [pod] = await kube.warmUp('claude-test')
  // Simulated: the warm token's signing held 1.5 s, so that the claim binds the Pod meanwhile (stub).
  let warming = false
  grants.delay = (label) => {
    if (!label.startsWith('agora warm')) return 0
    warming = true
    return 1500
  }
  await manager.start(quiet)
  await until('a warm token being signed', () => warming)
  const execution = randomUUID()
  const target = { execution, claimName: claimName(execution), pool: 'claude-test' }
  await manager.run(target)
  await manager.createClaim(target, new Date(Date.now() + 120_000).toISOString())
  await until('the Pod adopted', () => manager.claimOf(execution)?.status?.sandbox?.name === pod)
  const credentials: Credentials = await grants.source.mint({ label: `agora ${execution}`, ttlSeconds: 3000, profiles: ['anthropic'] })
  await manager.putCredentials(execution, credentials)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.equal((await outbound(kube, privateKey, pod!)).expiresAt, credentials.expiresAt)
  assert.equal(grants.minted.filter((m) => m.label.startsWith('agora warm')).length, 1)
})
