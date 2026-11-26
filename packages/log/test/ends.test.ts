// docs/specs/executions.md, "How an execution ended": each cause, named by `execution.ended`, by the
// thread's notice, and by the message Agora writes to the delegate's delegator. Every execution here is a
// delegate's, started by its delegator's `spawn_agent` as its harness calls it.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { keys } from '@agora/testkit'
import { POD_MARGIN_MS } from '@agora/executions'
import { causeOf, createMcpServer, type Entry } from '../src/index.ts'
import { schemaValue } from '../src/json.ts'
import { database, expire, FakeKube, grants, Lab, lines, sleep, until } from './support.ts'

type T = { after(fn: () => Promise<void>): void }

/** Each case fails rather than holding the run: the longest waits 60 s for a lease. */
const LIMIT = { timeout: 150_000 }

/** A delegator on the lab, given `agora:delegate`, with the limits its delegates take; and its delegate, started. */
async function delegated(t: T, instructions: string, limits: { leaseSeconds: number; ceilingSeconds: number }, before: (kube: FakeKube) => void = () => {}) {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  const db = await database()
  const signer = grants()
  const lab = await Lab.start({ db, kube, keys: pair, credentials: signer.source, receiver: true, workstreams: { maxActive: 8, renewSeconds: 1 }, delegations: { approvalMs: 3_000, progressMs: 500 } })
  const mcp = createMcpServer(lab.workstreams, signer.key)
  await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve))
  const c = new Client({ name: 'harness', version: '1.0.0' })
  t.after(async () => {
    await c.close()
    await new Promise((resolve) => mcp.close(resolve))
    await lab.close()
    await db.drop()
  })
  const ws = await lab.workstream()
  const execution = (await lab.open(ws, { profiles: ['agora:delegate'], limits })).id
  const url = `http://127.0.0.1:${String((mcp.address() as AddressInfo).port)}/mcp`
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${signer.grantOf(execution)}` } } }))
  before(kube)
  const answer = ((await c.callTool({ name: 'spawn_agent', arguments: { instructions, harness: 'mock' } })) as { content: { text: string }[] }).content[0]!.text
  const delegate = /^started ([0-9a-f-]{36}) · /.exec(answer)?.[1] ?? assert.fail(`not started: ${answer}`)
  const e = await until('the delegate’s execution', async () => (await lab.state(delegate)).current ?? null)
  return { lab, kube, ws, delegate, e }
}

type Delegated = Awaited<ReturnType<typeof delegated>>

const podOf = (d: Delegated) => (d.kube.claims.get(d.e.claimName)?.status?.sandbox as { name?: string } | undefined)?.name ?? assert.fail('no Pod')
/** Its Session open, connected: the delegate's own start. */
const opened = (d: Delegated) => until('the delegate’s Session', async () => { const c = (await d.lab.state(d.delegate)).current; return c?.session && c.connection ? c : null })
const running = (d: Delegated) => until('the delegate’s turn running', async () => (await d.lab.state(d.delegate)).active?.dispatching === true)
const ended = (d: Delegated, timeoutMs = 15_000) =>
  until('execution.ended', async () => (await d.lab.entries(d.delegate)).find((x) => x.kind === 'execution.ended' && x.execution === d.e.id), timeoutMs)
/** The delegate's thread: the notice an entry projects. */
const noticeOf = (d: Delegated, entry: Entry) =>
  until(`the ${entry.kind} notice`, async () => (await d.lab.workstreams.projections.objects(d.delegate)).find((o) => o.kind === 'notice' && o.object.type === entry.kind && o.object.execution === entry.execution)?.object).then((o) => schemaValue(o) as Record<string, unknown>)
/** The messages of Agora's about the delegate, in its delegator's Workstream. */
const agoras = async (d: Delegated) =>
  (await d.lab.workstreams.projections.objects(d.ws)).filter((o) => o.kind === 'element' && o.object.type === 'user' && o.object.as === 'agora' && o.object.from === d.delegate).map((o) => (o.object.content as { text: string }[]).map((b) => b.text).join('\n'))
const told = (d: Delegated, timeoutMs = 15_000) => until('a message of Agora’s', async () => (await agoras(d))[0], timeoutMs)

test('E36 bound reached: a turn past its ceiling; its execution ends at the bound, the cause named', LIMIT, async (t) => {
  const d = await delegated(t, '/sleep 120', { leaseSeconds: 60, ceilingSeconds: 30 })
  await opened(d)
  await running(d)
  const prompt = lines(await d.lab.entries(d.delegate), 'out', 'session/prompt').at(-1)!
  const end = await ended(d, 45_000)
  assert.deepEqual(end.content.cause, { kind: 'bound_reached' })
  // The deadline it reached: the turn's start plus its ceiling, never further.
  const last = d.kube.deadlines.filter((x) => x.name === d.e.claimName).at(-1)!
  assert.equal(Date.parse(last.shutdownTime), Date.parse(prompt.time) + 30_000)
  assert.ok(Date.parse(end.time) >= Date.parse(prompt.time) + 30_000)
  assert.deepEqual((await noticeOf(d, end)).cause, { kind: 'bound_reached' })
  assert.equal(await told(d), `Your delegate ${d.delegate} "/sleep 120": Its turn failed: its sandbox reached its time bound.`)
  await sleep(600)
  assert.equal((await agoras(d)).length, 1)
})

test('E37 lease expired after the turn: the turn done, nothing renews; its execution ends at now + lease, the cause named', LIMIT, async (t) => {
  const d = await delegated(t, 'a short task', { leaseSeconds: 60, ceilingSeconds: 3600 })
  await opened(d)
  // Control: the delegate's last message reaches its delegator, as any.
  await until('its last message', async () => (await d.lab.workstreams.projections.objects(d.ws)).find((o) => o.kind === 'element' && o.object.type === 'user' && o.object.as === 'delegate' && o.object.from === d.delegate))
  const answered = lines(await d.lab.entries(d.delegate), 'in', 'session/prompt').at(-1)!
  const end = await ended(d, 75_000)
  assert.deepEqual(end.content.cause, { kind: 'lease_expired', turn: 'ended' })
  assert.ok(Date.parse(end.time) >= Date.parse(answered.time) + 59_000)
  assert.deepEqual((await noticeOf(d, end)).cause, { kind: 'lease_expired', turn: 'ended' })
  // Its turn was done: nothing of Agora's to tell.
  await sleep(1500)
  assert.deepEqual(await agoras(d), [])
})

test('E38 adapter exited: the agent’s process exits with code 3 during a turn; lost, then ended, both naming the exit', LIMIT, async (t) => {
  const d = await delegated(t, '/die 1', { leaseSeconds: 60, ceilingSeconds: 3600 })
  await opened(d)
  const lost = await until('execution.lost', async () => (await d.lab.entries(d.delegate)).find((x) => x.kind === 'execution.lost'))
  assert.deepEqual(schemaValue(lost.content), { reason: 'adapter_exited', exitCode: 3, signal: null })
  const notice = await noticeOf(d, lost)
  assert.deepEqual([notice.reason, notice.exitCode, notice.signal], ['adapter_exited', 3, null])
  assert.equal(await told(d), `Your delegate ${d.delegate} "/die 1": Its execution was lost: the agent's process exited with code 3.`)
  const end = await ended(d)
  assert.deepEqual(schemaValue(end.content.cause), { kind: 'adapter_exited', exitCode: 3, signal: null })
  assert.deepEqual((await noticeOf(d, end)).cause, { kind: 'adapter_exited', exitCode: 3, signal: null })
  await sleep(600)
  assert.equal((await agoras(d)).length, 1)
})

