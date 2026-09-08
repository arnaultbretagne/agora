import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { openSession } from '@agora/journal'
import type { ObservationSource } from '@agora/engine'
import { createControlPlaneServer, type AdmissionCheckOptions } from '../src/http.js'
import type { PromptRecoveryOptions } from '../src/recovery/context.js'
import { AgentChannels, type ChannelConnector } from '../src/agent-channel.js'
import type { AddressInfo } from 'node:net'

const OWNER = { 'x-forwarded-email': 'owner@example.com' }

interface RunningApi {
  readonly port: number
  readonly channels: AgentChannels
  readonly close: () => Promise<void>
}

async function startApi(
  db: TestDatabase,
  promptDelayMs = 0,
  admission?: AdmissionCheckOptions,
  connector?: ChannelConnector,
  recovery?: PromptRecoveryOptions,
): Promise<RunningApi> {
  const channels = new AgentChannels({ pool: db.pool, nowSql: db.nowSql, promptDelayMs, logger: (message) => console.error(`[channel] ${message}`), ...(connector ? { connector } : {}) })
  const server = createControlPlaneServer({
    productPool: db.pool,
    enginePool: db.pool,
    channels,
    nowSql: db.nowSql,
    ...(admission ? { admission } : {}),
    ...(recovery ? { recovery } : {}),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    channels,
    close: async () => {
      await channels.closeAll()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function fakeObservationSource(admitted: boolean): ObservationSource {
  const ok = <T>(value: T) => ({ ok: true as const, value })
  return {
    reader: async () => ({
      power: () => ok('on' as const),
      construction: () => ok({ kind: 'set' as const, digests: new Set(['digest-a']), incoherent: false }),
      session: () => ok(admitted ? ('live' as const) : ('openable' as const)),
      anchor: () => ok('none' as const),
      sync: () => ok('current' as const),
      model: () => ok('model-a'),
      effort: () => ok('default'),
      grantsAttached: () => ok(new Set()),
      grantsEffective: () => ok(new Set()),
    }),
  }
}

const RESOLVE = { harnessDigest: () => 'digest-a', capabilityGrants: () => new Set<never>() }

function onIntent(): Record<string, unknown> {
  return { power: 'on', harness: 'claude-code', capabilities: ['workspace.read'], model: 'model-a', effort: 'default', persona: 'default' }
}

function request(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function createWorkstreamWithSession(db: TestDatabase, port: number): Promise<string> {
  const created = await request(port, '/v1/workstreams', { ...OWNER, 'idempotency-key': crypto.randomUUID() }, 'POST', { title: 'conversation' })
  const workstream = (await created.json()) as { id: string }
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    await openSession(client, workstream.id, { podUid: 'pod-1', provenance: {} }, { nowSql: db.nowSql })
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  return workstream.id
}

async function dispatchState(db: TestDatabase, commandId: string): Promise<string> {
  const row = (await db.pool.query('SELECT state FROM command_dispatches WHERE id = $1', [commandId])).rows[0]!
  return row['state'] as string
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = false
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`condition never became true (last=${String(last)})`)
}

test('prompt: reserved then sent, permission decided, message projected; a second prompt mid-turn is 409', async () => {
  await withTestDatabase(async (db) => {
    const api = await startApi(db, 150)
    try {
      const workstreamId = await createWorkstreamWithSession(db, api.port)
      const first = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'p1' }, 'POST', { text: 'bonjour' })
      assert.equal(first.status, 202)
      const { commandId } = (await first.json()) as { commandId: string }
      await waitFor(() => dispatchState(db, commandId).then((state) => state === 'dispatched'))

      const second = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'p2' }, 'POST', { text: 'pendant le tour' })
      assert.equal(second.status, 409)
      const problem = (await second.json()) as { detail: string }
      assert.ok(problem.detail.length > 0)

      // The fake agent asks one permission per turn; the operator allows it.
      await waitFor(() => Promise.resolve(api.channels.pendingPermissionIds(workstreamId).length > 0))
      const permissionId = api.channels.pendingPermissionIds(workstreamId)[0]!

      // S12 Step 4: the pending list carries the agent's OWN options, so a client answers with one
      // of them rather than a string it made up.
      const pending = (await (await request(api.port, `/v1/workstreams/${workstreamId}/permissions/pending`, { ...OWNER })).json()) as {
        pending: Array<{ permissionId: string; toolCallId: string | null; title: string; options: Array<{ optionId: string; name: string }> }>
      }
      assert.deepEqual(pending.pending.map((entry) => entry.permissionId), [permissionId])
      assert.equal(pending.pending[0]?.title, 'Read a file')
      assert.equal(pending.pending[0]?.toolCallId, 'tool-1', 'the tool-call id is what ties this to the projected permission item')
      assert.deepEqual(pending.pending[0]?.options, [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }])

      // An option the agent never offered is refused here rather than sent as an answer to a closed
      // question — and the request stays pending, so the real decision is still possible.
      const invented = await request(api.port, `/v1/workstreams/${workstreamId}/permissions/${permissionId}/decision`, { ...OWNER }, 'POST', { optionId: 'allow_always' })
      assert.equal(invented.status, 422)
      assert.equal(api.channels.pendingPermissionIds(workstreamId).length, 1)

      const decision = await request(api.port, `/v1/workstreams/${workstreamId}/permissions/${permissionId}/decision`, { ...OWNER }, 'POST', { optionId: 'allow' })
      assert.equal(decision.status, 200)

      // And the decision is readable as an OUTCOME, not as a click: the projected permission item
      // carries what the response frame actually said (what the S12 UI reads back).
      await waitFor(async () => {
        const items = (await (await request(api.port, `/v1/workstreams/${workstreamId}/items`, { ...OWNER })).json()) as {
          items: Array<{ kind: string; entityKey: string; value: Record<string, unknown> }>
        }
        const permission = items.items.find((entry) => entry.kind === 'permission')
        return permission?.value['status'] === 'decided' && permission.entityKey === 'tool-1'
      })

      await waitFor(() => dispatchState(db, commandId).then((state) => state === 'responded'))

      const replay = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'p1' }, 'POST', { text: 'bonjour' })
      assert.equal(replay.status, 200)
      assert.equal(((await replay.json()) as { commandId: string }).commandId, commandId)

      await waitFor(async () => (await (await request(api.port, `/v1/workstreams/${workstreamId}/items`, { ...OWNER })).json() as { items: Array<{ kind: string }> }).items.some((item) => item.kind === 'message'))
      const items = (await (await request(api.port, `/v1/workstreams/${workstreamId}/items`, { ...OWNER })).json()) as { items: Array<{ kind: string; value: Record<string, unknown> }> }
      // BOTH halves, in the order they were said. The operator's own message is projected from the
      // outbound `session/prompt` — before this it was in no projection at all, and the browser drew
      // it from a local echo that rendered after the answer and vanished on reload.
      const messages = items.items.filter((item) => item.kind === 'message')
      const said = (item: { value: Record<string, unknown> } | undefined): string =>
        ((item?.value['content'] as Array<{ text?: string }> | undefined) ?? []).map((block) => block.text ?? '').join('')
      assert.deepEqual(messages.map((item) => item.value['role']), ['user', 'agent'])
      assert.equal(said(messages[0]), 'bonjour', 'the question, as it was asked')
      const message = messages[1]
      const content = message?.value['content'] as Array<{ type: string; text?: string }>
      assert.equal(content.map((block) => block.text ?? '').join(''), 'hello from the fake agent')

      const feedController = new AbortController()
      const feedResponse = await fetch(`http://127.0.0.1:${api.port}/v1/workstreams/${workstreamId}/feed?after=0`, {
        headers: { ...OWNER },
        signal: feedController.signal,
      })
      assert.equal(feedResponse.headers.get('content-type'), 'text/event-stream')
      const reader = feedResponse.body!.getReader()
      const chunk = await reader.read()
      assert.ok(new TextDecoder().decode(chunk.value ?? new Uint8Array()).length >= 0)
      let sawData = false
      for (let reads = 0; reads < 10 && !sawData; reads += 1) {
        const next = await reader.read()
        if (next.value !== undefined && new TextDecoder().decode(next.value).includes('data: ')) sawData = true
        if (next.done) break
      }
      assert.ok(sawData, 'the feed streams SSE frames')
      feedController.abort()
    } finally {
      await api.close()
    }
  })
})

