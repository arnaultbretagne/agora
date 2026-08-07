import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { createHttpBrokerGrantClient } from '../src/broker-grant-client.js'
import { SessionConnectionRegistry } from '../src/connections.js'
import { startProjectorSweepLoop, type ProjectorSweepLoopHandle } from '../src/projector-loop.js'
import { createServer } from '../src/server.js'
import { startFakeBroker, type FakeBrokerHandle } from './support/fake-broker.js'
import { startFakeController, type FakeControllerHandle } from './support/fake-controller.js'
import { openTestDatabase, type TestDatabaseHandle } from './support.js'

let controller: FakeControllerHandle
let broker: FakeBrokerHandle
let db: TestDatabaseHandle
let server: ReturnType<typeof createServer>
let sweepLoop: ProjectorSweepLoopHandle
let baseUrl: string

before(async () => {
  controller = await startFakeController()
  broker = await startFakeBroker()
  db = await openTestDatabase()
  server = createServer({
    pool: db.pool,
    controllerTransport: controller,
    brokerGrantClient: createHttpBrokerGrantClient(broker.baseUrl),
    connections: new SessionConnectionRegistry(),
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
  sweepLoop = startProjectorSweepLoop(db.pool, 100)
})

after(async () => {
  // `POST /v1/workstreams` fires `provisionSessionAndPrompt` fire-and-forget (by design — "P05
  // provisioning continues asynchronously"), so nothing tracks when the last test's background
  // chain finishes; give it a moment to settle before closing the pool out from under it.
  await sleep(1_000)
  await sweepLoop.stop()
  // A test's SSE fetch may not have fully torn down its keep-alive connection yet even after its
  // AbortController fired — server.close() alone waits for that, which can hang the whole suite.
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.close()
  await controller.close()
  await broker.close()
})

function auth(principal: string): HeadersInit {
  return { authorization: `Bearer ${principal}` }
}

function idem(): HeadersInit {
  return { 'idempotency-key': randomUUID() }
}

interface FeedEvent {
  readonly workstreamId: string
  readonly position: number
  readonly throughWorkstreamSeq: number
  readonly operation: string
  readonly payload: Record<string, unknown>
}

/** Reads SSE frames until `minEvents` arrive or `timeoutMs` elapses, then reliably aborts the fetch via AbortController (not just `reader.cancel()`, which does not reliably tear down the underlying connection). */
async function collectFeedEvents(url: string, principal: string, minEvents: number, timeoutMs: number): Promise<FeedEvent[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const events: FeedEvent[] = []
  try {
    const res = await fetch(url, { headers: auth(principal), signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    try {
      while (events.length < minEvents) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        let boundary: number
        while ((boundary = buffered.indexOf('\n\n')) !== -1) {
          const frame = buffered.slice(0, boundary)
          buffered = buffered.slice(boundary + 2)
          if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice('data: '.length)) as FeedEvent)
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return events
}

async function createWorkstream(principal = 'alice', prompt: { type: string; text: string }[] = [{ type: 'text', text: 'hi' }]) {
  const res = await fetch(`${baseUrl}/v1/workstreams`, {
    method: 'POST',
    headers: { ...auth(principal), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({
      category: 'discussion',
      agentId: 'fake-agent',
      workspace: { workspaceRef: 'pvc-1' },
      equipment: { catalogueVersion: '2026-08-01', resources: [] },
      prompt,
    }),
  })
  const body = (await res.json()) as { command: { commandId: string }; workstream: { id: string }; session: { id: string; persona?: string } }
  assert.equal(res.status, 202, JSON.stringify(body))
  return body
}

test('POST /v1/workstreams requires Authorization', async () => {
  const res = await fetch(`${baseUrl}/v1/workstreams`, { method: 'POST', headers: { ...idem() }, body: '{}' })
  assert.equal(res.status, 401)
})

test('required: X-Forwarded-Email (the oauth2-proxy/Pocket-ID SSO path) authenticates a request the same as Authorization: Bearer', async () => {
  // Mirrors 'POST /v1/workstreams requires Idempotency-Key' exactly, swapping the auth header —
  // deliberately does NOT create a real Workstream (which would provision a Session against the
  // shared fake controller and could interact with other tests' own timing-sensitive polling).
  // Reaching the SAME downstream validation error (400, not 401) proves requirePrincipal()
  // accepted this header — that's the only thing this test needs to establish.
  const res = await fetch(`${baseUrl}/v1/workstreams`, { method: 'POST', headers: { 'x-forwarded-email': 'operator@bretagne.dev' }, body: '{}' })
  assert.equal(res.status, 400)
})

test('POST /v1/workstreams requires Idempotency-Key', async () => {
  const res = await fetch(`${baseUrl}/v1/workstreams`, { method: 'POST', headers: { ...auth('alice') }, body: '{}' })
  assert.equal(res.status, 400)
})

test('required: an unknown agentId is rejected before creating anything (agent_unavailable)', async () => {
  const res = await fetch(`${baseUrl}/v1/workstreams`, {
    method: 'POST',
    headers: { ...auth('alice'), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({
      category: 'discussion',
      agentId: 'no-such-agent',
      workspace: { workspaceRef: 'pvc-1' },
      equipment: { catalogueVersion: '2026-08-01', resources: [] },
      prompt: [{ type: 'text', text: 'hi' }],
    }),
  })
  assert.equal(res.status, 409)
  const body = (await res.json()) as { code: string }
  assert.equal(body.code, 'agent_unavailable')
})

test('full golden path: create -> ready -> items/turns list the real reply', async () => {
  const created = await createWorkstream('alice')

  let items: { items: unknown[] } = { items: [] }
  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/items`, { headers: auth('alice') })
    items = (await res.json()) as typeof items
    if (items.items.length > 0) break
    await sleep(250)
  }
  assert.ok(items.items.length > 0, 'the fake Agent reply eventually gets projected and listed')

  // A turn's own status flip to 'completed' is not synchronous with its reply item appearing in
  // the projection above (found live, P11 — genuinely intermittent under load, not a fixed one-
  // shot check anywhere else that polls a fire-and-forget chain in this file); poll like every
  // other wait-for-async-settle helper in this codebase (e.g. orchestration.test.ts's
  // `waitForPhase`) instead of asserting on a single snapshot.
  let turns: { turns: { status: string }[] } = { turns: [] }
  for (let i = 0; i < 40; i += 1) {
    const turnsRes = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/turns`, { headers: auth('alice') })
    turns = (await turnsRes.json()) as typeof turns
    if (turns.turns.some((t) => t.status === 'completed')) break
    await sleep(250)
  }
  assert.ok(turns.turns.some((t) => t.status === 'completed'))
})

test('required: unauthorized Workstream/Session access is denied', async () => {
  const created = await createWorkstream('alice')

  const wsRes = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}`, { headers: auth('mallory') })
  assert.equal(wsRes.status, 404)

  const sessionRes = await fetch(`${baseUrl}/v1/sessions/${created.session.id}`, { headers: auth('mallory') })
  assert.equal(sessionRes.status, 404)

  const itemsRes = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/items`, { headers: auth('mallory') })
  assert.equal(itemsRes.status, 404)

  const feedRes = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/feed`, { headers: auth('mallory') })
  assert.equal(feedRes.status, 404)
})

test('required: viewer mutations are denied', async () => {
  const created = await createWorkstream('alice')
  await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/memberships/bob`, {
    method: 'PUT',
    headers: { ...auth('alice'), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'viewer' }),
  })

  const patchRes = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}`, {
    method: 'PATCH',
    headers: { ...auth('bob'), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'hijacked' }),
  })
  assert.equal(patchRes.status, 403)

  const deleteRes = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}`, {
    method: 'DELETE',
    headers: { ...auth('bob'), ...idem() },
  })
  assert.equal(deleteRes.status, 403)
})

