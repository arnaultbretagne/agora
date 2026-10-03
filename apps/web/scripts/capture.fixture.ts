// Captures the history the client's tests fold (test/fixtures/mock.json): a real run of the log, its
// mechanics, real bridges and the mock agent, through every state the client shows. Run from the
// log package, which provisions its database:
//   cd packages/log && node test/run.ts ../../apps/web/scripts/capture.fixture.ts
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { encode, type Entry } from '../../../packages/log/src/index.ts'
import { database, expire, Lab, until } from '../../../packages/log/test/support.ts'

const raw = (lines: unknown[]) => `/raw ${Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n')).toString('base64')}`
const update = (sessionId: string, value: Record<string, unknown>) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } })

test('capture the client fixture', async (t) => {
  const db = await database()
  const lab = await Lab.start({ db, relay: true, receiver: true })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const ws = await lab.workstream()
  const entries = () => lab.entries(ws)
  const marks: Record<string, string> = {}
  const mark = async (name: string) => {
    marks[name] = (await entries()).at(-1)!.position
  }
  const e = await lab.open(ws)
  await mark('opened')
  assert.ok((await lab.write(ws, 'Hello agent\nwith a second line')).accepted)
  await lab.turn(ws, 'done')
  const acpId = String((await entries()).find((x) => x.kind === 'session.opened')!.content.acpId)
  assert.ok(
    (
      await lab.write(
        ws,
        raw([
          update(acpId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning the change.' } }),
          update(acpId, {
            sessionUpdate: 'plan',
            entries: [
              { content: 'Read the file', priority: 'high', status: 'completed' },
              { content: 'Edit it', priority: 'medium', status: 'in_progress' },
              { content: 'Run the tests', priority: 'low', status: 'pending' },
            ],
          }),
          update(acpId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Here is the plan.' } }),
        ]),
      )
    ).accepted,
  )
  await lab.turn(ws, 'done')
  assert.ok((await lab.write(ws, '/tool')).accepted)
  await lab.turn(ws, 'done')
  // A permission answered.
  assert.ok((await lab.write(ws, '/permission')).accepted)
  const asked = await until('a permission', async () => (await entries()).findLast((x) => x.method === 'session/request_permission' && x.direction === 'in'))
  await mark('permissionPending')
  const answered = await lab.command(
    ws,
    'RespondPermission',
    { execution: e.id, session: asked.session, requestPosition: asked.position },
    { requestId: asked.rpc_id, outcome: { outcome: 'selected', optionId: 'allow-once' } },
  )
  assert.ok(answered.accepted)
  await lab.turn(ws, 'done')
  // A permission pending when its turn is cancelled.
  assert.ok((await lab.write(ws, '/permission')).accepted)
  await until('a second permission', async () => (await entries()).filter((x) => x.method === 'session/request_permission' && x.direction === 'in').length === 2)
  const running = [...(await lab.state(ws)).turns.values()].at(-1)!
  assert.ok((await lab.command(ws, 'Cancel', { execution: e.id, turn: running.id })).accepted)
  await lab.turn(ws, 'cancelled')
  // A turn made uncertain by a cut, then answered.
  assert.ok((await lab.write(ws, '/sleep 3')).accepted)
  await lab.turn(ws, 'in_progress')
  await mark('inProgress')
  lab.cut()
  await lab.turn(ws, 'uncertain')
  await mark('uncertain')
  await lab.turn(ws, 'done', 30_000)
  // The adapter dies during a turn: the execution is lost, the turn failed; then it ends, with an anchor.
  assert.ok((await lab.write(ws, '/crash')).accepted)
  await until('lost', async () => (await entries()).some((x) => x.kind === 'execution.lost'))
  await mark('lost')
  await expire(lab.kube, e.claimName)
  const ended = await until('ended', async () => (await entries()).find((x) => x.kind === 'execution.ended'))
  await mark('ended')
  // Continued from its anchor, then stopped.
  const restored = await lab.open(ws, { anchor: ended.content.anchor })
  assert.ok((await lab.write(ws, '/recall')).accepted)
  await lab.turn(ws, 'done')
  await mark('restored')
  assert.ok((await lab.command(ws, 'Stop', { execution: restored.id })).accepted)
  await mark('stopped')
  const history: Entry[] = [...(await entries())]
  await writeFile(
    new URL('../test/fixtures/mock.json', import.meta.url),
    `${encode({ capturedAt: new Date().toISOString(), workstream: ws, marks, entries: history })}\n`,
  )
})