test('CONT-005 (prompt): a lost connection mid-turn leaves unknown and refuses a new prompt', async () => {
  await withTestDatabase(async (db) => {
    const api = await startApi(db, 60_000)
    try {
      const workstreamId = await createWorkstreamWithSession(db, api.port)
      const first = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'lost' }, 'POST', { text: 'perdu' })
      assert.equal(first.status, 202)
      const { commandId } = (await first.json()) as { commandId: string }
      await waitFor(() => dispatchState(db, commandId).then((state) => state === 'dispatched'))

      // The channel dies mid-turn: the response never arrives.
      await api.channels.close(workstreamId)
      await waitFor(() => dispatchState(db, commandId).then((state) => state === 'unknown'))

      const next = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'after-loss' }, 'POST', { text: 'après la perte' })
      assert.equal(next.status, 409)
      const problem = (await next.json()) as { title: string }
      assert.match(problem.title, /unknown/)
    } finally {
      await api.close()
    }
  })
})

test('a prompt without a current Session is refused with a visible problem', async () => {
  await withTestDatabase(async (db) => {
    const api = await startApi(db)
    try {
      const created = await request(api.port, '/v1/workstreams', { ...OWNER, 'idempotency-key': 'ws' }, 'POST', { title: 'sans session' })
      const { id } = (await created.json()) as { id: string }
      const response = await request(api.port, `/v1/workstreams/${id}/prompt`, { ...OWNER, 'idempotency-key': 'p1' }, 'POST', { text: 'x' })
      assert.equal(response.status, 409)
      const problem = (await response.json()) as { title: string; detail: string }
      assert.match(problem.title, /Session/)
      assert.ok(problem.detail.length > 0)
    } finally {
      await api.close()
    }
  })
})