test('required: editor cannot manage memberships (owner-only)', async () => {
  const created = await createWorkstream('alice')
  await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/memberships/carol`, {
    method: 'PUT',
    headers: { ...auth('alice'), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'editor' }),
  })

  const putRes = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/memberships/dave`, {
    method: 'PUT',
    headers: { ...auth('carol'), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'viewer' }),
  })
  assert.equal(putRes.status, 403)

  const deleteRes = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/memberships/alice`, {
    method: 'DELETE',
    headers: { ...auth('carol'), ...idem() },
  })
  assert.equal(deleteRes.status, 403)

  const listRes = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/memberships`, { headers: auth('carol') })
  assert.equal(listRes.status, 403)
})

test('required: the last owner cannot be removed', async () => {
  const created = await createWorkstream('alice')
  const res = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/memberships/alice`, {
    method: 'DELETE',
    headers: { ...auth('alice'), ...idem() },
  })
  assert.equal(res.status, 409)
})

test('required: Browser responses contain no grant reference, relay credential, OneCLI Agent ID or upstream error body', async () => {
  const created = await createWorkstream('alice')

  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}`, { headers: auth('alice') })
    const detail = (await res.json()) as { sessions: { phase: string }[] }
    if (detail.sessions[0]?.phase === 'ready') break
    await sleep(250)
  }

  const responses = await Promise.all([
    fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}`, { headers: auth('alice') }),
    fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/items`, { headers: auth('alice') }),
    fetch(`${baseUrl}/v1/sessions/${created.session.id}?includeLive=true`, { headers: auth('alice') }),
  ])
  const bodies = await Promise.all(responses.map((r) => r.text()))
  const feedEvents = await collectFeedEvents(`${baseUrl}/v1/workstreams/${created.workstream.id}/feed?after=0`, 'alice', 1, 5_000)
  const combined = [...bodies, JSON.stringify(feedEvents)].join('\n')
  assert.equal(/aoc_[A-Za-z0-9_-]{8,}/.test(combined), false, 'no aoc_ bearer-shaped value')
  assert.equal(combined.toLowerCase().includes('fake-no-broker-execution-grant'), false, 'no raw execution grant ref')
  assert.equal(combined.toLowerCase().includes('fake-test-credential'), false, 'no raw bridge credential')
})

