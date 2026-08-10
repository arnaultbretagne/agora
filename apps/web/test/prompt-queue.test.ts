import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { createHttpBrokerGrantClient } from '../src/broker-grant-client.js'
import { SessionConnectionRegistry } from '../src/connections.js'
import { startProjectorSweepLoop, type ProjectorSweepLoopHandle } from '../src/projector-loop.js'
import { SessionPromptQueue } from '../src/prompt-queue.js'
import { createServer } from '../src/server.js'
import { startFakeBroker, type FakeBrokerHandle } from './support/fake-broker.js'
import { startFakeController, type FakeControllerHandle } from './support/fake-controller.js'
import { openTestDatabase, type TestDatabaseHandle } from './support.js'

// ---------------------------------------------------------------------------------------------
// The unit half: the queue on its own.
// ---------------------------------------------------------------------------------------------

test('SessionPromptQueue runs one task at a time per Session', async () => {
  const queue = new SessionPromptQueue()
  let running = 0
  let peak = 0
  const task = async (ms: number): Promise<void> => {
    running += 1
    peak = Math.max(peak, running)
    await sleep(ms)
    running -= 1
  }

  await Promise.all([queue.run('s1', () => task(30)), queue.run('s1', () => task(5)), queue.run('s1', () => task(5))])

  assert.equal(peak, 1, 'two tasks were in flight at once for the same Session')
})

test('SessionPromptQueue does not serialize across different Sessions', async () => {
  const queue = new SessionPromptQueue()
  let running = 0
  let peak = 0
  const task = async (): Promise<void> => {
    running += 1
    peak = Math.max(peak, running)
    await sleep(20)
    running -= 1
  }

  await Promise.all([queue.run('a', task), queue.run('b', task)])

  // Serializing every Session against every other one would turn one slow turn into a global
  // stall — the queue is per Session, and this is what says so.
  assert.equal(peak, 2)
})

test('SessionPromptQueue keeps draining after a task rejects', async () => {
  const queue = new SessionPromptQueue()
  const order: string[] = []

  const failing = queue.run('s1', async () => {
    order.push('first')
    throw new Error('boom')
  })
  const following = queue.run('s1', async () => {
    order.push('second')
    return 'ok'
  })

  await assert.rejects(failing, /boom/)
  assert.equal(await following, 'ok', 'a failed turn stranded every message queued behind it')
  assert.deepEqual(order, ['first', 'second'])
})

test('SessionPromptQueue reports depth and forgets idle Sessions', async () => {
  const queue = new SessionPromptQueue()
  assert.equal(queue.depth('s1'), 0)

  const first = queue.run('s1', () => sleep(20))
  const second = queue.run('s1', () => sleep(1))
  assert.equal(queue.depth('s1'), 2, 'depth must count the running task and everything behind it')

  await Promise.all([first, second])
  await queue.drain('s1')
  assert.equal(queue.depth('s1'), 0)
})

// ---------------------------------------------------------------------------------------------
// The half that matters: the real HTTP surface, a real fake Agent, three prompts at once.
// ---------------------------------------------------------------------------------------------

let controller: FakeControllerHandle
let broker: FakeBrokerHandle
let db: TestDatabaseHandle
let server: ReturnType<typeof createServer>
let sweepLoop: ProjectorSweepLoopHandle
let baseUrl: string

/** Observed by the fake Agent itself, which is the only place that can tell the truth about it. */
const promptConcurrency = { current: 0, peak: 0, seen: [] as string[] }

