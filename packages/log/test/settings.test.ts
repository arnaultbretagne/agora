// docs/specs/log.md, "Sessions" and "Commands": a Session's settings — those it starts with, those
// the operator changes, those the agent changes itself — and the commands it offers. Real bridges and
// the mock agent, which offers a mode, a model and an effort, and answers a change after 400 ms.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { CoreProjection, object, type Entry } from '../src/index.ts'
import { call, database, FakeKube, Lab, lines, until } from './support.ts'

/** A Lab whose pool `mock-test` declares these opening settings; `more` pools beside it, by name and harness. */
async function labWith(t: { after(fn: () => Promise<void>): void }, sessionConfig?: string, purpose: Record<string, string> = {}, more: [string, string][] = []) {
  const db = await database()
  const keys = generateKeyPairSync('ed25519')
  const kube = new FakeKube(keys.publicKey)
  if (sessionConfig !== undefined) kube.sessionConfig['mock-test'] = sessionConfig
  Object.assign(kube.purpose, purpose)
  kube.morePools.push(...more)
  const lab = await Lab.start({ db, kube, keys })
  t.after(async () => {
    await lab.close()
    await kube.closeAll()
    await db.drop()
  })
  return lab
}

const view = async (lab: Lab, ws: string) => (await lab.workstreams.projections.objects(ws)).find((o) => o.kind === 'workstream')!.object
const current = (settings: unknown, id: string) => (settings as { id: string; currentValue: unknown }[] | null)?.find((s) => s.id === id)?.currentValue
const configLines = (entries: readonly Entry[]) =>
  lines(entries, 'out', 'session/set_config_option').map((x) => {
    const p = object(x.content.params)!
    return `${String(p.configId)}=${String(p.value)}`
  })

/** The view's state after each entry, as the projector folds them one at a time. */
function statesOver(entries: readonly Entry[]): { position: string; state: unknown }[] {
  const projection = new CoreProjection()
  const out: { position: string; state: unknown }[] = []
  for (const entry of entries) {
    projection.apply([entry])
    const state = projection.objects.get(entry.workstream)?.object.state
    if (state !== undefined && out.at(-1)?.state !== state) out.push({ position: entry.position, state })
  }
  return out
}

test('L47 a Create with settings in a pool that declares others: resolved in order, sent once the Session opens, before any prompt; ready once answered', async (t) => {
  const lab = await labWith(t, 'mode=full-access, model=mock-small')
  const ws = await lab.workstream()
  const e = await lab.open(ws, { settings: { model: 'mock-large', effort: 'high' } })
  assert.deepEqual(e.body.settings, [
    { id: 'mode', value: 'full-access' },
    { id: 'model', value: 'mock-large' },
    { id: 'effort', value: 'high' },
  ])
  await until('ready', async () => (await view(lab, ws)).state === 'ready', 10_000)
  const v = await view(lab, ws)
  assert.deepEqual(['mode', 'model', 'effort'].map((id) => current(v.settings, id)), ['full-access', 'mock-large', 'high'])
  assert.ok((await lab.write(ws, 'after the settings')).accepted)
  await lab.turn(ws, 'done')
  const entries = await lab.entries(ws)
  assert.deepEqual(configLines(entries), ['mode=full-access', 'model=mock-large', 'effort=high'])
  // Each sent once the previous was answered, all before the prompt.
  const out = lines(entries, 'out').filter((x) => x.session === e.session).map((x) => x.method)
  assert.deepEqual(out, ['session/set_config_option', 'session/set_config_option', 'session/set_config_option', 'session/prompt'])
  const answers = lines(entries, 'in', 'session/set_config_option').map((x) => BigInt(x.position))
  const requests = lines(entries, 'out', 'session/set_config_option').map((x) => BigInt(x.position))
  assert.ok(requests[1]! > answers[0]! && requests[2]! > answers[1]!, 'one at a time')
  // The view: starting with its Session open, until the last answer; then ready.
  const opened = entries.find((x) => x.kind === 'session.opened')!
  const states = statesOver(entries)
  const ready = states.find((s) => s.state === 'ready')!
  assert.ok(BigInt(ready.position) >= answers[2]!, 'not ready before the last setting is answered')
  assert.ok(BigInt(ready.position) > BigInt(opened.position))
})

test('L48 opening settings not offered, not listed, already current, or answered with an error: none sent but the last; the error sent once; ready', async (t) => {
  const lab = await labWith(t, 'mode=default, bogus=x, model=nope, effort=low')
  const ws = await lab.workstream()
  await lab.open(ws, { settings: { model: 'mock-broken' } })
  await until('ready', async () => (await view(lab, ws)).state === 'ready', 10_000)
  const entries = await lab.entries(ws)
  assert.deepEqual(configLines(entries), ['model=mock-broken', 'effort=low'])
  assert.equal(lines(entries, 'in', 'session/set_config_option').filter((x) => x.rpc_kind === 'error').length, 1)
  assert.equal(current((await view(lab, ws)).settings, 'model'), 'default')
  assert.ok((await lab.write(ws, 'ready all the same')).accepted)
})

