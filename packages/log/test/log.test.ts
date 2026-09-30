import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, describe, it } from 'node:test'
import { Pool } from 'pg'
import { WebSocket } from 'ws'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, expect } from '@playwright/test'
import { logHttp } from '../src/http.ts'
import { readFile } from 'node:fs/promises'
import { LogStore, type Command, type Entry, Transaction } from '../src/store.ts'
import { LogDriver, claimName } from '../src/driver.ts'
import { Projections, ThreadClient, core } from '../src/projection.ts'
import { fold, project, runtimeState } from '../src/state.ts'
import { encode, decode, hash, identity, object } from '../src/json.ts'
import { validate, MAX_LINE } from '../src/acp.ts'
import { telemetry } from '../src/telemetry.ts'
import { FakeKube } from '../../executions/test/fake-kube.ts'
import { keys } from '@agora/testkit'

const store = new LogStore({
  writer: process.env.LOG_TEST_WRITER_URL!,
  projector: process.env.LOG_TEST_PROJECTOR_URL!,
  anchors: process.env.LOG_TEST_ANCHORS_URL!,
})
const migration = new Pool({ connectionString: process.env.LOG_TEST_MIGRATION_URL! })
const projections = new Projections(store)
const cleanups: (() => Promise<void>)[] = []
after(async () => {
  for (const f of cleanups.reverse()) await f()
  await store.close()
  await migration.end()
})
async function stream() {
  const workstream = randomUUID()
  await store.create(workstream, randomUUID())
  return workstream
}
async function seed() {
  const workstream = await stream(),
    execution = randomUUID(),
    session = randomUUID(),
    connection = randomUUID()
  await store.accept(
    workstream,
    {
      id: randomUUID(),
      kind: 'Create',
      target: {},
      body: {
        execution,
        pool: 'mock-test',
        deadline: new Date(Date.now() + 60000).toISOString(),
        limits: { leaseSeconds: 60, turnCapSeconds: 60 },
      },
    },
    async () => ({ execution, claimName: claimName(execution) }),
  )
  await store.fact(workstream, { kind: 'session.opened', execution, session, content: { acpId: 'acp-session' } })
  await store.writer.query(
    'INSERT INTO sessions(id,workstream,execution,acp_id,opened_position) VALUES($1,$2,$3,$4,$5)',
    [session, workstream, execution, 'acp-session', '2'],
  )
  return { workstream, execution, session, connection }
}
async function prompt(s: Awaited<ReturnType<typeof seed>>, id = randomUUID()) {
  return store.accept(
    s.workstream,
    { id, kind: 'Write', target: { session: s.session }, body: { prompt: [{ type: 'text', text: 'hello' }] } },
    async (state) =>
      state.active
        ? 'turn_active'
        : {
            execution: s.execution,
            session: s.session,
            line: {
              method: 'session/prompt',
              params: { sessionId: 'acp-session', prompt: [{ type: 'text', text: 'hello' }] },
            },
          },
  )
}
async function marker(s: Awaited<ReturnType<typeof seed>>, position: string) {
  await store.fact(s.workstream, {
    kind: 'acp.dispatching',
    execution: s.execution,
    session: s.session,
    content: { requestPosition: position, connection: s.connection },
  })
}
async function until<T>(run: () => Promise<T | false | null | undefined>, ms = 10000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await run()
    if (value !== false && value !== null && value !== undefined) return value
    if (Date.now() > end) throw new Error('test_timeout')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
const rpc = (v: Record<string, unknown>) => encode({ jsonrpc: '2.0', ...v })

// Keep earlier synthetic histories terminal before the integration driver's next recovery scan.
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const { id } of (await store.writer.query('SELECT id FROM workstreams')).rows) {
    const state = await store.state(id)
    for (const execution of state.executions.values())
      if (!execution.ended && !execution.lost)
        await store.fact(id, {
          kind: 'execution.ended',
          execution: execution.id,
          content: { reason: 'deadline_reached' },
        })
  }
})