test('required: feed disconnect/reconnect applies each position once', async () => {
  const created = await createWorkstream('alice')

  const seen = await collectFeedEvents(`${baseUrl}/v1/workstreams/${created.workstream.id}/feed?after=0`, 'alice', 2, 15_000)
  assert.ok(seen.length >= 1, 'at least one feed event was streamed')
  const lastSeen = seen[seen.length - 1]!.position

  const seenAfterReconnect = await collectFeedEvents(
    `${baseUrl}/v1/workstreams/${created.workstream.id}/feed?after=${lastSeen}`,
    'alice',
    Number.MAX_SAFE_INTEGER,
    2_000,
  )
  for (const event of seenAfterReconnect) assert.ok(event.position > lastSeen, `reconnect must never redeliver position ${event.position} <= ${lastSeen}`)
})

test('required: a gapped/invalid cursor triggers a reset with refetch', async () => {
  const created = await createWorkstream('alice')
  const [event] = await collectFeedEvents(`${baseUrl}/v1/workstreams/${created.workstream.id}/feed?after=999999`, 'alice', 1, 5_000)
  assert.ok(event, 'expected at least one feed event (the reset)')
  assert.equal(event.operation, 'reset')
  assert.equal(event.payload['reason'], 'retention_gap')
  assert.equal(event.payload['refetch'], true)
})