before(async () => {
  controller = await startFakeController({
    onPrompt: async (params) => {
      promptConcurrency.current += 1
      promptConcurrency.peak = Math.max(promptConcurrency.peak, promptConcurrency.current)
      const text = params.prompt.map((block) => ('text' in block ? block.text : '')).join('')
      promptConcurrency.seen.push(text)
      // The first turn is deliberately long so the prompts sent after it are certain to arrive
      // while it is STILL RUNNING, on a fast laptop and on a slow CI runner alike — the failure
      // this guards against was three prompts sent inside 2 seconds of a 19-minute turn. Timing
      // this with a fixed sleep for every turn made the test racy: on CI the first turn finished
      // before the test noticed it had started.
      await sleep(text === 'premier tour' ? 1_500 : 50)
      promptConcurrency.current -= 1
      return { stopReason: 'end_turn' }
    },
  })
  broker = await startFakeBroker()
  db = await openTestDatabase()
  server = createServer({
    pool: db.pool,
    controllerTransport: controller,
    brokerGrantClient: createHttpBrokerGrantClient(broker.baseUrl),
    connections: new SessionConnectionRegistry(),
    promptQueue: new SessionPromptQueue(),
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  sweepLoop = startProjectorSweepLoop(db.pool, 100)
})

after(async () => {
  await sleep(1_000)
  await sweepLoop.stop()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.close()
  await controller.close()
  await broker.close()
})

function auth(principal: string): HeadersInit {
  return { authorization: `Bearer ${principal}` }
}

async function createReadyWorkstream(): Promise<{ workstreamId: string; sessionId: string }> {
  const res = await fetch(`${baseUrl}/v1/workstreams`, {
    method: 'POST',
    headers: { ...auth('alice'), 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    body: JSON.stringify({
      category: 'discussion',
      agentId: 'fake-agent',
      workspace: { workspaceRef: 'pvc-1' },
      equipment: { catalogueVersion: '2026-08-01', resources: [] },
      prompt: [{ type: 'text', text: 'premier tour' }],
    }),
  })
  const body = (await res.json()) as { workstream: { id: string }; session: { id: string } }
  assert.equal(res.status, 202, JSON.stringify(body))

  // Provisioning is deliberately fire-and-forget, so wait for the Session to actually be
  // promptable rather than guessing.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const session = (await (await fetch(`${baseUrl}/v1/sessions/${body.session.id}`, { headers: auth('alice') })).json()) as {
      phase: string
    }
    if (session.phase === 'ready' || session.phase === 'busy') break
    await sleep(100)
  }
  return { workstreamId: body.workstream.id, sessionId: body.session.id }
}

function sendPrompt(sessionId: string, text: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/sessions/${sessionId}/prompts`, {
    method: 'POST',
    headers: { ...auth('alice'), 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    body: JSON.stringify({ content: [{ type: 'text', text }] }),
  })
}

test('three prompts fired at once reach the Agent one turn at a time', async () => {
  const { sessionId } = await createReadyWorkstream()

  // Wait until the Agent is demonstrably INSIDE the first turn before sending anything else —
  // "the Session says ready-or-busy" is not the same fact, and on a slow runner the first turn can
  // begin and end inside that gap. Only once it is running does `peak` mean anything: a second
  // turn entered now would make it 2.
  const startDeadline = Date.now() + 20_000
  while (Date.now() < startDeadline && !promptConcurrency.seen.includes('premier tour')) await sleep(20)
  assert.ok(promptConcurrency.seen.includes('premier tour'), 'the first turn never reached the Agent')
  assert.equal(promptConcurrency.current, 1, 'the first turn should still be running at this point')
  promptConcurrency.peak = 0

  // Exactly the 2026-08-09 incident: an operator typing again while the Agent is still working.
  // Sent one after another, the way a person and a browser actually send them — each POST returns
  // as soon as the prompt is accepted, so all three are in before the first turn has finished.
  // (Firing them with `Promise.all` instead would race acceptance itself, and the order the three
  // Commands get accepted in is then genuinely undefined — the queue orders dispatch, it cannot
  // order three simultaneous HTTP requests, and asserting otherwise would test the network.)
  for (const text of ['deuxieme', 'troisieme', 'quatrieme']) {
    const res = await sendPrompt(sessionId, text)
    assert.equal(res.status, 202)
  }

  // The API answers on acceptance now, so the turns are still running at this point — that is the
  // behaviour being asserted, not an accident of timing.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && promptConcurrency.seen.length < 4) await sleep(50)

  // Measured from a point where the Agent was known to be busy, so this is a real reading: an
  // unserialized dispatch puts the next turn in while the first is still running.
  assert.equal(promptConcurrency.peak, 1, `the Agent saw ${promptConcurrency.peak} prompt turns in flight at once`)

  // And the other half — one at a time is worthless if the extra messages are dropped rather than
  // delivered. Without serialization the second turn's `ready -> busy` transition throws, the
  // prompt never reaches the Agent, and it is this line that goes red.
  assert.deepEqual(
    promptConcurrency.seen,
    ['premier tour', 'deuxieme', 'troisieme', 'quatrieme'],
    'every prompt must reach the Agent, in the order it was accepted',
  )
})

test('a queued prompt is durable and terminal, and its turn is closed', async () => {
  const { workstreamId, sessionId } = await createReadyWorkstream()
  const responses = await Promise.all([sendPrompt(sessionId, 'un'), sendPrompt(sessionId, 'deux')])
  const commandIds = await Promise.all(
    responses.map(async (res) => ((await res.json()) as { commandId: string; state: string }).commandId),
  )

  // Every prompt is a real Command row from the instant the API answers — a queued message is
  // never something held only in a socket.
  for (const id of commandIds) assert.match(id, /^[0-9a-f-]{36}$/)

  const client = await db.pool.connect()
  try {
    const deadline = Date.now() + 20_000
    let states: string[] = []
    while (Date.now() < deadline) {
      const { rows } = await client.query<{ state: string }>('SELECT state FROM product.commands WHERE id = ANY($1::uuid[])', [
        commandIds,
      ])
      states = rows.map((r) => r.state)
      if (states.length === 2 && states.every((s) => s === 'completed')) break
      await sleep(100)
    }
    assert.deepEqual(states.sort(), ['completed', 'completed'], 'queued prompts must reach a terminal Command state')

    // The other half of the 2026-08-09 wedge: an open turn makes the whole Session ineligible for
    // idle collection, so "the Command settled" is not enough — the turn has to close too.
    // Turns are closed by the projector, which runs on its own sweep loop, so this waits for the
    // projection rather than assuming it has already caught up with the Commands.
    let open = -1
    const turnDeadline = Date.now() + 20_000
    while (Date.now() < turnDeadline) {
      const { rows } = await client.query<{ open: number }>(
        'SELECT count(*)::int AS open FROM projection.turns WHERE workstream_id = $1 AND ended_at IS NULL',
        [workstreamId],
      )
      open = rows[0]?.open ?? -1
      if (open === 0) break
      await sleep(100)
    }
    assert.equal(open, 0, 'a finished turn was left with a NULL ended_at')

    // Step 8 of docs/specs/03: the Session is handed back, not parked in `busy`. Polled, because
    // the Command is marked `completed` a moment BEFORE the phase is released — reading the phase
    // straight after the Command settles is a race, not an assertion.
    let phase = ''
    const phaseDeadline = Date.now() + 20_000
    while (Date.now() < phaseDeadline) {
      const { rows } = await client.query<{ phase: string }>('SELECT phase FROM product.sessions WHERE id = $1', [sessionId])
      phase = rows[0]?.phase ?? ''
      if (phase === 'ready') break
      await sleep(50)
    }
    assert.equal(phase, 'ready', 'the Session was left in busy after its last turn finished')
  } finally {
    client.release()
  }
})
