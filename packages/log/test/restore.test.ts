// docs/specs/executions.md, "Restoring": the token, the anchor, then `initialize` — so an adapter that
// opens its native files when it starts, declared by its image, is restarted onto them. Real bridges,
// the mock agent reading its transcripts only at start (as opencode does with its database).
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { keys, mockBridge } from '@agora/testkit'
import { expire, FakeKube, lines, opened, until, type Lab } from './support.ts'

async function restored(t: { after(fn: () => Promise<void>): void }, restartOnAnchor: boolean) {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  kube.bridgeFactory = async (publicKey, pod) => {
    const bridge = await mockBridge(publicKey, pod, { readAtStart: true, restartOnAnchor })
    // A pool Pod: its adapter has started, and read its files, long before any claim.
    await until('the adapter started', () => existsSync(join(bridge.home, '.mock-agent', 'read-at-start')))
    return bridge
  }
  const { lab, ws, e } = await opened(t, { kube, keys: pair, receiver: true })
  assert.ok((await lab.write(ws, 'mirabelle')).accepted)
  await lab.turn(ws, 'done')
  await expire(lab.kube, e.claimName)
  const ended = await until('execution.ended', async () => (await lab.entries(ws)).find((x) => x.kind === 'execution.ended' && x.execution === e.id))
  const anchor = String(ended.content.anchor)
  const answer = await lab.command(ws, 'Create', {}, { pool: 'mock-test', anchor })
  assert.ok(answer.accepted)
  return { lab, ws, anchor, execution: String((answer as { execution?: string }).execution) }
}

async function said(lab: Lab, ws: string, after: string): Promise<string> {
  return (await lab.entries(ws))
    .filter((x) => BigInt(x.position) > BigInt(after) && x.method === 'session/update')
    .map((x) => String(((x.content.params as { update?: { content?: { text?: string } } }).update?.content?.text) ?? ''))
    .join('')
}

test('E29 restoring onto an adapter that reads its files at start: anchor before initialize, the agent remembers', async (t) => {
  const { lab, ws, anchor, execution } = await restored(t, true)
  const e = await until('Session open', async () => {
    const current = (await lab.state(ws)).current
    return current?.id === execution && current.session && current.connection ? current : null
  })
  const opening = (await lab.entries(ws)).findLast((x) => x.kind === 'session.opened')!
  assert.equal(opening.content.origin, anchor)
  const initialize = lines(await lab.entries(ws), 'out', 'initialize').filter((x) => x.execution === e.id)
  assert.equal(initialize.length, 1, 'one initialize, sent after the restart')
  const before = (await lab.entries(ws)).at(-1)!.position
  assert.ok((await lab.write(ws, '/recall')).accepted)
  await lab.turn(ws, 'done')
  assert.match(await said(lab, ws, before), /"mirabelle"/)
})

test('E29 control: the same adapter without the declaration cannot resume what it did not read at start', async (t) => {
  const { lab, ws, execution } = await restored(t, false)
  const resume = await until('session/resume answered', async () =>
    (await lab.entries(ws)).find((x) => x.execution === execution && x.correlated_method === 'session/resume' && x.direction === 'in'),
  )
  assert.equal(resume.rpc_kind, 'error')
  assert.equal((await lab.state(ws)).executions.get(execution)?.session ?? null, null)
})