test('required, P11: a persona the Agent actually reviews is accepted and frozen on the Session', async () => {
  const res = await fetch(`${baseUrl}/v1/workstreams`, {
    method: 'POST',
    headers: { ...auth('alice'), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({
      category: 'discussion',
      agentId: 'fake-agent',
      persona: 'reviewer',
      workspace: { workspaceRef: 'scratch' },
      equipment: { catalogueVersion: 'equipment-v1', resources: [] },
      prompt: [{ type: 'text', text: 'hi' }],
    }),
  })
  assert.equal(res.status, 202)
  const created = (await res.json()) as { session: { id: string } }

  const { rows } = await db.pool.query<{ persona: string | null }>('SELECT persona FROM product.sessions WHERE id = $1', [created.session.id])
  assert.equal(rows[0]?.persona, 'reviewer', 'the persona is durable Session truth, not a transient request field')
})

test('required, P11: a persona the Agent does not review is refused before anything is created', async () => {
  const res = await fetch(`${baseUrl}/v1/workstreams`, {
    method: 'POST',
    headers: { ...auth('alice'), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({
      category: 'discussion',
      agentId: 'fake-agent-b', // reviews no personas at all
      persona: 'reviewer',
      workspace: { workspaceRef: 'scratch' },
      equipment: { catalogueVersion: 'equipment-v1', resources: [] },
      prompt: [{ type: 'text', text: 'hi' }],
    }),
  })
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as { code: string }).code, 'persona_unavailable')

  // "Before anything is created" is the actual claim — assert it rather than trusting the status.
  const { rows } = await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM product.sessions WHERE persona = 'reviewer' AND agent_id = 'fake-agent-b'")
  assert.equal(rows[0]?.n, '0')
})

test('required, P11: model/effort are settable on a live Session, and the Agent\'s own refusal surfaces as a typed error', async () => {
  const created = await createWorkstream('alice')

  // The config options live on the RUNNING session, so wait for the ACP connection rather than
  // assuming it exists the moment the API returned 202.
  // Generous budget on purpose: this polls a fire-and-forget provisioning chain, and the whole
  // suite runs these concurrently against one shared fake controller — 10s was enough in isolation
  // and not under full-suite load. Report the phase actually reached, so a real failure is
  // diagnosable instead of a bare `false`.
  let phase = 'unknown'
  for (let i = 0; i < 60 && phase !== 'ready'; i += 1) {
    const res = await fetch(`${baseUrl}/v1/sessions/${created.session.id}`, { headers: auth('alice') })
    const session = (await res.json()) as { phase: string; failure?: { code: string; detail?: string } | null }
    phase = session.phase
    if (phase === 'failed') {
      phase = `failed: ${session.failure?.code} — ${session.failure?.detail ?? ''}`
      break
    }
    if (phase !== 'ready') await sleep(500)
  }
  assert.equal(phase, 'ready', `Session never reached ready (stuck at '${phase}')`)

  const ok = await fetch(`${baseUrl}/v1/sessions/${created.session.id}/config-options/effort`, {
    method: 'PUT',
    headers: { ...auth('alice'), 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'high' }),
  })
  // Read the body ONCE: `await ok.text()` as an assertion message would consume it before .json().
  const body = (await ok.json()) as { configOptions?: { id: string; currentValue: string }[] }
  assert.equal(ok.status, 200, JSON.stringify(body))
  const effort = body.configOptions?.find((o) => o.id === 'effort')
  assert.equal(effort?.currentValue, 'high', 'the Agent reports the new value back in the FULL option set')

  // The Agent is authoritative on what exists — this server curates no model list, so a bad value
  // must come back as the Agent's refusal, not as a 200 this server invented.
  const refused = await fetch(`${baseUrl}/v1/sessions/${created.session.id}/config-options/effort`, {
    method: 'PUT',
    headers: { ...auth('alice'), 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'not-a-level' }),
  })
  assert.equal(refused.status, 409)
  assert.equal(((await refused.json()) as { code: string }).code, 'config_option_rejected')

  const mode = await fetch(`${baseUrl}/v1/sessions/${created.session.id}/mode`, {
    method: 'PUT',
    headers: { ...auth('alice'), 'content-type': 'application/json' },
    body: JSON.stringify({ modeId: 'plan' }),
  })
  const modeBody = await mode.text()
  assert.equal(mode.status, 200, modeBody)
})