test('E39 Pod killed for lack of memory: its container OOMKilled during a turn; ended at its deadline, the cause named', LIMIT, async (t) => {
  const d = await delegated(t, '/sleep 120', { leaseSeconds: 60, ceilingSeconds: 3600 })
  await opened(d)
  await running(d)
  await d.kube.killPod(podOf(d), 'OOMKilled', 137)
  await until('the Pod seen', () => d.lab.executions.observed(d.e.id)?.pod?.reason === 'OOMKilled')
  // Nothing renews a turn with no connection: the lease runs out; brought to now here, past the margin within which
  // what is seen of a Pod is taken for its deadline's.
  await sleep(POD_MARGIN_MS + 500)
  await expire(d.kube, d.e.claimName)
  const end = await ended(d)
  assert.deepEqual(end.content.cause, { kind: 'oom_killed' })
  assert.equal(end.content.anchor, null)
  assert.deepEqual((await noticeOf(d, end)).cause, { kind: 'oom_killed' })
  assert.equal(await told(d), `Your delegate ${d.delegate} "/sleep 120": Its turn failed: its Pod was killed for lack of memory (OOMKilled).`)
})

test('E40 Pod gone: its Pod deleted before its deadline, the claim left; ended, the cause named', LIMIT, async (t) => {
  const d = await delegated(t, '/sleep 120', { leaseSeconds: 60, ceilingSeconds: 3600 })
  await opened(d)
  await running(d)
  await d.kube.deletePod(podOf(d))
  await until('the Pod seen gone', () => d.lab.executions.observed(d.e.id)?.pod?.gone === true)
  await sleep(POD_MARGIN_MS + 500)
  await expire(d.kube, d.e.claimName)
  const end = await ended(d)
  assert.deepEqual(end.content.cause, { kind: 'pod_gone', pod: null })
  assert.deepEqual((await noticeOf(d, end)).cause, { kind: 'pod_gone', pod: null })
  assert.equal(await told(d), `Your delegate ${d.delegate} "/sleep 120": Its turn failed: its Pod was gone before its deadline.`)
})