test('S8 Step 4: a prompt is refused with no current Intent, admission wired', async () => {
  await withTestDatabase(async (db) => {
    const api = await startApi(db, 0, { observationSource: fakeObservationSource(true), resolve: RESOLVE })
    try {
      const workstreamId = await createWorkstreamWithSession(db, api.port)
      const response = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'p1' }, 'POST', { text: 'x' })
      assert.equal(response.status, 409)
      const problem = (await response.json()) as { title: string }
      assert.match(problem.title, /Intent/)
    } finally {
      await api.close()
    }
  })
})

test('S8 Step 4: a prompt is refused when fresh evaluation has not converged (admission not granted)', async () => {
  await withTestDatabase(async (db) => {
    const api = await startApi(db, 0, { observationSource: fakeObservationSource(false), resolve: RESOLVE })
    try {
      const workstreamId = await createWorkstreamWithSession(db, api.port)
      const putIntent = await request(api.port, `/v1/workstreams/${workstreamId}/intent`, { ...OWNER, 'idempotency-key': 'intent-1' }, 'PUT', onIntent())
      assert.ok(putIntent.status === 200 || putIntent.status === 201, `PUT intent failed: ${putIntent.status} ${await putIntent.text()}`)
      const response = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'p1' }, 'POST', { text: 'x' })
      assert.equal(response.status, 409)
      const problem = (await response.json()) as { title: string; detail: string }
      assert.match(problem.title, /Admission/)
      assert.match(problem.detail, /SESSION-00[23]/)
    } finally {
      await api.close()
    }
  })
})

test('S8 Step 4: a prompt is accepted once fresh evaluation converges (admission granted)', async () => {
  await withTestDatabase(async (db) => {
    const api = await startApi(db, 0, { observationSource: fakeObservationSource(true), resolve: RESOLVE })
    try {
      const workstreamId = await createWorkstreamWithSession(db, api.port)
      const putIntent = await request(api.port, `/v1/workstreams/${workstreamId}/intent`, { ...OWNER, 'idempotency-key': 'intent-1' }, 'PUT', onIntent())
      assert.ok(putIntent.status === 200 || putIntent.status === 201, `PUT intent failed: ${putIntent.status} ${await putIntent.text()}`)
      const response = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'p1' }, 'POST', { text: 'x' })
      assert.equal(response.status, 202)
    } finally {
      await api.close()
    }
  })
})

test('S8 Step 4b/5 prerequisite: an unreachable real bridge answers 503 and settles the dispatch as never-sent, not stuck reserved', async () => {
  await withTestDatabase(async (db) => {
    const { RealChannelConnector } = await import('../src/real-channel-connector.js')
    // No bridge token bound at all (START never ran) — RealChannelConnector refuses to connect.
    const connector = new RealChannelConnector({ productPool: db.pool, runtimeControlBaseUrl: 'http://127.0.0.1:1', bridgePort: 8765 })
    const api = await startApi(db, 0, { observationSource: fakeObservationSource(true), resolve: RESOLVE }, connector)
    try {
      const workstreamId = await createWorkstreamWithSession(db, api.port)
      const putIntent = await request(api.port, `/v1/workstreams/${workstreamId}/intent`, { ...OWNER, 'idempotency-key': 'intent-1' }, 'PUT', onIntent())
      assert.ok(putIntent.status === 200 || putIntent.status === 201)
      const response = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'p1' }, 'POST', { text: 'x' })
      assert.equal(response.status, 503)
      const problem = (await response.json()) as { title: string }
      assert.match(problem.title, /Harness bridge/)
      const dispatch = await db.pool.query('SELECT state FROM command_dispatches WHERE workstream_id = $1', [workstreamId])
      assert.equal(dispatch.rowCount, 1, 'the reservation still happened — this is a committed dispatch, not a silently dropped one')
      // `rejected_before_acceptance`, not `unknown`: nothing reached the harness, which is exactly
      // what "provably never sent" means. `unknown` was the earlier choice and it cost something
      // real — it ALSO gates the next prompt on CONT-005 recovery, for a turn that demonstrably
      // never left this process. What matters either way is that it is never left `reserved`, which
      // the one-turn gate reads as a turn in flight for ever.
      assert.equal(dispatch.rows[0]!['state'], 'rejected_before_acceptance', 'never left stuck in reserved forever')
    } finally {
      await api.close()
    }
  })
})

