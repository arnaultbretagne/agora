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
  const body = (await res.json()) as { command: { commandId: string }; workstream: { id: string }; session: { id: string } }
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