describe('log / PostgreSQL 17 restricted runtime logins', () => {
  it('L16: captured real Claude transcript agrees with incremental projection and rebuild', async () => {
    const fixture = decode(await readFile(new URL('fixtures/claude-code.json', import.meta.url), 'utf8')) as {
      harness: string; workstream: string; entries: Entry[]; projectionHash: string; image: string
    }
    assert.equal(fixture.harness, 'claude-code')
    assert.match(fixture.image, /^ghcr\.io\/arnaultbretagne\/agora-harness-claude-code@sha256:/)
    assert.ok(fixture.entries.some((e) => object(object(e.content.params)?.update)?.sessionUpdate === 'tool_call'))
    const recorded = core.fold(fixture.entries).sort((a, b) => a.id.localeCompare(b.id))
    assert.equal(hash(recorded), fixture.projectionHash)
    await store.create(fixture.workstream, randomUUID())
    // Fixture setup alone uses the administrator, to preserve the original database timestamps.
    // Every projection below runs through the actual restricted projector login.
    const source = await migration.connect()
    try {
      for (const e of fixture.entries) {
        await source.query('BEGIN')
        await source.query(
          `INSERT INTO entries(workstream,position,time,kind,execution,session,content,direction,rpc_kind,method,correlated_method,request_position,rpc_id,command,connection,receive_ordinal)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`,
          [e.workstream, e.position, e.time, e.kind, e.execution, e.session, encode(e.content), e.direction,
            e.rpc_kind, e.method, e.correlated_method, e.request_position, e.rpc_id === null ? null : encode(e.rpc_id), e.command, e.connection, e.receive_ordinal],
        )
        await source.query('UPDATE workstreams SET last_position=$2 WHERE id=$1', [e.workstream, e.position])
        await source.query('COMMIT')
        await projections.run(fixture.workstream)
      }
    } catch (error) {
      await source.query('ROLLBACK')
      throw error
    } finally { source.release() }
    const incremental = await projections.objects(fixture.workstream)
    assert.equal(hash(incremental), fixture.projectionHash)
    await projections.run(fixture.workstream, core, true)
    const rebuilt = await projections.objects(fixture.workstream)
    assert.deepEqual(rebuilt.map((o) => o.id), incremental.map((o) => o.id))
    assert.equal(hash(rebuilt), fixture.projectionHash)
  })
  it('L1-L2-L23: raw semantic fidelity, distinct occurrences and uncertain commit retry', async () => {
    const s = await seed()
    const raw =
      '{"jsonrpc":"2.0","method":"extension/example","params":{"integer":9007199254740993,"decimal":1.234567890123456789,"array":[3,1,2],"unknown":true}}'
    const first = await store.incoming(s.workstream, s.execution, s.connection, '1', raw)
    assert.deepEqual(await store.incoming(s.workstream, s.execution, s.connection, '1', raw), first)
    await store.incoming(s.workstream, s.execution, s.connection, '2', raw)
    const rows = await store.writer.query(
      "SELECT content::text FROM entries WHERE workstream=$1 AND kind='acp' ORDER BY position",
      [s.workstream],
    )
    assert.equal(rows.rowCount, 2)
    assert.match(rows.rows[0].content, /9007199254740993/)
    assert.match(rows.rows[0].content, /1.234567890123456789/)
    assert.equal(hash(decode(rows.rows[0].content)), hash(decode(raw)))
  })
  it('L3-L20: per-method direction and body validation, extensions and unsupported JSON', () => {
    const samples: [string, 'in' | 'out', string][] = [
      ['[]', 'in', 'batch'],
      [rpc({ id: 9007199254740992, result: {} }), 'in', 'unsafe_id'],
      [rpc({ method: 'session/cancel', params: { sessionId: 's' } }), 'in', 'wrong_direction'],
      [
        rpc({
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: 12 } },
        }),
        'in',
        'invalid_body',
      ],
      ['{"jsonrpc":"2.0","method":"x","params":{"a":1,"a":2}}', 'in', 'unsupported_json_value'],
      [rpc({ method: 'x', params: { nullByte: '\0' } }), 'in', 'unsupported_json_value'],
      ['{"jsonrpc":"2.0","method":"x","params":{"big":1e200000}}', 'in', 'unsupported_json_value'],
    ]
    for (const [text, direction, reason] of samples) {
      const result = validate(text, direction)
      assert.deepEqual(result, { ok: false, reason, ...(reason === 'unsafe_id' ? {} : {}) })
    }
    assert.equal(validate(new Uint8Array([0xff]), 'in').ok, false)
    assert.deepEqual(validate(' '.repeat(MAX_LINE + 1), 'in'), { ok: false, reason: 'line_too_large' })
    for (const [method, params, requestDirection, result] of [
      ['initialize', { protocolVersion: 1 }, 'out', { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }],
      ['session/prompt', { sessionId: 's', prompt: [] }, 'out', { stopReason: 'end_turn' }],
      [
        'session/request_permission',
        { sessionId: 's', toolCall: { toolCallId: 't', title: 'x', status: 'pending' }, options: [] },
        'in',
        { outcome: { outcome: 'cancelled' } },
      ],
    ] as const) {
      assert.equal(validate(rpc({ id: 'r', method, params }), requestDirection).ok, true)
      const reverse = requestDirection === 'in' ? 'out' : 'in'
      assert.equal(validate(rpc({ id: 'r', method, params }), reverse).ok, false)
      assert.equal(validate(rpc({ id: 'r', result }), reverse, { method, direction: requestDirection }).ok, true)
      assert.equal(
        validate(rpc({ id: 'r', error: { code: -1, message: 'failure' } }), reverse, {
          method,
          direction: requestDirection,
        }).ok,
        true,
      )
      assert.equal(
        validate(rpc({ id: 'r', result }), requestDirection, { method, direction: requestDirection }).ok,
        false,
      )
    }
  })
  it('L4-L8-L10: invalid reply is ordered uncertainty, survives rebuild, later valid answer resolves', async () => {
    const s = await seed(),
      answer = await prompt(s)
    assert.equal(answer.accepted, true)
    if (!answer.accepted) throw new Error('refused')
    const request = (await store.entries(s.workstream)).at(-1)!
    await marker(s, request.position)
    const result = await store.incoming(
      s.workstream,
      s.execution,
      s.connection,
      '1',
      rpc({ id: answer.requestId, result: { stopReason: 'invented' } }),
    )
    assert.equal(result.handled, false)
    assert.equal((await store.state(s.workstream)).active?.status, 'uncertain')
    assert.equal((await prompt(s)).accepted, false)
    const failures = await store.writer.query('SELECT reason,size,sha256 FROM diagnostics WHERE workstream=$1', [
      s.workstream,
    ])
    assert.equal(failures.rowCount, 1)
    assert.equal((await store.entries(s.workstream)).filter((e) => e.kind === 'request.failed').length, 1)
    await projections.run(s.workstream)
    const before = hash(await projections.objects(s.workstream))
    await projections.run(s.workstream, core, true)
    assert.equal(hash(await projections.objects(s.workstream)), before)
    const ui = runtimeState(await projections.objects(s.workstream))
    assert.equal(ui.isSendDisabled, true)
    assert.equal(ui.isRunning, false)
    assert.ok(ui.cancelTurn)
    await store.incoming(
      s.workstream,
      s.execution,
      s.connection,
      '2',
      rpc({ id: answer.requestId, result: { stopReason: 'end_turn' } }),
    )
    assert.equal((await store.state(s.workstream)).active, null)
    assert.equal((await prompt(s)).accepted, true)
  })
  it('L5: unknown methods and update types become generic objects; tool patches retain fields', async () => {
    const s = await seed()
    const updates = [
      { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Edit file', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' },
      { sessionUpdate: 'future_update', payload: { value: 1 } },
    ]
    for (const [i, update] of updates.entries())
      assert.equal(
        (
          await store.incoming(
            s.workstream,
            s.execution,
            s.connection,
            String(i + 1),
            rpc({ method: 'session/update', params: { sessionId: 'acp-session', update } }),
          )
        ).handled,
        true,
      )
    await store.incoming(
      s.workstream,
      s.execution,
      s.connection,
      '4',
      rpc({ method: 'extension/custom', params: { a: 'b' } }),
    )
    const elements = project(await store.entries(s.workstream)).filter((o) => o.kind === 'element')
    assert.equal(elements.find((o) => o.object.type === 'tool')?.object.title, 'Edit file')
    assert.equal(elements.filter((o) => o.object.type === 'acp').length, 2)
  })
  it('L9-L25: atomic command dedup and concurrent turn admission', async () => {
    const s = await seed(),
      id = randomUUID()
    const answers = await Promise.all([prompt(s, id), prompt(s, id)])
    assert.deepEqual(answers[0], answers[1])
    assert.equal(answers[0]?.accepted, true)
    const conflict = await store.accept(
      s.workstream,
      { id, kind: 'Write', target: { session: s.session }, body: { prompt: [] } },
      async () => {
        throw new Error('must_not_run')
      },
    )
    assert.deepEqual(conflict, { accepted: false, reason: 'command_conflict' })
    const other = await Promise.all([prompt(s), prompt(s)])
    assert.equal(other.filter((a) => a.accepted).length, 0)
    const fresh = await seed()
    const concurrent = await Promise.all([prompt(fresh), prompt(fresh)])
    assert.equal(concurrent.filter((a) => a.accepted).length, 1)
  })
  it('L12-L13: restore creates a new Session; configuration exchanges retain it', async () => {
    const s = await seed()
    const request = await store.transaction(s.workstream, (tx) =>
      tx.outgoing(s.execution, {
        method: 'session/resume',
        params: { sessionId: 'acp-session', cwd: '/work', mcpServers: [] },
      }),
    )
    await store.incoming(s.workstream, s.execution, s.connection, '1', rpc({ id: request.id, result: {} }))
    const state = await store.state(s.workstream)
    assert.notEqual(state.current?.session, s.session)
    assert.equal(state.current?.acpId, 'acp-session')
    const newSession = state.current!.session!
    const config = await store.transaction(s.workstream, (tx) =>
      tx.outgoing(
        s.execution,
        { method: 'session/set_config_option', params: { sessionId: 'acp-session', configId: 'model', value: 'x' } },
        newSession,
      ),
    )
    assert.equal(
      (
        await store.incoming(
          s.workstream,
          s.execution,
          s.connection,
          '2',
          rpc({ id: config.id, result: { configOptions: [] } }),
        )
      ).handled,
      true,
    )
    assert.equal((await store.state(s.workstream)).current?.session, newSession)
    assert.ok(
      (await store.writer.query('SELECT ended_position FROM sessions WHERE id=$1', [s.session])).rows[0].ended_position,
    )
  })
  it('L17: version rebuild removes stale objects and resets with other projectors intact', async () => {
    const s = await seed()
    await projections.run(s.workstream)
    const extra = {
      kind: 'notice' as const,
      id: identity(s.workstream, 'extra'),
      object: { text: 'other projector' },
      first_position: '1',
      last_position: '1',
    }
    await projections.run(s.workstream, { name: 'other', version: '1', fold: () => [extra] })
    const before = await projections.run(s.workstream)
    await projections.run(s.workstream, { ...core, version: '2', fold: () => [] })
    const rows = await projections.objects(s.workstream)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, extra.id)
    const snapshot = await projections.snapshot(s.workstream, before)
    assert.equal(snapshot.rows[0]?.operation, 'reset')
    assert.equal(snapshot.rows[1]?.id, extra.id)
  })
  it('L18-L26: consistent snapshot, partial replay, live tail and lossless large cursors', async () => {
    const s = await seed()
    await migration.query('UPDATE workstreams SET last_thread_position=$2 WHERE id=$1', [
      s.workstream,
      '9007199254740993',
    ])
    await projections.run(s.workstream)
    const snap = await projections.snapshot(s.workstream, '0')
    assert.ok(BigInt(snap.end) > 9007199254740993n)
    const client = new ThreadClient()
    for (const row of snap.rows.slice(0, 1)) client.apply(row)
    assert.equal(client.cursor, '0')
    for (const row of (await projections.snapshot(s.workstream, client.cursor)).rows) client.apply(row)
    client.snapshotEnd(snap.end)
    await prompt(s)
    await projections.run(s.workstream)
    for (const row of await projections.tail(s.workstream, client.cursor)) client.live(row)
    assert.equal(client.objects.size, (await projections.objects(s.workstream)).length)
    await assert.rejects(projections.snapshot(s.workstream, '-1'))
    await assert.rejects(projections.snapshot(s.workstream, '9223372036854775807'))
  })
  it('L19-L29: actual SQL boundaries, unpublished anchor recovery and immutable history', async () => {
    const s = await seed(),
      anchor = randomUUID()
    await store.anchors.query(
      'INSERT INTO anchors(id,workstream,execution,session,metadata,content) VALUES($1,$2,$3,$4,$5,$6)',
      [anchor, s.workstream, s.execution, s.session, '{"harness":"mock"}', Buffer.from('OPAQUE_SECRET')],
    )
    await store.publishAnchors(s.workstream)
    await store.publishAnchors(s.workstream)
    assert.equal((await store.entries(s.workstream)).filter((e) => e.kind === 'anchor.received').length, 1)
    await projections.run(s.workstream)
    for (const [pool, sql] of [
      [store.writer, 'SELECT content FROM anchors'],
      [store.projector, 'SELECT content FROM anchors'],
      [store.writer, "UPDATE entries SET content='{}'"],
      [store.writer, 'DELETE FROM commands'],
      [
        store.projector,
        "INSERT INTO entries(workstream,position,kind,content) VALUES(gen_random_uuid(),1,'command','{}')",
      ],
      [store.anchors, 'SELECT content FROM entries'],
      [store.anchors, "UPDATE anchors SET content='x'"],
      [store.projector, 'DELETE FROM thread'],
      [store.writer, "UPDATE sessions SET acp_id='modified'"],
    ] as const)
      await assert.rejects(pool.query(sql), (error: { code?: string }) => error.code === '42501')
    const roles = await migration.query(
      "SELECT rolname,rolcanlogin,rolsuper FROM pg_roles WHERE rolname IN ('agora_writer','agora_projector','agora_anchors')",
    )
    assert.equal(roles.rowCount, 3)
    assert.ok(roles.rows.every((r) => !r.rolcanlogin && !r.rolsuper))
  })
  it('L21: absence of dispatch permits a first attempt; markers and predispatch failure remain distinct', async () => {
    const s = await seed()
    await prompt(s)
    const request = (await store.entries(s.workstream)).at(-1)!
    assert.equal((await store.state(s.workstream)).active?.status, 'saved')
    await marker(s, request.position)
    await store.fact(s.workstream, {
      kind: 'execution.break',
      execution: s.execution,
      content: { connection: s.connection, clean: false, reason: 'transport_error' },
    })
    assert.equal((await store.state(s.workstream)).active?.status, 'uncertain')
    const fresh = await seed()
    await prompt(fresh)
    const saved = (await store.entries(fresh.workstream)).at(-1)!
    await store.fact(fresh.workstream, {
      kind: 'request.failed',
      execution: fresh.execution,
      content: { requestPosition: saved.position, reason: 'deadline_refused' },
    })
    assert.equal([...(await store.state(fresh.workstream)).turns.values()][0]?.status, 'failed')
  })
  it('L27: allow-list logger excludes secrets in keys, correlations and exceptions', () => {
    const secret = 'PROMPT_TOKEN_TOOL_ANCHOR_HEADER_QUERY_SECRET',
      lines: string[] = []
    telemetry(
      {
        operation: 'capture',
        outcome: 'failed',
        workstream: randomUUID(),
        position: '9007199254740993',
        errorClass: new Error(secret),
        prompt: secret,
        tool: secret,
        token: secret,
        headers: secret,
        query: secret,
        bytes: secret,
        execution: secret,
        connection: secret,
        command: secret,
      },
      (line) => lines.push(line),
    )
    telemetry({ operation: secret, outcome: secret, errorClass: secret }, (line) => lines.push(line))
    assert.ok(lines.every((line) => !line.includes(secret)))
    assert.deepEqual(Object.keys(JSON.parse(lines[0]!)).sort(), ['operation', 'outcome', 'position', 'workstream'])
    assert.equal(lines[1], '{}')
  })
})