test('S8 Step 5: the CONT-005 gate lifts once recovery proves the ambiguous prompt was delivered', async () => {
  await withTestDatabase(async (db) => {
    const { bindAcpContext, recordBridgeToken } = await import('@agora/journal')
    const acp = await import('@agentclientprotocol/sdk')
    const { markDispatched, markUnknown, reserveDispatch } = await import('@agora/acp')

    // A fake harness whose session/load replays the lost prompt — the measured real shape.
    const aToB = new TransformStream<Uint8Array, Uint8Array>()
    const bToA = new TransformStream<Uint8Array, Uint8Array>()
    const agentApp = acp.agent({ name: 'replaying-fake-agent' })
    agentApp.onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
    agentApp.onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      const sessionId = (params as { sessionId: string }).sessionId
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'perdu en vol' } },
      })
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'répondu quand même' } },
      })
      return {}
    })
    const agentConnection = agentApp.connect(acp.ndJsonStream(bToA.writable, aToB.readable))

    const runtimeControl = createServer((req, res) => {
      const url = req.url ?? ''
      if (url.startsWith('/v1/workstreams/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ pods: [{ name: 'pod-1', forcedDeletion: false, podIP: '10.0.0.5' }], obligations: [], complete: true }))
        return
      }
      if (url.endsWith('/evidence')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ processGeneration: 0 }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => runtimeControl.listen(0, '127.0.0.1', resolve))
    const rcPort = (runtimeControl.address() as AddressInfo).port

    const recovery: PromptRecoveryOptions = {
      productPool: db.pool,
      runtimeControlBaseUrl: `http://127.0.0.1:${rcPort}`,
      bridgePort: 8765,
      connect: async () => ({
        connectionId: 'c1',
        stream: { writable: aToB.writable, readable: bToA.readable },
        close: async () => agentConnection.close?.(),
        closed: Promise.resolve(),
      }),
    }

    const api = await startApi(db, 0, { observationSource: fakeObservationSource(true), resolve: RESOLVE }, undefined, recovery)
    try {
      const workstreamId = await createWorkstreamWithSession(db, api.port)
      const putIntent = await request(api.port, `/v1/workstreams/${workstreamId}/intent`, { ...OWNER, 'idempotency-key': 'intent-1' }, 'PUT', onIntent())
      assert.ok(putIntent.status === 200 || putIntent.status === 201)

      // Bind the context and leave one prompt ambiguous — the CONT-005 gate.
      const client = await db.pool.connect()
      let lostId: string
      try {
        const sessionRow = await db.pool.query('SELECT id FROM sessions WHERE workstream_id = $1', [workstreamId])
        const sessionId = sessionRow.rows[0]!['id'] as string
        await client.query('BEGIN')
        await recordBridgeToken(client, sessionId, 'bridge-token-1')
        await bindAcpContext(client, sessionId, { contextId: 'ctx-1', processGeneration: 0 })
        await client.query('COMMIT')
        await client.query('BEGIN')
        const lost = await reserveDispatch(client, { workstreamId, sessionId, kind: 'prompt', request: { text: 'perdu en vol' }, requestKey: 'lost-1' })
        await markDispatched(client, lost.id)
        await markUnknown(client, lost.id)
        await client.query('COMMIT')
        lostId = lost.id
      } finally {
        client.release()
      }

      const accepted = await request(api.port, `/v1/workstreams/${workstreamId}/prompt`, { ...OWNER, 'idempotency-key': 'after-recovery' }, 'POST', { text: 'la suite' })
      assert.equal(accepted.status, 202, 'recovery resolved the ambiguity, so the next turn is admitted')
      assert.equal(await dispatchState(db, lostId), 'responded', 'the lost prompt is settled by evidence, not re-sent')
    } finally {
      runtimeControl.close()
      await api.close()
    }
  })
})
