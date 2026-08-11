import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import { nameBasedUuid } from '@agora/domain'
import { listSessionConfigIntent } from '@agora/store-pg'
import { createHttpBrokerGrantClient } from '../src/broker-grant-client.js'
import { CONFIG_PROBE_SESSION_NAMESPACE } from '../src/config-catalogue.js'
import { SessionConnectionRegistry } from '../src/connections.js'
import { startProjectorSweepLoop, type ProjectorSweepLoopHandle } from '../src/projector-loop.js'
import { createServer } from '../src/server.js'
import { startFakeBroker, type FakeBrokerHandle } from './support/fake-broker.js'
import { startFakeController, type FakeControllerHandle } from './support/fake-controller.js'
import { openTestDatabase, type TestDatabaseHandle } from './support.js'

/**
 * P12 — model/effort selection that works in all three situations a conversation is ever in, and a
 * Workstream that ends up with a real name.
 *
 * Everything here runs against a REAL HTTP server, a REAL fake ACP Agent over a REAL WebSocket and a
 * REAL Postgres, like the rest of this suite: the defects this plan fixes were both invisible to
 * unit tests (a disabled button and a `409` are perfectly well-formed responses) and only showed up
 * when a whole path was exercised end to end.
 */

let controller: FakeControllerHandle
let broker: FakeBrokerHandle
let db: TestDatabaseHandle
let server: ReturnType<typeof createServer>
let sweepLoop: ProjectorSweepLoopHandle
let baseUrl: string

