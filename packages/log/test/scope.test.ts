// docs/specs/log.md, "Commands" (Scope), and docs/specs/credentials.md, "On Agora's side": an
// execution's own profiles changed between turns, its token following. Real bridges, a real signer.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { keys } from '@agora/testkit'
import type { Execution } from '../src/index.ts'
import { database, FakeKube, grants, Lab, lines, until } from './support.ts'

const A = 'github:owner/a:write'
const B = 'github:owner/b:read'

async function started(t: { after(fn: () => Promise<void>): void }, base: Record<string, string> = {}) {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  Object.assign(kube.baseProfiles, base)
  const signer = grants([A, B])
  const db = await database()
  const context = { signer, lab: await Lab.start({ db, kube, keys: pair, credentials: signer.source }), ws: '' }
  context.ws = await context.lab.workstream()
  t.after(async () => {
    await context.lab.close()
    await db.drop()
  })
  return context
}

const tokensOf = (signer: ReturnType<typeof grants>, e: Execution) => signer.minted.filter((m) => m.label === `agora ${e.id}`)
const view = async (lab: Lab, ws: string) => (await lab.workstreams.projections.objects(ws)).find((o) => o.kind === 'workstream')!.object

/** When the latest prompt was dispatched. */
async function promptDispatched(lab: Lab, ws: string): Promise<number> {
  const prompt = lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!
  return Date.parse((await lab.entries(ws)).find((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === prompt.position)!.time)
}

test('C17 a Scope between turns: at once a token naming the base profiles and the Scope’s; the next prompt leaves without another', async (t) => {
  const { lab, signer, ws } = await started(t, { 'claude-test': 'anthropic' })
  const e = await lab.open(ws, { pool: 'claude-test', profiles: [B] })
  assert.deepEqual(tokensOf(signer, e).map((m) => [...m.profiles]), [['anthropic', B]])
  const scope = await lab.command(ws, 'Scope', { execution: e.id }, { profiles: ['github:owner/a:read'] })
  assert.ok(scope.accepted)
  const tokens = tokensOf(signer, e)
  assert.deepEqual(tokens.map((m) => [...m.profiles]), [['anthropic', B], ['anthropic', 'github:owner/a:read']])
  assert.equal((await lab.executions.info(e.id)).outbound.expiresAt, tokens[1]!.expiresAt)
  assert.ok((await lab.write(ws, 'with the new access')).accepted)
  await lab.turn(ws, 'done')
  assert.equal(tokensOf(signer, e).length, 2)
})

test('C17 a Scope leaving no profile at all, after a token: a token with no grant at once; none at the next prompt', async (t) => {
  const { lab, signer, ws } = await started(t)
  const e = await lab.open(ws, { profiles: [A] })
  assert.ok((await lab.command(ws, 'Scope', { execution: e.id }, { profiles: [] })).accepted)
  assert.deepEqual(tokensOf(signer, e).map((m) => [...m.profiles]), [[A], []])
  assert.ok((await lab.write(ws, 'no access')).accepted)
  await lab.turn(ws, 'done')
  assert.equal(tokensOf(signer, e).length, 2)
})

test('C18 a Scope during a turn, naming a profile not offered, or one the catalogue does not know: refused, no token', async (t) => {
  const { lab, signer, ws } = await started(t)
  const e = await lab.open(ws, { profiles: [B] })
  assert.ok((await lab.write(ws, '/sleep 3')).accepted)
  await lab.turn(ws, 'in_progress')
  assert.deepEqual(await lab.command(ws, 'Scope', { execution: e.id }, { profiles: [A] }), { accepted: false, reason: 'turn_active' })
  await lab.turn(ws, 'done', 10_000)
  assert.deepEqual(await lab.command(ws, 'Scope', { execution: e.id }, { profiles: ['github:owner/b:write'] }), { accepted: false, reason: 'profile_not_offered' })
  assert.deepEqual(await lab.command(ws, 'Scope', { execution: e.id }, { profiles: ['dropbox:everything'] }), { accepted: false, reason: 'unknown_profile' })
  assert.equal(tokensOf(signer, e).length, 1)
  assert.equal((await lab.entries(ws)).filter((x) => x.kind === 'command' && x.content.kind === 'Scope').length, 0)
})

test('C19 a Scope whose token cannot be handed at once: accepted; the token before the next prompt, or the prompt fails', async (t) => {
  const { lab, signer, ws } = await started(t)
  const e = await lab.open(ws, { profiles: [B] })
  // Simulated: the signer refuses (stub).
  signer.fail = true
  assert.ok((await lab.command(ws, 'Scope', { execution: e.id }, { profiles: [A] })).accepted)
  assert.equal(tokensOf(signer, e).length, 1)
  signer.fail = false
  assert.ok((await lab.write(ws, 'the token first')).accepted)
  await lab.turn(ws, 'done')
  const tokens = tokensOf(signer, e)
  assert.deepEqual(tokens.map((m) => [...m.profiles]), [[B], [A]])
  assert.ok(tokens[1]!.at <= (await promptDispatched(lab, ws)))
  signer.fail = true
  assert.ok((await lab.command(ws, 'Scope', { execution: e.id }, { profiles: [B] })).accepted)
  assert.ok((await lab.write(ws, 'never sent')).accepted)
  const prompt = lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!
  const failed = await until('request.failed', async () => (await lab.entries(ws)).find((x) => x.kind === 'request.failed' && x.content.requestPosition === prompt.position))
  assert.equal(failed.content.reason, 'credentials_refused')
})

test('C21 Agora restarted between two turns: a new token before the next prompt, naming the execution’s profiles', async (t) => {
  const context = await started(t, { 'claude-test': 'anthropic' })
  const { signer, ws } = context
  const e = await context.lab.open(ws, { pool: 'claude-test', profiles: [B] })
  assert.ok((await context.lab.write(ws, 'before the restart')).accepted)
  await context.lab.turn(ws, 'done')
  assert.equal(tokensOf(signer, e).length, 1)
  context.lab = await context.lab.restart('clean')
  await until('reconnected', async () => (await view(context.lab, ws)).state === 'ready', 10_000)
  assert.ok((await context.lab.write(ws, 'after the restart')).accepted)
  await context.lab.turn(ws, 'done')
  const tokens = tokensOf(signer, e)
  assert.deepEqual(tokens.map((m) => [...m.profiles]), [['anthropic', B], ['anthropic', B]])
  assert.ok(tokens[1]!.at <= (await promptDispatched(context.lab, ws)))
})

test('L54 a Create with profiles, then a Scope with others: the view’s profiles follow; the Scope recorded with the command', async (t) => {
  const { lab, ws } = await started(t)
  const e = await lab.open(ws, { profiles: [B, B] })
  assert.deepEqual((await view(lab, ws)).profiles, [B])
  const scope = await lab.command(ws, 'Scope', { execution: e.id }, { profiles: [A, 'github:owner/b:read'] })
  assert.ok(scope.accepted)
  assert.deepEqual((await view(lab, ws)).profiles, [A, B])
  const command = (await lab.entries(ws)).find((x) => x.kind === 'command' && x.content.kind === 'Scope')!
  assert.equal(command.position, scope.position)
  assert.equal(command.execution, e.id)
  assert.deepEqual((await lab.state(ws)).current?.profiles, [A, B])
})

test('L55 a Scope whose profiles is not a list of strings, one for another execution, one after Stop: refused', async (t) => {
  const { lab, ws } = await started(t)
  const e = await lab.open(ws)
  for (const body of [{ profiles: 'github:owner/a:read' }, { profiles: [3] }, {}])
    assert.deepEqual(await lab.command(ws, 'Scope', { execution: e.id }, body), { accepted: false, reason: 'invalid_scope' })
  assert.deepEqual(await lab.command(ws, 'Scope', { execution: randomUUID() }, { profiles: [] }), { accepted: false, reason: 'stale_execution' })
  assert.ok((await lab.command(ws, 'Stop', { execution: e.id })).accepted)
  assert.deepEqual(await lab.command(ws, 'Scope', { execution: e.id }, { profiles: [] }), { accepted: false, reason: 'stopped' })
})
