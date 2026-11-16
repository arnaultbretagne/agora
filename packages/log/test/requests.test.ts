// Requests (docs/specs/log.md, "The Workstream view", "Sub-streams"): what an agent waits on until someone answers — a
// permission its own Session asked — makes its Workstream waiting, in its view, its row and the rows above it, as a
// question does. Real bridges and the mock agent, whose `/permission` asks one and waits.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { object, type Entry, type ListRow } from '../src/index.ts'
import { database, expire, FakeKube, Lab, lines, until } from './support.ts'

type T = { after(fn: () => Promise<void>): void }

async function bench(t: T) {
  const db = await database()
  const keys = generateKeyPairSync('ed25519')
  const kube = new FakeKube(keys.publicKey)
  const lab = await Lab.start({ db, kube, keys })
  t.after(async () => {
    await lab.close()
    await kube.closeAll()
    await db.drop()
  })
  return lab
}

const viewOf = async (lab: Lab, ws: string) => (await lab.workstreams.projections.objects(ws)).find((o) => o.kind === 'workstream')?.object
const rowOf = (lab: Lab, ws: string) => lab.workstreams.projections.row(ws, null) as Promise<(ListRow & { request?: string }) | null>
const waitingBelow = async (lab: Lab, ws: string) => Number((await rowOf(lab, ws))?.below.waiting)
const permissions = async (lab: Lab, ws: string) => (await lab.workstreams.projections.objects(ws)).filter((o) => o.kind === 'element' && o.object.type === 'permission').map((o) => o.object)
/** The permission its agent asks next, once the log holds it. */
const asked = (lab: Lab, ws: string, after = '0') =>
  until('a pending permission', async () => [...(await lab.state(ws)).permissions.values()].find((x) => BigInt(x.position) > BigInt(after)))
/** Its view, its row and those of its two parents, once they all say the same. */
const settled = (lab: Lab, ws: string, line: readonly string[], request: string | null) =>
  until(`the line ${request === null ? 'free' : `waiting on ${request}`}`, async () => {
    const [view, row] = [await viewOf(lab, ws), await rowOf(lab, ws)]
    const counts = await Promise.all(line.map((p) => waitingBelow(lab, p)))
    const wanted = request === null ? 0 : 1
    return (view?.request ?? null) === request && (row?.request ?? null) === request && counts.every((n) => n === wanted) ? { view, row, counts } : null
  })
const respond = (lab: Lab, ws: string, request: Entry, body: Record<string, unknown> = {}, origin: 'person' | 'agora' = 'person') =>
  lab.workstreams.command(
    ws,
    {
      id: randomUUID(),
      kind: 'RespondPermission',
      target: { execution: request.execution, session: request.session, requestPosition: request.position },
      body: { requestId: request.rpc_id, outcome: { outcome: 'selected', optionId: 'allow-once' }, ...body },
    },
    origin,
  )

test('L154 a permission pending two levels down; answered; another, its turn cancelled; another, its execution ended: its view and row name it, its two parents count it waiting; then none of them, each time', async (t) => {
  const lab = await bench(t)
  const owner = randomUUID()
  const root = await lab.workstream(owner)
  const first = randomUUID()
  await lab.store.create(first, null, root)
  const under = randomUUID()
  await lab.store.create(under, null, first)
  // The parents have rows of their own, as any Workstream with an execution.
  for (const ws of [root, first]) await lab.open(ws)
  const e = await lab.open(under)
  assert.equal(await waitingBelow(lab, root), 0, 'nothing waits yet')
  // Answered.
  assert.ok((await lab.write(under, '/permission')).accepted)
  const one = await asked(lab, under)
  const waiting = await settled(lab, under, [first, root], one.position)
  assert.equal(waiting.view?.question, null, 'no question: a request')
  assert.ok((await respond(lab, under, one)).accepted)
  await lab.turn(under, 'done')
  await settled(lab, under, [first, root], null)
  // Cancelled: Agora answers it `cancelled` once the Cancel is sent.
  assert.ok((await lab.write(under, '/permission')).accepted)
  const two = await asked(lab, under, one.position)
  await settled(lab, under, [first, root], two.position)
  const turn = await lab.turn(under, 'in_progress')
  assert.ok((await lab.command(under, 'Cancel', { execution: e.id, turn: turn.id })).accepted)
  await lab.turn(under, 'cancelled')
  await settled(lab, under, [first, root], null)
  assert.equal((await permissions(lab, under)).find((p) => p.requestPosition === two.position)?.status, 'answered')
  // Its execution ended: the request goes with it.
  assert.ok((await lab.write(under, '/permission')).accepted)
  const three = await asked(lab, under, two.position)
  await settled(lab, under, [first, root], three.position)
  await expire(lab.kube, e.claimName)
  await until('its execution ended', async () => (await lab.state(under)).current?.ended, 30_000)
  await settled(lab, under, [first, root], null)
  assert.equal((await permissions(lab, under)).find((p) => p.requestPosition === three.position)?.status, 'cancelled')
})

