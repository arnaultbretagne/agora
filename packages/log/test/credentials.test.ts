// docs/specs/credentials.md, "On Agora's side": the execution's token before `initialize`, its renewal
// before a prompt, and the profiles a Create may name. Real bridges, a real signer.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keys } from '@agora/testkit'
import { database, FakeKube, grants, Lab, lines, until } from './support.ts'

async function started(t: { after(fn: () => Promise<void>): void }, base: Record<string, string> = {}) {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  Object.assign(kube.baseProfiles, base)
  const signer = grants()
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
  assert.deepEqual([minted[0]!.sub, [...minted[0]!.profiles]], [`agora ${e.id}`, ['anthropic', 'github:owner/repo:read']])
  const outbound = (await lab.executions.info(e.id)).outbound
  assert.equal(outbound.expiresAt, minted[0]!.expiresAt)
  const initialize = lines(await lab.entries(ws), 'out', 'initialize')[0]!
  const dispatched = (await lab.entries(ws)).find((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === initialize.position)!
  assert.ok(Date.parse(outbound.attachedAt!) <= Date.parse(dispatched.time), `${String(outbound.attachedAt)} before ${dispatched.time}`)
  // No warm token after the execution's.
  assert.ok(signer.minted.filter((m) => m.label === `agora warm ${pod!}`).every((m) => m.at < minted[0]!.at))
})

test('C10 a pool declaring no base profile and a Create naming none: no token, initialize all the same', async (t) => {
  const { lab, signer, ws } = await started(t)
  const e = await lab.open(ws, { pool: 'mock-test' })
  assert.deepEqual(signer.minted, [])
  assert.equal((await lab.executions.info(e.id)).outbound.proxy, null)
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

test('C14 a Create naming an unknown profile is refused, unknown_profile, and nothing is written', async (t) => {
  const { lab, ws } = await started(t)
  assert.deepEqual(await lab.command(ws, 'Create', {}, { pool: 'mock-test', profiles: ['dropbox:everything'] }), { accepted: false, reason: 'unknown_profile' })
  assert.equal((await lab.entries(ws)).length, 0)
  assert.equal(lab.kube.created.length, 0)
})