describe('durable dispatcher / real bridge + mock agent', () => {
  async function lab() {
    const { privateKey, publicKey } = keys(),
      kube = new FakeKube(publicKey)
    const driver = new LogDriver({
      store,
      kube,
      signingKey: privateKey,
      address: kube.address,
      tickMs: 50,
      shutdownMs: 1000,
    })
    await driver.start()
    cleanups.push(() => kube.closeAll())
    cleanups.push(() => driver.stop())
    const workstream = await stream(),
      execution = randomUUID()
    const command: Command = {
      id: randomUUID(),
      kind: 'Create',
      target: {},
      body: {
        execution,
        pool: 'mock-test',
        deadline: new Date(Date.now() + 60000).toISOString(),
        limits: { leaseSeconds: 60, turnCapSeconds: 60 },
      },
    }
    const answer = await driver.command(workstream, command)
    assert.equal(answer.accepted, true)
    await until(async () => {
      const state = await store.state(workstream)
      return state.current?.session ? state : false
    })
    return { driver, kube, workstream, execution, command }
  }
  it('L6-L8-L11-L22-L25: journaled creation, prompt, targeted cancellation, Stop and exclusive ownership', async () => {
    const l = await lab()
    const state = await store.state(l.workstream),
      session = state.current!.session!
    assert.deepEqual(await l.driver.command(l.workstream, l.command), {
      ...(
        await store.writer.query('SELECT answer FROM commands WHERE workstream=$1 AND id=$2', [
          l.workstream,
          l.command.id,
        ])
      ).rows[0].answer,
    })
    const claim = await l.kube.getClaim(claimName(l.execution))
    assert.equal(claim?.metadata.annotations, undefined)
    assert.equal(l.kube.claims.size, 1)
    const competing = new LogDriver({ ...l.driver.options })
    await assert.rejects(competing.start(), /dispatch_owner_exists/)
    const write = (id = randomUUID()): Command => ({
      id,
      kind: 'Write',
      target: { execution: l.execution, session },
      body: { prompt: [{ type: 'text', text: '/silence 10' }] },
    })
    const pair = await Promise.all([l.driver.command(l.workstream, write()), l.driver.command(l.workstream, write())])
    assert.equal(pair.filter((a) => a.accepted).length, 1)
    let active = (await store.state(l.workstream)).active!
    assert.equal(active.status, 'in_progress')
    const pod = claim!.status!.sandbox!.name!
    // Interrupt the connection by displacing it, using the real bridge's one-peer fence.
    const bridge = l.kube.bridges.get(pod)!
    const { Collector } = await import('@agora/testkit'),
      { mintBridgeToken } = await import('@agora/harness-bridge/token')
    const intruder = new Collector(`ws://${bridge.url}/acp`, {
      authorization: `Bearer ${mintBridgeToken(l.driver.options.signingKey, pod)}`,
    })
    await intruder.opened()
    intruder.close()
    await until(async () => {
      const s = await store.state(l.workstream)
      return s.active?.status === 'uncertain' ? s : false
    })
    await until(async () => {
      const s = await store.state(l.workstream)
      return s.current?.connection ? s : false
    })
    const blocked = await l.driver.command(l.workstream, write())
    assert.equal(blocked.accepted, false)
    const cancel = await l.driver.command(l.workstream, {
      id: randomUUID(),
      kind: 'Cancel',
      target: { execution: l.execution, turn: active.id },
      body: {},
    })
    assert.equal(cancel.accepted, true)
    await until(async () => {
      const s = await store.state(l.workstream)
      return s.active === null ? s : false
    })
    assert.equal([...(await store.state(l.workstream)).turns.values()][0]?.status, 'cancelled')
    assert.equal(
      (
        await l.driver.command(l.workstream, {
          id: randomUUID(),
          kind: 'Cancel',
          target: { execution: l.execution, turn: active.id },
          body: {},
        })
      ).accepted,
      false,
    )
    const stop = await l.driver.command(l.workstream, {
      id: randomUUID(),
      kind: 'Stop',
      target: { execution: l.execution },
      body: {},
    })
    assert.equal(stop.accepted, true)
    const deadlines = l.kube.deadlines.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(l.kube.deadlines.length, deadlines)
    assert.equal((await l.driver.command(l.workstream, write())).accepted, false)
    await l.driver.stop()
    await l.kube.closeAll()
  })
})