test('E40 Pod gone: its claim deleted before its deadline, the Pod with it; ended at once, the cause named', LIMIT, async (t) => {
  const d = await delegated(t, '/sleep 120', { leaseSeconds: 60, ceilingSeconds: 3600 })
  await opened(d)
  await running(d)
  const deadline = Date.parse(String((d.kube.claims.get(d.e.claimName)!.spec.lifecycle as { shutdownTime: string }).shutdownTime))
  d.kube.deleteClaim(d.e.claimName)
  const end = await ended(d)
  assert.ok(Date.parse(end.time) < deadline - 30_000)
  assert.deepEqual(end.content.cause, { kind: 'pod_gone', pod: null })
  assert.deepEqual((await noticeOf(d, end)).cause, { kind: 'pod_gone', pod: null })
  assert.equal(await told(d), `Your delegate ${d.delegate} "/sleep 120": Its turn failed: its Pod was gone before its deadline.`)
})

test('E41 a claim never obtained: its creation refused until its initial deadline; failed, then ended, never said to be Agora’s absence', LIMIT, async (t) => {
  const d = await delegated(t, 'never read', { leaseSeconds: 60, ceilingSeconds: 3600 }, (kube) => (kube.failCreates = true))
  // The delegate's claim alone.
  d.kube.failCreates = (name) => name === d.e.claimName
  // Its delegator kept running past its delegate's initial deadline, which its own lease would otherwise end with: a turn
  // renews it.
  assert.ok((await d.lab.write(d.ws, '/sleep 120')).accepted)
  const end = await ended(d, 75_000)
  const failed = (await d.lab.entries(d.delegate)).find((x) => x.kind === 'execution.failed' && x.execution === d.e.id)
  assert.equal(failed?.content.reason, 'startup_failed')
  assert.ok(BigInt(failed!.position) < BigInt(end.position))
  assert.ok(!d.kube.created.includes(d.e.claimName), 'no claim of the delegate created')
  assert.ok(Date.parse(end.time) >= Date.parse(String(d.e.body.deadline)))
  assert.deepEqual(end.content.cause, { kind: 'not_obtained' })
  assert.deepEqual((await noticeOf(d, end)).cause, { kind: 'not_obtained' })
  assert.equal(await told(d, 30_000), `Your delegate ${d.delegate} "never read": Its execution could not start.`)
})