test('L155 a native sub-agent asking a permission: its sub-stream waiting, counted under its host; its host’s own view and row with no request', async (t) => {
  const lab = await bench(t)
  const ws = await lab.workstream()
  await lab.open(ws)
  assert.ok((await lab.write(ws, `/sub ${JSON.stringify({ n: 1, permission: true })}`)).accepted)
  await until('its host counts it waiting', async () => (await waitingBelow(lab, ws)) === 1)
  assert.ok([...(await lab.state(ws)).permissions.values()].length > 0, 'a permission pending in its host’s log')
  assert.equal((await viewOf(lab, ws))?.request, undefined)
  assert.equal((await rowOf(lab, ws))?.request, undefined)
})

test('L156 a Respond to a permission naming who answers: Agora’s, kept and on the permission answered; the person’s, left out', async (t) => {
  const lab = await bench(t)
  const ws = await lab.workstream()
  await lab.open(ws)
  const from = { workstream: randomUUID(), as: 'delegator' }
  assert.ok((await lab.write(ws, '/permission')).accepted)
  const one = await asked(lab, ws)
  assert.ok((await respond(lab, ws, one, { from }, 'agora')).accepted)
  await lab.turn(ws, 'done')
  const responds = async () => (await lab.entries(ws)).filter((x) => x.kind === 'command' && x.content.kind === 'RespondPermission')
  assert.deepEqual(object((await responds())[0]!.content.body)?.from, from)
  const answered = await until('answered', async () => (await permissions(lab, ws)).find((p) => p.requestPosition === one.position && p.status === 'answered'))
  assert.deepEqual([answered.from, answered.as], [from.workstream, 'delegator'])
  // The person's own `from` is not theirs to give.
  assert.ok((await lab.write(ws, '/permission')).accepted)
  const two = await asked(lab, ws, one.position)
  assert.ok((await respond(lab, ws, two, { from })).accepted)
  await lab.turn(ws, 'done')
  assert.equal(object((await responds())[1]!.content.body)?.from, undefined)
  const mine = await until('answered', async () => (await permissions(lab, ws)).find((p) => p.requestPosition === two.position && p.status === 'answered'))
  assert.deepEqual([mine.from, mine.as], [undefined, undefined])
})

/** Lines the mock agent writes byte for byte (packages/mock-agent, `/raw`). */
const raw = (values: unknown[]) => `/raw ${Buffer.from(values.map((v) => JSON.stringify(v)).join('\n')).toString('base64')}`

test('L158 an agent withdrawing its pending permission by $/cancel_request; then one naming no request pending: answered cancelled once, its request gone, its parent waiting 0, its turn going on to its end; then no answer written', async (t) => {
  const lab = await bench(t)
  const parent = await lab.workstream()
  const ws = randomUUID()
  await lab.store.create(ws, null, parent)
  await lab.open(parent)
  await lab.open(ws)
  assert.ok((await lab.write(ws, '/withdraw 1')).accepted)
  const request = await asked(lab, ws)
  await settled(lab, ws, [parent], request.position)
  await lab.turn(ws, 'done', 20_000)
  await settled(lab, ws, [parent], null)
  const entries = await lab.entries(ws)
  assert.equal(lines(entries, 'in', '$/cancel_request').length, 1)
  const answers = () => lines(entries, 'out').filter((x) => x.request_position === request.position)
  assert.deepEqual(answers().map((x) => x.content.result), [{ outcome: { outcome: 'cancelled' } }])
  const permission = await until('answered', async () => (await permissions(lab, ws)).find((p) => p.requestPosition === request.position && p.status === 'answered'))
  assert.deepEqual(permission.answer, { outcome: { outcome: 'cancelled' } })
  // The agent's turn went on, given the answer it still expects.
  const said = lines(entries, 'in', 'session/update').map((x) => object(object(x.content.params)?.update)).filter((u) => u?.sessionUpdate === 'agent_message_chunk').map((u) => String(object(u!.content)?.text))
  assert.ok(said.includes('Withdrawn: cancelled.'), said.join(' | '))
  // A withdrawal naming no request pending: nothing answered.
  const responses = async () => (await lab.entries(ws)).filter((x) => x.direction === 'out' && x.correlated_method === 'session/request_permission').length
  const before = await responses()
  assert.ok((await lab.write(ws, raw([{ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'mock-999' } }]))).accepted)
  await lab.turn(ws, 'done', 20_000)
  assert.equal(lines(await lab.entries(ws), 'in', '$/cancel_request').length, 2, 'the second withdrawal received')
  assert.equal(await responses(), before)
})