test('L49 Configure between turns: its line with it, configuring until the answer, then the settings; a Write meanwhile settings_pending', async (t) => {
  const lab = await labWith(t)
  const ws = await lab.workstream()
  const e = await lab.open(ws)
  await until('ready', async () => (await view(lab, ws)).state === 'ready', 10_000)
  const configure = await lab.command(ws, 'Configure', { execution: e.id, session: e.session }, { configId: 'model', value: 'mock-large' })
  assert.ok(configure.accepted)
  assert.deepEqual(await lab.write(ws, 'too early'), { accepted: false, reason: 'settings_pending' })
  await until('configuring shown', async () => (await view(lab, ws)).configuring === true, 5_000).catch(() => undefined)
  await until('answered', async () => current((await view(lab, ws)).settings, 'model') === 'mock-large', 10_000)
  assert.equal((await view(lab, ws)).configuring, false)
  const entries = await lab.entries(ws)
  const command = entries.find((x) => x.kind === 'command' && x.content.kind === 'Configure')!
  const line = lines(entries, 'out', 'session/set_config_option').at(-1)!
  assert.equal(line.command, command.command, 'the line committed with its command')
  assert.ok((await lab.write(ws, 'now')).accepted)
})

test('L50 Configure refused: a setting not offered, a value not listed, during a turn; nothing sent', async (t) => {
  const lab = await labWith(t)
  const ws = await lab.workstream()
  const e = await lab.open(ws)
  await until('ready', async () => (await view(lab, ws)).state === 'ready', 10_000)
  const target = { execution: e.id, session: e.session }
  assert.deepEqual(await lab.command(ws, 'Configure', target, { configId: 'colour', value: 'red' }), { accepted: false, reason: 'unknown_setting' })
  assert.deepEqual(await lab.command(ws, 'Configure', target, { configId: 'model', value: 'mock-huge' }), { accepted: false, reason: 'unknown_setting' })
  assert.ok((await lab.write(ws, '/sleep 3')).accepted)
  await lab.turn(ws, 'in_progress')
  assert.deepEqual(await lab.command(ws, 'Configure', target, { configId: 'model', value: 'mock-small' }), { accepted: false, reason: 'turn_active' })
  assert.deepEqual(configLines(await lab.entries(ws)), [])
})

test('L51 the agent changes a setting and its commands itself: the view replaced', async (t) => {
  const lab = await labWith(t)
  const ws = await lab.workstream()
  await lab.open(ws)
  await until('commands', async () => ((await view(lab, ws)).commands as unknown[]).length === 2, 10_000)
  const first = (await view(lab, ws)).commands as { name: string; hint: string | null }[]
  assert.deepEqual(first.map((c) => [c.name, c.hint]), [['recall', null], ['review', 'what to review']])
  assert.ok((await lab.write(ws, '/config effort=high')).accepted)
  await lab.turn(ws, 'done')
  await until('effort high', async () => current((await view(lab, ws)).settings, 'effort') === 'high', 5_000)
  assert.ok((await lab.write(ws, '/commands')).accepted)
  await lab.turn(ws, 'done')
  await until('commands replaced', async () => ((await view(lab, ws)).commands as { name: string }[]).map((c) => c.name).includes('compact'), 5_000)
})

test('L52 GET /api/pools after a Session in a pool: its settings and commands; a pool kept for the tests marked', async (t) => {
  const lab = await labWith(t, 'model=mock-small', { 'claude-test': 'testing' })
  const ws = await lab.workstream()
  await lab.open(ws)
  await until('ready', async () => (await view(lab, ws)).state === 'ready', 10_000)
  const pools = (await call(lab.url, 'GET', '/api/pools')).body.pools as Record<string, unknown>[]
  const mock = pools.find((p) => p.name === 'mock-test')!
  assert.deepEqual(mock.sessionConfig, [{ id: 'model', value: 'mock-small' }])
  assert.equal(current(mock.settings, 'model'), 'mock-small')
  assert.deepEqual((mock.commands as { name: string }[]).map((c) => c.name), ['recall', 'review'])
  const claude = pools.find((p) => p.name === 'claude-test')!
  assert.deepEqual([claude.settings, claude.commands], [null, []])
  assert.deepEqual([mock.testing, claude.testing], [false, true])
})

test('L65 GET /api/pools: a newer pool of a harness, never opened, offers its harness\'s last Session\'s settings and commands', async (t) => {
  const lab = await labWith(t, 'model=mock-small', {}, [['mock-newer', 'mock']])
  const ws = await lab.workstream()
  await lab.open(ws)
  await until('ready', async () => (await view(lab, ws)).state === 'ready', 10_000)
  const pools = (await call(lab.url, 'GET', '/api/pools')).body.pools as Record<string, unknown>[]
  const [opened, newer, other] = ['mock-test', 'mock-newer', 'claude-test'].map((name) => pools.find((p) => p.name === name)!)
  assert.equal(current(opened!.settings, 'model'), 'mock-small', 'the pool opened: its own Session')
  assert.deepEqual([newer!.settings, newer!.commands], [opened!.settings, opened!.commands], 'the newer pool: its harness\'s last Session')
  assert.deepEqual([other!.settings, other!.commands], [null, []], 'another harness: nothing')
})

test('L53 a Create whose settings is not an object of strings: invalid_create', async (t) => {
  const lab = await labWith(t)
  const ws = await lab.workstream()
  assert.deepEqual(await lab.command(ws, 'Create', {}, { pool: 'mock-test', settings: { model: 3 } }), { accepted: false, reason: 'invalid_create' })
  assert.deepEqual(await lab.command(ws, 'Create', {}, { pool: 'mock-test', settings: ['model'] }), { accepted: false, reason: 'invalid_create' })
})