test('E40 what was seen of a Pod within the margin before the deadline it reached is that deadline’s: the bound reached, not a Pod gone; seen before the margin, a Pod gone', () => {
  const deadline = Date.parse('2026-11-26T10:00:00Z')
  const facts = (podAt: number) => ({
    lost: null,
    stopped: false,
    obtained: true,
    running: { bound: deadline },
    prompted: true,
    now: deadline + 200,
    observed: {
      claim: { metadata: { name: 'sbx-x', uid: 'u', deletionTimestamp: new Date(deadline + 100).toISOString() }, spec: { lifecycle: { shutdownTime: new Date(deadline).toISOString() } } },
      pod: { reason: null, gone: true, exitCode: null, at: podAt },
    },
  }) as Parameters<typeof causeOf>[0]
  // As the read the judge timed: begun 80 ms before the deadline, answered 140 ms later.
  assert.deepEqual(causeOf(facts(deadline + 60)), { kind: 'bound_reached' })
  assert.deepEqual(causeOf(facts(deadline - POD_MARGIN_MS + 1)), { kind: 'bound_reached' })
  assert.deepEqual(causeOf(facts(deadline - POD_MARGIN_MS)), { kind: 'pod_gone', pod: null })
  assert.deepEqual(causeOf({ ...facts(0), observed: null }), { kind: 'unobserved' })
  assert.deepEqual(causeOf({ ...facts(0), observed: null, obtained: false }), { kind: 'not_obtained' })
})

test('E39 a container killed for lack of memory, seen 4 s before a turn’s bound: oom_killed; another end seen then: the bound reached', () => {
  const deadline = Date.parse('2026-11-26T10:00:00Z')
  const facts = (reason: string, at: number) => ({
    lost: null,
    stopped: false,
    obtained: true,
    running: { bound: deadline },
    prompted: true,
    now: deadline + 200,
    observed: {
      claim: { metadata: { name: 'sbx-x', uid: 'u', deletionTimestamp: new Date(deadline + 100).toISOString() }, spec: { lifecycle: { shutdownTime: new Date(deadline).toISOString() } } },
      pod: { reason, gone: false, exitCode: reason === 'OOMKilled' ? 137 : 1, at },
    },
  }) as Parameters<typeof causeOf>[0]
  assert.deepEqual(causeOf(facts('OOMKilled', deadline - 4_000)), { kind: 'oom_killed' })
  assert.deepEqual(causeOf(facts('OOMKilled', deadline - 10_000)), { kind: 'oom_killed' })
  assert.deepEqual(causeOf(facts('Error', deadline - 4_000)), { kind: 'bound_reached' })
  assert.deepEqual(causeOf(facts('Error', deadline - 10_000)), { kind: 'pod_gone', pod: 'Error' })
})

test('E39 a container killed for lack of memory during a turn, reported within the margin before its deadline: ended, the cause named', LIMIT, async (t) => {
  const d = await delegated(t, '/sleep 120', { leaseSeconds: 60, ceilingSeconds: 3600 })
  await opened(d)
  await running(d)
  // The kubelet reports the kill 3 s on; the deadline, nothing renewing it, 6 s on: within the margin all along.
  await d.kube.killPod(podOf(d), 'OOMKilled', 137, 3_000)
  const deadline = Date.now() + 6_000
  d.kube.expireAt(d.e.claimName, new Date(deadline))
  const seen = await until('the Pod seen', () => d.lab.executions.observed(d.e.id)?.pod)
  assert.equal(seen.reason, 'OOMKilled')
  assert.ok(seen.at > deadline - POD_MARGIN_MS, `seen ${String(deadline - seen.at)} ms before the deadline`)
  const end = await ended(d)
  assert.deepEqual(end.content.cause, { kind: 'oom_killed' })
  assert.deepEqual((await noticeOf(d, end)).cause, { kind: 'oom_killed' })
  assert.equal(await told(d), `Your delegate ${d.delegate} "/sleep 120": Its turn failed: its Pod was killed for lack of memory (OOMKilled).`)
})
