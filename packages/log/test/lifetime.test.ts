// docs/specs/executions.md, "The deadline": how long a sandbox lives — while a turn runs, while work its agent left
// running does, never beyond the ceiling since the last prompt, one lease once nothing runs. Each test waits out real
// minutes on a 60 s lease and a 1 s renewal step: they run side by side.
import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Entry } from '../src/index.ts'
import { lines, opened, sleep, until } from './support.ts'

/** What the agent said last, as its lines carried it. */
function lastSaid(entries: readonly Entry[]): string | undefined {
  return lines(entries, 'in', 'session/update')
    .map((x) => (x.content.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update)
    .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
    .at(-1)?.content?.text
}

describe('a sandbox’s life', { concurrency: true }, () => {
  it('E36 a turn of 120 s, the Create naming a turn cap of 30 s: it ends with its answer, the execution ready, neither ending nor lost', { timeout: 240_000 }, async (t) => {
    const { lab, ws, e } = await opened(t, { workstreams: { renewSeconds: 1 } }, { limits: { leaseSeconds: 60, turnCapSeconds: 30 } })
    assert.ok((await lab.write(ws, '/sleep 120')).accepted)
    const prompt = Date.parse(lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!.time)
    const turn = await lab.turn(ws, ['done', 'failed', 'cancelled', 'uncertain'], 200_000)
    assert.equal(turn.status, 'done')
    assert.equal(turn.stopReason, 'end_turn')
    assert.equal(lastSaid(await lab.entries(ws)), 'Slept 120 s.')
    // Past the cap and past the lease the turn began with, its deadline kept moving.
    const patches = lab.kube.deadlines.filter((d) => d.name === e.claimName && d.at >= prompt + 90_000)
    assert.ok(patches.length > 0 && patches.every((d) => Date.parse(d.shutdownTime) > d.at), String(patches.length))
    const state = await lab.state(ws)
    assert.deepEqual([state.current?.id, state.current?.lost, state.current?.ended, state.current?.stopped], [e.id, false, false, false])
    const claim = lab.kube.claims.get(e.claimName)
    assert.ok(claim !== undefined && claim.metadata.deletionTimestamp === undefined, 'not ending')
    assert.ok(Date.parse(String((claim.spec.lifecycle as { shutdownTime?: string } | undefined)?.shutdownTime)) > Date.now() + 50_000, 'a lease ahead')
    await lab.workstreams.projections.run(ws)
    const view = (await lab.workstreams.projections.objects(ws)).find((o) => o.kind === 'workstream')!.object
    assert.equal(view.state, 'ready')
  })

  it('E37 a command left running after its turn: the deadline moves while it runs, its output is there for the next prompt on the same Pod, then one lease and nothing more', { timeout: 200_000 }, async (t) => {
    const { lab, ws, e } = await opened(t, { workstreams: { renewSeconds: 1 } }, { limits: { leaseSeconds: 60 } })
    const pod = lab.executions.claimOf(e.id)?.status?.sandbox?.name
    assert.ok((await lab.write(ws, '/background 70 out.txt')).accepted)
    await lab.turn(ws, 'done')
    const answered = Date.parse(lines(await lab.entries(ws), 'in', 'session/prompt').at(-1)!.time)
    assert.equal(lastSaid(await lab.entries(ws)), 'Started in the background: out.txt, 70 s.')
    // Past the lease the end of the turn granted, the claim is still there, its deadline moved on by the work.
    await until('a lease past the end of the turn', () => Date.now() >= answered + 65_000, 70_000)
    const claim = lab.kube.claims.get(e.claimName)
    assert.ok(claim !== undefined && claim.metadata.deletionTimestamp === undefined, 'the claim lives on')
    const during = lab.kube.deadlines.filter((d) => d.name === e.claimName && d.at > answered + 1_000)
    assert.ok(during.length >= 30, `${String(during.length)} renewals while the work ran`)
    const work = lab.executions.views().find((v) => v.execution === e.id)?.processes ?? []
    assert.ok(work.some((p) => p.command === 'sleep'), JSON.stringify(work))
    // Once the command has ended: one lease from then, then no more renewal.
    const path = join(lab.kube.bridges.get(pod!)!.workspace, 'out.txt')
    await until('its output', () => existsSync(path), 20_000)
    // Written as the command ends: a step may still have seen it running, the next sees it gone.
    const ended = statSync(path).mtimeMs
    await sleep(4_000)
    const after = lab.kube.deadlines.filter((d) => d.name === e.claimName && d.at >= ended)
    assert.ok(after.length >= 1 && after.length <= 2, JSON.stringify(after))
    const last = after.at(-1)!
    assert.ok(Math.abs(Date.parse(last.shutdownTime) - (last.at + 60_000)) < 1_000)
    await sleep(2_500)
    assert.equal(lab.kube.deadlines.filter((d) => d.name === e.claimName && d.at >= ended).length, after.length, 'no renewal once it has ended')
    // The next prompt, on the same Pod, reads what the command wrote.
    assert.ok((await lab.write(ws, '/read out.txt')).accepted)
    await until('read', async () => lastSaid(await lab.entries(ws))?.startsWith('out.txt:'))
    assert.equal(lastSaid(await lab.entries(ws)), 'out.txt: Ran 70 s in the background.')
    assert.equal(lab.executions.claimOf(e.id)?.status?.sandbox?.name, pod)
    assert.equal((await lab.state(ws)).current?.id, e.id)
  })

  it('E38 work running beyond the ceiling since the last prompt: the deadline never beyond it, and the execution ends there, its anchor received', { timeout: 120_000 }, async (t) => {
    const { lab, ws, e } = await opened(t, { receiver: true, workstreams: { renewSeconds: 1 } }, { limits: { leaseSeconds: 60, ceilingSeconds: 30 } })
    assert.ok((await lab.write(ws, '/background 600 never.txt')).accepted)
    await lab.turn(ws, 'done')
    const prompt = Date.parse(lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!.time)
    const cap = prompt + 30_000
    // Still running, as the bridge says.
    await until('seen running', async () => (await lab.executions.info(e.id)).processes.some((p) => p.command === 'sleep'))
    const end = await until('ended', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.ended' && x.execution === e.id), 60_000)
    const patches = lab.kube.deadlines.filter((d) => d.name === e.claimName)
    assert.ok(patches.every((d) => Date.parse(d.shutdownTime) <= cap), JSON.stringify(patches))
    // The deadline reached the ceiling, and the claim went there.
    assert.equal(Date.parse(patches.at(-1)!.shutdownTime), cap)
    assert.ok(Date.parse(end.time) >= cap && Date.parse(end.time) < cap + 10_000, end.time)
    assert.equal(typeof end.content.anchor, 'string')
  })

  it('E40 the Create’s own message starts a command at once: work, not the harness’s, and the deadline moves past the lease while it runs', { timeout: 150_000 }, async (t) => {
    // The first prompt leaves as the Session opens: the command starts within milliseconds of it.
    const { lab, ws, e } = await opened(t, { workstreams: { renewSeconds: 1 } }, { limits: { leaseSeconds: 60 }, prompt: [{ type: 'text', text: '/background 75 first.txt' }] })
    await lab.turn(ws, 'done')
    const answered = Date.parse(lines(await lab.entries(ws), 'in', 'session/prompt').at(-1)!.time)
    // What ran as it left is recorded with its dispatch: the mock agent alone, nothing under it.
    const dispatched = (await lab.entries(ws)).find((x) => x.kind === 'acp.dispatching' && Array.isArray(x.content.processes))!
    assert.deepEqual(dispatched.content.processes, [])
    await until('a lease past the end of the turn', () => Date.now() >= answered + 65_000, 70_000)
    const claim = lab.kube.claims.get(e.claimName)
    assert.ok(claim !== undefined && claim.metadata.deletionTimestamp === undefined, 'the claim lives on')
    assert.ok(lab.kube.deadlines.filter((d) => d.name === e.claimName && d.at > answered + 60_000).length > 0, 'renewed past the lease')
  })

  it('E41 a message taken into a running turn is the last prompt: the ceiling counts from it', { timeout: 120_000 }, async (t) => {
    const { lab, ws, e } = await opened(t, { workstreams: { renewSeconds: 1 } }, { limits: { leaseSeconds: 60, ceilingSeconds: 30 } })
    assert.ok((await lab.write(ws, '/sleep 45')).accepted)
    const prompt = Date.parse(lines(await lab.entries(ws), 'out', 'session/prompt').at(-1)!.time)
    await until('fifteen seconds in', () => Date.now() > prompt + 15_000, 20_000)
    const current = (await lab.state(ws)).current!
    assert.ok((await lab.command(ws, 'Write', { execution: current.id, session: current.session }, { prompt: [{ type: 'text', text: 'a fresh instruction' }], mayWait: true })).accepted)
    const injected = await until('injected', async () => (await lab.entries(ws)).find((x) => x.direction === 'in' && x.correlated_method === '_session/steering' && (x.content.result as { outcome?: string } | undefined)?.outcome === 'injected'))
    const turn = await lab.turn(ws, ['done', 'failed', 'cancelled', 'uncertain'], 60_000)
    assert.equal(turn.status, 'done')
    const said = lines(await lab.entries(ws), 'in', 'session/update').map((x) => String((x.content.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? ''))
    assert.ok(said.some((s) => s.startsWith('Heard: a fresh instruction')) && said.some((s) => s.includes('Slept 45 s.')), JSON.stringify(said.slice(-3)))
    // Past the first prompt's ceiling, under the new one.
    const patches = lab.kube.deadlines.filter((d) => d.name === e.claimName)
    assert.ok(patches.some((d) => Date.parse(d.shutdownTime) > prompt + 30_000), 'moved past the first prompt’s ceiling')
    assert.ok(patches.every((d) => Date.parse(d.shutdownTime) <= Date.parse(injected.time) + 30_000), 'never past the new one')
    assert.equal(lab.kube.claims.get(e.claimName)?.metadata.deletionTimestamp, undefined)
  })

  it('E14 nothing left running after the turn: the infrastructure destroys the sandbox one lease after it, and its anchor arrives', { timeout: 120_000 }, async (t) => {
    const { lab, ws, e } = await opened(t, { receiver: true, workstreams: { renewSeconds: 1 } }, { limits: { leaseSeconds: 60 } })
    assert.ok((await lab.write(ws, 'a short turn')).accepted)
    await lab.turn(ws, 'done')
    const answered = Date.parse(lines(await lab.entries(ws), 'in', 'session/prompt').at(-1)!.time)
    // The end of the turn's lease, then nothing more.
    await until('the lease of the end of the turn', () => lab.kube.deadlines.some((d) => d.name === e.claimName && d.at >= answered))
    const count = lab.kube.deadlines.filter((d) => d.name === e.claimName).length
    const end = await until('ended', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.ended' && x.execution === e.id), 90_000)
    assert.equal(lab.kube.deadlines.filter((d) => d.name === e.claimName).length, count, 'no renewal after the turn')
    assert.ok(Date.parse(end.time) >= answered + 59_000 && Date.parse(end.time) < answered + 70_000, `ended ${String(Date.parse(end.time) - answered)} ms after the turn`)
    assert.equal(typeof end.content.anchor, 'string')
    assert.ok((await lab.entries(ws)).some((x) => x.kind === 'anchor.received' && x.execution === e.id))
  })
})