describe('log fault windows', () => {
  async function prepared() {
    const { privateKey, publicKey } = keys(),
      kube = new FakeKube(publicKey),
      driver = new LogDriver({
        store,
        kube,
        signingKey: privateKey,
        address: kube.address,
        tickMs: 50,
        shutdownMs: 200,
      })
    await driver.start()
    cleanups.push(() => kube.closeAll())
    cleanups.push(() => driver.stop())
    const workstream = await stream(),
      execution = randomUUID()
    const command: Command = {
      id: randomUUID(),
      kind: 'Create',
      target: {},
      body: {
        execution,
        pool: 'mock-test',
        deadline: new Date(Date.now() + 60000).toISOString(),
        limits: { leaseSeconds: 60, turnCapSeconds: 60 },
      },
    }
    assert.equal((await driver.command(workstream, command)).accepted, true)
    const state = await until(async () => {
      const s = await store.state(workstream)
      return s.current?.session ? s : false
    })
    const write: Command = {
      id: randomUUID(),
      kind: 'Write',
      target: { execution, session: state.current!.session },
      body: { prompt: [{ type: 'text', text: '/silence 10' }] },
    }
    return { driver, kube, workstream, execution, write }
  }
  it('L6: failed outgoing transaction sends nothing and does not accept a command', async () => {
    const l = await prepared(),
      before = (await store.entries(l.workstream)).length
    await migration.query(
      `CREATE FUNCTION fail_out() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.direction='out' AND NEW.method='session/prompt' THEN RAISE EXCEPTION 'test database failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_out BEFORE INSERT ON entries FOR EACH ROW EXECUTE FUNCTION fail_out()`,
    )
    try {
      await assert.rejects(l.driver.command(l.workstream, l.write))
      assert.equal((await store.entries(l.workstream)).length, before)
      assert.equal((await store.state(l.workstream)).active, null)
    } finally {
      await migration.query('DROP TRIGGER fail_out ON entries;DROP FUNCTION fail_out()')
      await l.driver.stop()
      await l.kube.closeAll()
    }
  })
  it('L7-L23: database commit refusal retains ordered input, resumes once and bounds receive bytes', async () => {
    const l = await prepared()
    await migration.query(
      `CREATE FUNCTION fail_in() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.direction='in' AND NEW.method='session/update' THEN RAISE EXCEPTION 'test database failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_in BEFORE INSERT ON entries FOR EACH ROW EXECUTE FUNCTION fail_in()`,
    )
    let removed = false
    try {
      const command = { ...l.write, body: { prompt: [{ type: 'text', text: '/big 8' }] } }
      assert.equal((await l.driver.command(l.workstream, command)).accepted, true)
      const c = l.driver['connections'].get(l.execution)!
      await until(async () => (c.blocked && c.bytes > 0 ? true : false))
      assert.ok(c.bytes <= 2 * MAX_LINE)
      const bytes = c.bytes
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(c.bytes, bytes)
      const deadlineCount = l.kube.deadlines.length
      assert.equal((await l.driver.command(l.workstream, { ...l.write, id: randomUUID() })).accepted, false)
      assert.equal(l.kube.deadlines.length, deadlineCount)
      await migration.query('DROP TRIGGER fail_in ON entries;DROP FUNCTION fail_in()')
      removed = true
      await until(async () => ((await store.state(l.workstream)).active === null ? true : false))
      const incoming = (await store.entries(l.workstream)).filter(
        (e) => e.connection === c.id && e.method === 'session/update',
      )
      assert.equal(incoming.length, 8)
      assert.equal(new Set(incoming.map((e) => e.receive_ordinal)).size, 8)
      assert.equal(c.bytes, 0)
    } finally {
      if (!removed) await migration.query('DROP TRIGGER fail_in ON entries;DROP FUNCTION fail_in()')
      await l.driver.stop()
      await l.kube.closeAll()
    }
  })
  it('L14-L15-L24: clean restart preserves dispatch; missing break reconstructs uncertainty without reinitialize', async () => {
    const l = await prepared()
    assert.equal((await l.driver.command(l.workstream, l.write)).accepted, true)
    await l.driver.stop()
    assert.equal((await store.state(l.workstream)).active?.status, 'in_progress')
    let driver = new LogDriver({ ...l.driver.options })
    await driver.start()
    cleanups.push(() => driver.stop())
    await until(async () => ((await store.state(l.workstream)).current?.connection ? true : false))
    assert.equal(
      (await store.entries(l.workstream)).filter((e) => e.method === 'initialize' && e.direction === 'out').length,
      1,
    )
    const original = store.fact.bind(store)
    store.fact = async (w, input) => {
      if (input.kind === 'execution.break') throw new Error('simulated_commit_outage')
      return original(w, input)
    }
    try {
      await driver.stop()
    } finally {
      store.fact = original
    }
    driver = new LogDriver({ ...l.driver.options })
    await driver.start()
    cleanups.push(() => driver.stop())
    assert.equal((await store.state(l.workstream)).active?.status, 'uncertain')
    const entries = await store.entries(l.workstream)
    assert.equal(entries.filter((e) => e.method === 'session/prompt' && e.direction === 'out').length, 1)
    assert.equal(entries.filter((e) => e.method === 'initialize' && e.direction === 'out').length, 1)
    await driver.stop()
    await l.kube.closeAll()
  })
  it('L21: marker commit refusal leaves a saved prompt; failure after marker never resends', async () => {
    const l = await prepared(),
      send = WebSocket.prototype.send
    await migration.query(
      `CREATE FUNCTION fail_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='acp.dispatching' THEN RAISE EXCEPTION 'test marker outage'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_marker BEFORE INSERT ON entries FOR EACH ROW EXECUTE FUNCTION fail_marker()`,
    )
    let removed = false
    try {
      assert.equal((await l.driver.command(l.workstream, l.write)).accepted, true)
      assert.equal((await store.state(l.workstream)).active?.status, 'saved')
      WebSocket.prototype.send = function (this: WebSocket, ...args: Parameters<typeof send>) {
        if (String(args[0]).includes('session/prompt')) throw new Error('simulated_transport_failure')
        return send.apply(this, args)
      } as typeof send
      await migration.query('DROP TRIGGER fail_marker ON entries;DROP FUNCTION fail_marker()')
      removed = true
      await until(async () => ((await store.state(l.workstream)).active?.status === 'uncertain' ? true : false))
      WebSocket.prototype.send = send
      await until(async () => ((await store.state(l.workstream)).current?.connection ? true : false))
      const entries = await store.entries(l.workstream),
        request = entries.find((e) => e.method === 'session/prompt')!
      assert.equal(
        entries.filter((e) => e.kind === 'acp.dispatching' && e.content.requestPosition === request.position).length,
        1,
      )
      assert.equal(
        entries.filter((e) => e.kind === 'acp.sent' && e.content.requestPosition === request.position).length,
        0,
      )
    } finally {
      WebSocket.prototype.send = send
      if (!removed) await migration.query('DROP TRIGGER fail_marker ON entries;DROP FUNCTION fail_marker()')
      await l.driver.stop()
      await l.kube.closeAll()
    }
  })
  it('L22: recover accepted Create without a POST, then POST without UID; never recreate obtained claims', async () => {
    const { privateKey, publicKey } = keys(),
      kube = new FakeKube(publicKey),
      workstream = await stream(),
      execution = randomUUID()
    const command: Command = {
      id: randomUUID(),
      kind: 'Create',
      target: {},
      body: {
        execution,
        pool: 'mock-test',
        deadline: new Date(Date.now() + 60000).toISOString(),
        limits: { leaseSeconds: 60, turnCapSeconds: 60 },
      },
    }
    await store.accept(workstream, command, async () => ({ execution, claimName: claimName(execution) }))
    const original = store.fact.bind(store)
    store.fact = async (w, input) => {
      if (input.kind === 'execution.obtained' && w === workstream) throw new Error('simulated_crash_window')
      return original(w, input)
    }
    let driver = new LogDriver({
      store,
      kube,
      signingKey: privateKey,
      address: kube.address,
      tickMs: 50,
      shutdownMs: 100,
    })
    cleanups.push(() => kube.closeAll())
    cleanups.push(() => driver.stop())
    try {
      await driver.start()
      await until(async () => (kube.claims.size === 1 ? true : false))
      assert.equal((await store.state(workstream)).current?.uid, undefined)
      await driver.stop()
    } finally {
      store.fact = original
    }
    const before = await kube.getClaim(claimName(execution))
    driver = new LogDriver({ ...driver.options })
    await driver.start()
    await until(async () => ((await store.state(workstream)).current?.session ? true : false))
    assert.equal((await kube.getClaim(claimName(execution)))?.metadata.uid, before!.metadata.uid)
    assert.equal((await kube.getClaim(claimName(execution)))?.spec?.lifecycle?.shutdownTime, command.body.deadline)
    kube.claims.delete(claimName(execution))
    await until(async () => ((await store.state(workstream)).current?.ended ? true : false))
    assert.equal(kube.claims.size, 0)
    await driver.stop()
    await kube.closeAll()
  })
  it('L12-L29: opaque native anchor publication and restore into a new Session', async () => {
    const l = await prepared(),
      session = (await store.state(l.workstream)).current!.session!,
      acpId = (await store.state(l.workstream)).current!.acpId!
    await l.driver.command(l.workstream, { ...l.write, body: { prompt: [{ type: 'text', text: 'remember apple' }] } })
    await until(async () => ((await store.state(l.workstream)).active === null ? true : false))
    const c = l.driver['connections'].get(l.execution)!,
      bridge = l.kube.bridges.get(c.pod)!
    const bundle = await bridge.bridge.terminate()
    const anchor = await l.driver.receiveAnchor(c.pod, bundle, Buffer.from(JSON.stringify(bundle)))
    assert.equal(anchor.accepted, true)
    const replay = await l.driver.receiveAnchor(c.pod, bundle, Buffer.from(JSON.stringify(bundle)))
    assert.deepEqual(replay, anchor)
    if (!anchor.accepted) throw new Error('anchor_refused')
    await store.fact(l.workstream, {
      kind: 'execution.ended',
      execution: l.execution,
      content: { reason: 'deadline_reached' },
    })
    const execution = randomUUID(),
      created = await l.driver.command(l.workstream, {
        id: randomUUID(),
        kind: 'Create',
        target: {},
        body: {
          execution,
          pool: 'mock-test',
          anchor: anchor.command,
          deadline: new Date(Date.now() + 60000).toISOString(),
          limits: { leaseSeconds: 60, turnCapSeconds: 60 },
        },
      })
    assert.equal(created.accepted, true)
    const restored = await until(async () => {
      const s = await store.state(l.workstream)
      return s.current?.id === execution && s.current.session ? s : false
    })
    assert.notEqual(restored.current!.session, session)
    assert.equal(restored.current!.acpId, acpId)
    await l.driver.command(l.workstream, {
      id: randomUUID(),
      kind: 'Write',
      target: { execution, session: restored.current!.session },
      body: { prompt: [{ type: 'text', text: '/recall' }] },
    })
    await until(async () => ((await store.state(l.workstream)).active === null ? true : false))
    assert.ok(project(await store.entries(l.workstream)).some((o) => String(o.object.text).includes('remember apple')))
    await l.driver.stop()
    await l.kube.closeAll()
  })
  it('L18-L28: browser receives a resumable thread; uncertainty disables the composer and survives reload', async () => {
    const l = await prepared(),
      answer = await l.driver.command(l.workstream, l.write)
    assert.equal(answer.accepted, true)
    if (!answer.accepted) throw new Error('write_refused')
    await store.incoming(
      l.workstream,
      l.execution,
      randomUUID(),
      '1',
      rpc({ id: answer.requestId, result: { stopReason: 'invalid' } }),
    )
    await projections.run(l.workstream)
    const html = await readFile(new URL('../../../apps/lab/public/log.html', import.meta.url))
    const server = createServer((req, res) => {
      void (async () => {
        if (req.url?.startsWith('/#') || req.url === '/') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(html)
        } else if (req.url === '/api/pools') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"pools":[{"name":"mock-test"}]}')
        } else if (!(await logHttp(l.driver, req, res))) {
          res.writeHead(404)
          res.end()
        }
      })().catch(() => res.destroy())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const browser = await chromium.launch({ headless: true }),
      page = await browser.newPage(),
      errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/#${l.workstream}`)
      await expect(page.locator('#status')).toContainText('Delivery is uncertain')
      await expect(page.locator('#prompt')).toBeDisabled()
      await expect(page.locator('#cancel')).toBeEnabled()
      await expect(page.locator('#stop')).toBeEnabled()
      await page.reload()
      await expect(page.locator('#status')).toContainText('Delivery is uncertain')
      await expect(page.locator('#prompt')).toBeDisabled()
      await page.locator('#cancel').click()
      await expect(page.locator('#prompt')).toBeEnabled()
      await page.locator('#prompt').fill('/permission')
      await page.locator('#send').click()
      await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Allow', exact: true }).click()
      await expect(page.locator('#thread')).toContainText('Permission: allow-once')
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await l.driver.stop()
      await l.kube.closeAll()
    }
  })
  it('L30: receive commit failure past the deadline ends continuity without a renewed lease', async () => {
    const l = await prepared()
    await migration.query(
      `CREATE FUNCTION fail_expiring() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.direction='in' THEN RAISE EXCEPTION 'test commit outage'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_expiring BEFORE INSERT ON entries FOR EACH ROW EXECUTE FUNCTION fail_expiring()`,
    )
    try {
      await l.driver.command(l.workstream, { ...l.write, body: { prompt: [{ type: 'text', text: '/sleep 3' }] } })
      const c = l.driver['connections'].get(l.execution)!
      c.blocked = true
      c.claim = await l.kube.patchClaim(claimName(l.execution), {
        metadata: { uid: c.claim.metadata.uid },
        spec: { lifecycle: { shutdownTime: new Date(Date.now() + 1500).toISOString() } },
      })
      const deadlineCount = l.kube.deadlines.length
      await until(async () => ((await store.state(l.workstream)).current?.ended ? true : false))
      assert.equal(l.kube.deadlines.length, deadlineCount)
      const entries = await store.entries(l.workstream)
      assert.equal(entries.filter((e) => e.method === 'session/update').length, 0)
      assert.equal([...(await store.state(l.workstream)).turns.values()][0]?.status, 'failed')
      await until(async () => (c.closed ? true : false))
    } finally {
      await migration.query('DROP TRIGGER fail_expiring ON entries;DROP FUNCTION fail_expiring()')
      await l.driver.stop()
      await l.kube.closeAll()
    }
  })
  it('L30: exceeding the retained-line budget closes uncleanly and never reports a drain', async () => {
    const l = await prepared()
    await l.driver.command(l.workstream, l.write)
    const c = l.driver['connections'].get(l.execution)!,
      line = Buffer.alloc(MAX_LINE - 1, 0x20)
    c.ws.emit('message', line, false)
    c.ws.emit('message', line, false)
    assert.ok(c.bytes <= MAX_LINE)
    await until(async () => (c.closed ? true : false))
    await until(async () =>
      (await store.entries(l.workstream)).some(
        (e) => e.kind === 'execution.break' && e.content.connection === c.id && e.content.clean === false,
      )
        ? true
        : false,
    )
    assert.equal((await store.state(l.workstream)).active?.status, 'uncertain')
    await l.driver.stop()
    await l.kube.closeAll()
  })
  it('L21: a transport write without acp.sent remains uncertain and is never resent', async () => {
    const l = await prepared(),
      original = store.fact.bind(store)
    store.fact = async (w, input) => {
      if (w === l.workstream && input.kind === 'acp.sent') throw new Error('simulated_lost_send_receipt')
      return original(w, input)
    }
    try {
      assert.equal((await l.driver.command(l.workstream, l.write)).accepted, true)
    } finally {
      store.fact = original
    }
    await until(async () => ((await store.state(l.workstream)).active?.status === 'uncertain' ? true : false))
    const entries = await store.entries(l.workstream),
      request = entries.find((e) => e.method === 'session/prompt')!
    assert.equal(
      entries.filter((e) => e.kind === 'acp.dispatching' && e.content.requestPosition === request.position).length,
      1,
    )
    assert.equal(
      entries.filter((e) => e.kind === 'acp.sent' && e.content.requestPosition === request.position).length,
      0,
    )
    await l.driver.stop()
    await l.kube.closeAll()
  })
  it('L22: a changed obtained UID is a conflict, with no mutation or replacement', async () => {
    const l = await prepared(),
      claim = l.kube.claims.get(claimName(l.execution))!,
      uid = randomUUID(),
      count = l.kube.deadlines.length
    claim.metadata.uid = uid
    await until(async () => ((await store.state(l.workstream)).current?.lost ? true : false))
    assert.equal(l.kube.deadlines.length, count)
    assert.equal(l.kube.claims.size, 1)
    assert.equal(claim.metadata.uid, uid)
    const next = await l.driver.command(l.workstream, {
      id: randomUUID(),
      kind: 'Create',
      target: {},
      body: {
        execution: randomUUID(),
        pool: 'mock-test',
        deadline: new Date(Date.now() + 60000).toISOString(),
        limits: { leaseSeconds: 60, turnCapSeconds: 60 },
      },
    })
    assert.deepEqual(next, { accepted: false, reason: 'replacement_unproven' })
    await l.driver.stop()
    await l.kube.closeAll()
  })
  it('L23: COMMIT succeeds but its reply is lost; receive retry finds the same occurrence', async () => {
    const s = await seed(),
      connect = store.writer.connect.bind(store.writer)
    const client = await connect(),
      query = client.query.bind(client)
    let lost = false
    client.query = (async (...args: unknown[]) => {
      const result = await (query as (...values: unknown[]) => Promise<unknown>)(...args)
      if (args[0] === 'COMMIT' && !lost) {
        lost = true
        throw new Error('simulated_lost_commit_reply')
      }
      return result
    }) as typeof client.query
    store.writer.connect = (async () => client) as typeof store.writer.connect
    try {
      await assert.rejects(
        store.incoming(
          s.workstream,
          s.execution,
          s.connection,
          '1',
          rpc({ method: 'extension/commit', params: { value: 'x' } }),
        ),
      )
    } finally {
      client.query = query
      store.writer.connect = connect
    }
    assert.equal(
      (
        await store.incoming(
          s.workstream,
          s.execution,
          s.connection,
          '1',
          rpc({ method: 'extension/commit', params: { value: 'x' } }),
        )
      ).handled,
      true,
    )
    assert.equal(
      (await store.entries(s.workstream)).filter((e) => e.connection === s.connection && e.receive_ordinal === '1')
        .length,
      1,
    )
  })
  it('L26: canonical positions above 2^53 preserve arithmetic and generated request ids', async () => {
    const s = await seed()
    await migration.query('UPDATE workstreams SET last_position=$2 WHERE id=$1', [s.workstream, '9007199254740993'])
    const answer = await prompt(s)
    assert.equal(answer.accepted, true)
    if (!answer.accepted) throw new Error('refused')
    assert.equal(answer.position, '9007199254740994')
    assert.equal(answer.requestId, `agora-${s.execution}-9007199254740995`)
    assert.equal((await store.entries(s.workstream)).at(-1)!.position, '9007199254740995')
  })
  it('permission occurrences: a reused harness RPC id cannot receive a stale answer', async () => {
    const s = await seed(),
      params = {
        sessionId: 'acp-session',
        toolCall: { toolCallId: 'tool', title: 'Permission', status: 'pending' },
        options: [],
      }
    await store.incoming(
      s.workstream,
      s.execution,
      s.connection,
      '1',
      rpc({ id: 1, method: 'session/request_permission', params }),
    )
    const first = (await store.entries(s.workstream)).at(-1)!
    const reply = await store.transaction(s.workstream, (tx) =>
      tx.outgoing(s.execution, { id: 1, result: { outcome: { outcome: 'cancelled' } } }, s.session),
    )
    await store.incoming(
      s.workstream,
      s.execution,
      s.connection,
      '2',
      rpc({ id: 1, method: 'session/request_permission', params }),
    )
    const second = (await store.entries(s.workstream)).at(-1)!
    const state = await store.state(s.workstream)
    assert.ok(state.answers.has(first.position))
    assert.ok(!state.answers.has(second.position))
    assert.equal(state.permissions.get('in:1')?.position, second.position)
    const objects = project(await store.entries(s.workstream)).filter((o) => o.object.type === 'permission')
    assert.equal(objects.length, 2)
    assert.equal(objects.filter((o) => o.object.status === 'pending').length, 1)
    assert.equal(
      (await store.entries(s.workstream)).find((e) => e.position === reply.position)?.request_position,
      first.position,
    )
  })
  it('Create binds server-generated execution and deadline once, outside the request fingerprint', async () => {
    const l = await prepared(),
      workstream = await stream(),
      command: Command = {
        id: randomUUID(),
        kind: 'Create',
        target: {},
        body: { pool: 'mock-test', limits: { leaseSeconds: 60, turnCapSeconds: 60 } },
      }
    const answer = await l.driver.command(workstream, command)
    assert.equal(answer.accepted, true)
    if (!answer.accepted) throw new Error('create_refused')
    assert.ok(answer.execution)
    assert.deepEqual(await l.driver.command(workstream, command), answer)
    const state = await store.state(workstream)
    assert.equal(state.current!.id, answer.execution)
    assert.ok(Number.isFinite(Date.parse(String(state.current!.body.deadline))))
    await until(async () => ((await store.state(workstream)).current?.session ? true : false))
    assert.equal(l.kube.claims.size, 2)
    await l.driver.stop()
    await l.kube.closeAll()
  })
  it('L18: a partial initial snapshot drops an object removed before retry', async () => {
    const s = await seed(),
      id = identity(s.workstream, 'ephemeral'),
      client = new ThreadClient()
    let visible = true
    const projector = {
      name: 'ephemeral',
      version: '1',
      fold: () =>
        visible
          ? [{ kind: 'element' as const, id, object: { text: 'temporary' }, first_position: '1', last_position: '1' }]
          : [],
    }
    await projections.run(s.workstream, projector)
    const partial = (await projections.snapshot(s.workstream, '0')).rows.find((r) => r.id === id)!
    client.apply(partial)
    assert.equal(client.cursor, '0')
    assert.ok(client.objects.has(id))
    visible = false
    await store.fact(s.workstream, {
      kind: 'execution.break',
      execution: s.execution,
      content: { connection: s.connection, clean: true, reason: 'transport_error' },
    })
    await projections.run(s.workstream, projector)
    const retry = await projections.snapshot(s.workstream, '0')
    for (const row of retry.rows) client.apply(row)
    client.snapshotEnd(retry.end)
    assert.equal(client.objects.has(id), false)
  })
  it('connection attribution: a late old break does not close or contaminate the newer connection', async () => {
    const s = await seed(),
      next = randomUUID()
    await store.fact(s.workstream, {
      kind: 'execution.connected',
      execution: s.execution,
      content: { connection: s.connection, instance: 'instance' },
    })
    const first = await prompt(s)
    assert.equal(first.accepted, true)
    if (!first.accepted) throw new Error('refused')
    await marker(s, (await store.entries(s.workstream)).at(-1)!.position)
    await store.incoming(
      s.workstream,
      s.execution,
      s.connection,
      '1',
      rpc({ id: first.requestId, result: { stopReason: 'end_turn' } }),
    )
    await store.fact(s.workstream, {
      kind: 'execution.connected',
      execution: s.execution,
      content: { connection: next, instance: 'instance' },
    })
    const second = await prompt(s)
    assert.equal(second.accepted, true)
    await marker({ ...s, connection: next }, (await store.entries(s.workstream)).at(-1)!.position)
    await store.fact(s.workstream, {
      kind: 'execution.break',
      execution: s.execution,
      content: { connection: s.connection, clean: false, reason: 'transport_error' },
    })
    assert.equal((await store.state(s.workstream)).current?.connection, next)
    assert.equal((await store.state(s.workstream)).active?.status, 'in_progress')
    await store.fact(s.workstream, {
      kind: 'execution.break',
      execution: s.execution,
      content: { connection: next, clean: false, reason: 'transport_error' },
    })
    assert.equal((await store.state(s.workstream)).active?.status, 'uncertain')
  })
  it('L26: concurrent role provisioning in separate databases tolerates catalog races', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
      names = [`agora_race_a_${suffix}`, `agora_race_b_${suffix}`]
    const sql = (await readFile(new URL('../sql/001.sql', import.meta.url), 'utf8'))
      .replaceAll('agora_writer', `agora_race_writer_${suffix}`)
      .replaceAll('agora_projector', `agora_race_projector_${suffix}`)
      .replaceAll('agora_anchors', `agora_race_anchors_${suffix}`)
    const pools: Pool[] = []
    try {
      for (const name of names) {
        await migration.query(`CREATE DATABASE ${name}`)
        const url = new URL(process.env.LOG_TEST_MIGRATION_URL!)
        url.pathname = `/${name}`
        pools.push(new Pool({ connectionString: url.href }))
      }
      await Promise.all(pools.map((p) => p.query(sql)))
      const roles = await migration.query('SELECT rolcanlogin,rolsuper FROM pg_roles WHERE rolname=ANY($1)', [
        ['writer', 'projector', 'anchors'].map((r) => `agora_race_${r}_${suffix}`),
      ])
      assert.equal(roles.rowCount, 3)
      assert.ok(roles.rows.every((r) => !r.rolcanlogin && !r.rolsuper))
    } finally {
      await Promise.all(pools.map((p) => p.end()))
      for (const name of names) await migration.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      for (const role of ['writer', 'projector', 'anchors'])
        await migration.query(`DROP ROLE IF EXISTS agora_race_${role}_${suffix}`)
    }
  })
})