/**
 * Waits for a Session's ACP connection to exist. Same generous budget and same failure reporting as
 * the model/effort test above, for the same reason: provisioning is a fire-and-forget chain and the
 * whole suite runs concurrently against one shared fake controller.
 */
async function waitForReadySession(sessionId: string, principal = 'alice'): Promise<void> {
  let phase = 'unknown'
  for (let i = 0; i < 60 && phase !== 'ready'; i += 1) {
    const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, { headers: auth(principal) })
    const session = (await res.json()) as { phase: string; failure?: { code: string; detail?: string } | null }
    phase = session.phase
    if (phase === 'failed') {
      phase = `failed: ${session.failure?.code} — ${session.failure?.detail ?? ''}`
      break
    }
    if (phase !== 'ready') await sleep(500)
  }
  assert.equal(phase, 'ready', `Session never reached ready (stuck at '${phase}')`)
}

test('GET /v1/agents publishes each Agent\'s reviewed personas', async () => {
  // Both `CreateWorkstreamRequest.persona` and `OpenSessionRequest.persona` document their allowed
  // set as "`personas` on GET /v1/agents", but this response dropped the field, so a client could
  // set a persona and never discover which ones exist. Found while building the persona selector.
  const res = await fetch(`${baseUrl}/v1/agents`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { items: { agentId: string; personas?: readonly string[] }[] }

  const withPersonas = body.items.find((agent) => agent.agentId === 'fake-agent')
  assert.deepEqual(withPersonas?.personas, ['reviewer', 'writer'])

  // An Agent that reviews none must say so with an empty list, not by omitting the field — a client
  // cannot tell "offers nothing" from "this build forgot to tell you" otherwise.
  const withNone = body.items.find((agent) => agent.agentId === 'fake-agent-b')
  assert.deepEqual(withNone?.personas, [])
})

test('the Session resource reports the persona it is actually running as', async () => {
  const res = await fetch(`${baseUrl}/v1/workstreams`, {
    method: 'POST',
    headers: { ...auth('alice'), ...idem(), 'content-type': 'application/json' },
    body: JSON.stringify({
      category: 'discussion',
      agentId: 'fake-agent',
      persona: 'writer',
      workspace: { workspaceRef: 'scratch' },
      equipment: { catalogueVersion: 'equipment-v1', resources: [] },
      prompt: [{ type: 'text', text: 'hi' }],
    }),
  })
  assert.equal(res.status, 202)
  const created = (await res.json()) as { workstream: { id: string }; session: { id: string; persona?: string } }
  // Both on the create response and on a later read: a client that can only set a persona, never
  // read the one in force, would offer to "change" a Workstream to the persona it already uses —
  // which costs a whole new Session.
  assert.equal(created.session.persona, 'writer')

  const reread = await fetch(`${baseUrl}/v1/sessions/${created.session.id}`, { headers: auth('alice') })
  assert.equal(((await reread.json()) as { persona?: string }).persona, 'writer')

  const detail = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}`, { headers: auth('alice') })
  const sessions = ((await detail.json()) as { sessions: { persona?: string }[] }).sessions
  assert.equal(sessions[0]?.persona, 'writer')

  // A Session launched as the harness default carries no persona at all, rather than an empty
  // string the selector would have to special-case.
  const plain = await createWorkstream('alice')
  assert.equal(plain.session.persona, undefined)
})

test('the harness\'s own model/effort options are readable from the Workstream items — the Web UI has no other source', async () => {
  // This is the load-bearing assumption behind the model selector and the effort rail. There is no
  // "read the current session config" route (by design: the harness is authoritative, and this
  // server curates no model list), but the projector folds every ACP frame it does not model
  // first-class into an `unknown` item carrying the whole envelope — and `session/new`'s response is
  // one of those. If that ever stops being true, the selectors go blank, so it is asserted here
  // against a real Postgres, a real projector and a real ACP Agent rather than assumed.
  const created = await createWorkstream('alice')
  await waitForReadySession(created.session.id)

  interface Item {
    readonly kind: string
    readonly latestWorkstreamSeq: number
    readonly value: { readonly envelope?: { readonly result?: { readonly configOptions?: { id: string; currentValue: string; options: { value: string }[] }[] } } }
  }
  const readOptions = async (): Promise<{ id: string; currentValue: string; options: { value: string }[] }[] | undefined> => {
    const res = await fetch(`${baseUrl}/v1/workstreams/${created.workstream.id}/items?limit=200`, { headers: auth('alice') })
    const { items } = (await res.json()) as { items: Item[] }
    let latest: Item | undefined
    for (const item of items) {
      if (item.kind !== 'unknown') continue
      if (!Array.isArray(item.value.envelope?.result?.configOptions)) continue
      if (!latest || item.latestWorkstreamSeq > latest.latestWorkstreamSeq) latest = item
    }
    return latest?.value.envelope?.result?.configOptions
  }

  let advertised = await readOptions()
  for (let i = 0; i < 40 && !advertised; i += 1) {
    await sleep(250)
    advertised = await readOptions()
  }
  assert.ok(advertised, 'session/new advertised config options but no item published them')
  const model = advertised.find((option) => option.id === 'model')
  assert.ok(model, `no model option in ${JSON.stringify(advertised)}`)
  assert.ok(model.options.length > 0, 'a model selector with no values is an empty menu')
  const effort = advertised.find((option) => option.id === 'effort')
  assert.ok(effort, 'no effort option — the rail would have no levels')

  // And the set stays CURRENT rather than merely initial: a config change travels the same journaled
  // connection, so its response lands in the same bucket with a higher sequence.
  const changed = await fetch(`${baseUrl}/v1/sessions/${created.session.id}/config-options/model`, {
    method: 'PUT',
    headers: { ...auth('alice'), 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'opus' }),
  })
  assert.equal(changed.status, 200, await changed.text())

  let refreshed = await readOptions()
  for (let i = 0; i < 40 && refreshed?.find((option) => option.id === 'model')?.currentValue !== 'opus'; i += 1) {
    await sleep(250)
    refreshed = await readOptions()
  }
  assert.equal(
    refreshed?.find((option) => option.id === 'model')?.currentValue,
    'opus',
    'the newest journaled envelope must reflect the change, or the panel shows a stale selection',
  )
})

test('the UI shell is served in full — every file index.html asks for, and nothing else', async () => {
  // The shell outgrew the hard-coded `/` + `/styles.css` pair when the UI was ported, and a stylesheet
  // that 404s is an unstyled page rather than a visible error — so assert each asset the shell
  // actually references, not just that the page loads.
  const page = await fetch(`${baseUrl}/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/)
  const html = await page.text()
  assert.match(html, /<html lang="fr">/, 'the ported UI is French')
  assert.match(html, /id="app"/)

  for (const [reference] of [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((match) => [match[1]!])) {
    const asset = await fetch(`${baseUrl}${reference}`)
    assert.equal(asset.status, 200, `${reference} is referenced by index.html but not served`)
    assert.ok((await asset.text()).length > 0, `${reference} served an empty body`)
  }

  // Serving public/ by extension allow-list must not become a way out of it. Each body is consumed
  // even though it is not asserted on: an unread response holds its keep-alive connection open, and
  // this file's own `after` hook has already been bitten by exactly that.
  for (const hostile of ['/../package.json', '/client/../../package.json', '/server.ts', '/client/app.js.map/../../../package.json']) {
    const res = await fetch(`${baseUrl}${hostile}`)
    await res.text()
    assert.notEqual(res.status, 200, `${hostile} must not be reachable`)
  }
})