before(async () => {
  db = await openTestDatabase()
  // The pool is passed so a suspend's custody snapshot writes a real row: `product.agent_anchors`
  // has a composite foreign key onto it, and a suspend against a snapshot-less double fails there.
  controller = await startFakeController(
    {
    // Faithful to both shipped Agents: the Claude adapter reads the harness's own generated session
    // title at the end of every turn and notifies when it changed; Codex forwards
    // `thread/name/updated`. A double that never titled itself could not prove the path this plan
    // is about.
      onPrompt: async (params, context) => {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'réponse' } },
        })
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'session_info_update', title: 'Bolée vs bol à cidre', updatedAt: new Date().toISOString() },
        })
        return { stopReason: 'end_turn' }
      },
    },
    db.pool,
  )
  broker = await startFakeBroker()
  server = createServer({
    pool: db.pool,
    controllerTransport: controller,
    brokerGrantClient: createHttpBrokerGrantClient(broker.baseUrl),
    connections: new SessionConnectionRegistry(),
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

function auth(principal = 'alice'): HeadersInit {
  return { authorization: `Bearer ${principal}` }
}

function idem(): HeadersInit {
  return { 'idempotency-key': randomUUID() }
}

async function createWorkstream(body: Record<string, unknown>): Promise<{ workstream: { id: string; title: string }; session: { id: string } }> {
  const res = await fetch(`${baseUrl}/v1/workstreams`, {
    method: 'POST',
    headers: { ...auth(), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({
      category: 'discussion',
      agentId: 'fake-agent',
      workspace: { workspaceRef: 'ephemeral' },
      equipment: { catalogueVersion: 'equipment-v1', resources: [] },
      prompt: [{ type: 'text', text: 'bonjour' }],
      ...body,
    }),
  })
  const parsed = (await res.json()) as { workstream: { id: string; title: string }; session: { id: string } }
  assert.equal(res.status, 202, JSON.stringify(parsed))
  return parsed
}

async function waitForPhase(sessionId: string, phases: readonly string[], timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, { headers: auth() })
    const session = (await res.json()) as { phase: string; failure?: { detail?: string } }
    if (phases.includes(session.phase)) return session.phase
    if (session.phase === 'failed') throw new Error(`session failed: ${session.failure?.detail ?? 'unknown'}`)
    if (Date.now() > deadline) throw new Error(`session ${sessionId} never reached ${phases.join('|')} (last: ${session.phase})`)
    await sleep(150)
  }
}

/** The journal is the only honest record of what was really sent to the Agent, and in what order. */
async function journalMethods(workstreamId: string): Promise<{ method: string | null; kind: string; seq: number }[]> {
  const client = await db.pool.connect()
  try {
    const { rows } = await client.query<{ method: string | null; rpc_kind: string; workstream_seq: number }>(
      'SELECT method, rpc_kind, workstream_seq FROM product.workstream_events WHERE workstream_id = $1 ORDER BY workstream_seq',
      [workstreamId],
    )
    return rows.map((row) => ({ method: row.method, kind: row.rpc_kind, seq: Number(row.workstream_seq) }))
  } finally {
    client.release()
  }
}

async function intents(sessionId: string) {
  const client = await db.pool.connect()
  try {
    return await listSessionConfigIntent(client, sessionId)
  } finally {
    client.release()
  }
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`)
    await sleep(150)
  }
}

test('a model chosen before the conversation exists is really sent to the Agent, and before the first prompt', async () => {
  const created = await createWorkstream({
    prompt: [{ type: 'text', text: 'compare une bolée et un bol' }],
    configOptions: [
      { optionId: 'model', value: 'opus' },
      { optionId: 'effort', value: 'max' },
    ],
  })
  await waitForPhase(created.session.id, ['ready', 'busy'])

  const journal = await waitFor(
    () => journalMethods(created.workstream.id),
    (events) => events.some((e) => e.method === 'session/prompt'),
    'the first prompt to be journaled',
  )
  const configSeqs = journal.filter((e) => e.method === 'session/set_config_option').map((e) => e.seq)
  const promptSeq = journal.find((e) => e.method === 'session/prompt')!.seq
  assert.equal(configSeqs.length, 2, `expected both choices to be sent: ${JSON.stringify(journal)}`)
  // The whole point of applying at bootstrap: the FIRST turn already runs on the chosen model,
  // rather than the harness default with a correction arriving afterwards.
  for (const seq of configSeqs) assert.ok(seq < promptSeq, `config option ${seq} was sent after the prompt ${promptSeq}`)

  // And the Agent — the only authority on this — really holds them now.
  const recorded = await intents(created.session.id)
  assert.deepEqual(
    [...recorded].sort((a, b) => a.optionId.localeCompare(b.optionId)).map((i) => [i.optionId, i.value, i.appliedAt !== null]),
    [
      ['effort', 'max', true],
      ['model', 'opus', true],
    ],
  )
})

test('a value the Agent refuses is surfaced as a refusal and not re-asserted for ever', async () => {
  const created = await createWorkstream({})
  await waitForPhase(created.session.id, ['ready', 'busy'])

  const res = await fetch(`${baseUrl}/v1/sessions/${created.session.id}/config-options/model`, {
    method: 'PUT',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'a-model-this-agent-never-offered' }),
  })
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as { code: string }).code, 'config_option_rejected')
  assert.equal((await intents(created.session.id)).length, 0, 'a refused value must not survive to be replayed on every resume')
})

test('changing the model with no live Runtime is accepted, recorded, and really applied on the next resume', async () => {
  const created = await createWorkstream({})
  await waitForPhase(created.session.id, ['ready', 'busy'])
  // Give the Session's own bootstrap prompt time to finish so the suspend below captures a
  // quiescent Agent, exactly as the idle reaper's own suspend does.
  await waitFor(
    () => journalMethods(created.workstream.id),
    (events) => events.some((e) => e.method === 'session/prompt'),
    'the first prompt to be journaled',
  )

  const suspend = await fetch(`${baseUrl}/v1/sessions/${created.session.id}/suspend`, { method: 'POST', headers: { ...auth(), ...idem() } })
  assert.equal(suspend.status, 202)
  await waitForPhase(created.session.id, ['suspended'])

  const before = (await journalMethods(created.workstream.id)).filter((e) => e.method === 'session/set_config_option').length
  const res = await fetch(`${baseUrl}/v1/sessions/${created.session.id}/config-options/model`, {
    method: 'PUT',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'opus' }),
  })
  const body = (await res.json()) as { pending?: boolean; detail?: string }
  // This used to be a 409 `runtime_unavailable`, which is what made the selector unusable for the
  // whole idle half of a conversation's life.
  assert.equal(res.status, 202, JSON.stringify(body))
  assert.equal(body.pending, true)
  const recorded = await intents(created.session.id)
  assert.deepEqual(
    recorded.map((i) => [i.optionId, i.value, i.appliedAt]),
    [['model', 'opus', null]],
    'recorded, but honestly not applied yet',
  )

  const activate = await fetch(`${baseUrl}/v1/sessions/${created.session.id}/activate`, { method: 'POST', headers: { ...auth(), ...idem() } })
  assert.equal(activate.status, 202)
  await waitForPhase(created.session.id, ['ready', 'busy'])

  await waitFor(
    () => journalMethods(created.workstream.id),
    (events) => events.filter((e) => e.method === 'session/set_config_option').length > before,
    'the resumed Agent to be told about the choice made while it was gone',
  )
  const applied = await waitFor(() => intents(created.session.id), (rows) => rows[0]?.appliedAt !== null, 'the intent to be marked applied')
  assert.equal(applied[0]?.value, 'opus')
})

test('a live change goes straight to the Agent and refreshes what the next conversation will be offered', async () => {
  const created = await createWorkstream({})
  await waitForPhase(created.session.id, ['ready', 'busy'])

  const res = await fetch(`${baseUrl}/v1/sessions/${created.session.id}/config-options/effort`, {
    method: 'PUT',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'high' }),
  })
  const body = (await res.json()) as { configOptions?: { id: string; currentValue: string }[] }
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(body.configOptions?.find((o) => o.id === 'effort')?.currentValue, 'high')

  const catalogue = (await (await fetch(`${baseUrl}/v1/agents/fake-agent/config-options`, { headers: auth() })).json()) as {
    state: string
    options: { id: string; currentValue?: unknown }[]
  }
  assert.equal(catalogue.state, 'known')
  assert.deepEqual(
    catalogue.options.map((o) => o.id),
    ['model', 'effort'],
  )
  // One Session's chosen effort is not the next conversation's default.
  for (const option of catalogue.options) assert.equal(option.currentValue, undefined)
})

test('an Agent nobody has ever launched is run empty once, and its Runtime is given back', async () => {
  // `fake-agent-b` gets no conversation in this file, so nothing has ever advertised for it — the
  // exact cold-start case the operator asked to be closed by an empty run rather than by declaring
  // models in the product.
  const unknown = (await (await fetch(`${baseUrl}/v1/agents/fake-agent-b/config-options`, { headers: auth() })).json()) as { state: string }
  assert.equal(unknown.state, 'unknown')

  const probeSessionId = nameBasedUuid(CONFIG_PROBE_SESSION_NAMESPACE, 'fake-agent-b:v1')
  // Two at once, as two browser tabs would: they must join the same run, not each take a Pod out of
  // a namespace that only holds a handful.
  const [first, second] = await Promise.all([
    fetch(`${baseUrl}/v1/agents/fake-agent-b/config-options/probe`, { method: 'POST', headers: auth() }),
    fetch(`${baseUrl}/v1/agents/fake-agent-b/config-options/probe`, { method: 'POST', headers: auth() }),
  ])
  assert.ok([200, 202].includes(first.status))
  assert.ok([200, 202].includes(second.status))

  const known = await waitFor(
    async () =>
      (await (await fetch(`${baseUrl}/v1/agents/fake-agent-b/config-options`, { headers: auth() })).json()) as {
        state: string
        options: { id: string }[]
      },
    (view) => view.state === 'known',
    'the empty run to answer',
  )
  assert.deepEqual(
    known.options.map((o) => o.id),
    ['model', 'effort'],
  )

  assert.equal(
    broker.ensureCalls.filter((call) => call.sessionId === probeSessionId).length,
    1,
    'two concurrent asks must join one empty run, not start two Runtimes',
  )
  assert.ok(controller.dematerializeCalls.includes(probeSessionId), 'the probe Runtime must be given back')

  // A probe is a question about an Agent, not a conversation: it leaves no product truth behind.
  const client = await db.pool.connect()
  try {
    const { rows } = await client.query('SELECT 1 FROM product.sessions WHERE id = $1', [probeSessionId])
    assert.equal(rows.length, 0)
    const { rows: events } = await client.query('SELECT 1 FROM product.workstream_events WHERE session_id = $1', [probeSessionId])
    assert.equal(events.length, 0)
  } finally {
    client.release()
  }
})

test('a Workstream is named by its first message, then by its Agent, and a rename outranks both', async () => {
  const created = await createWorkstream({
    prompt: [
      {
        type: 'text',
        text: 'Explique-moi la différence entre une bolée de cidre et un bol de cidre, en détail et avec des exemples bretons',
      },
    ],
  })
  // The floor: what the operator actually typed, truncated on a word boundary — never `Untitled`,
  // which is what every Workstream in production was called before this plan.
  assert.equal(created.workstream.title, 'Explique-moi la différence entre une bolée de cidre et un…')
  await waitForPhase(created.session.id, ['ready', 'busy'])

  const title = async (): Promise<string> => {
    const res = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}`, { headers: auth() })
    return ((await res.json()) as { title: string }).title
  }
  assert.equal(await waitFor(title, (value) => value === 'Bolée vs bol à cidre', 'the Agent to name its own conversation'), 'Bolée vs bol à cidre')

  const renamed = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}`, {
    method: 'PATCH',
    headers: { ...auth(), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Mon titre à moi' }),
  })
  assert.equal(renamed.status, 200)
  assert.equal(await title(), 'Mon titre à moi')

  // A later turn re-titles the ACP session; the operator's own name must survive it.
  const prompt = await fetch(`${baseUrl}/v1/sessions/${created.session.id}/prompts`, {
    method: 'POST',
    headers: { ...auth(), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({ content: [{ type: 'text', text: 'et le lambig ?' }] }),
  })
  assert.equal(prompt.status, 202)
  await sleep(1_000)
  assert.equal(await title(), 'Mon titre à moi')
})
