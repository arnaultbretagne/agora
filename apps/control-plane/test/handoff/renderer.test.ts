import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { appendFact, openSession } from '@agora/journal'
import { BUDGETS, renderHandoff, SEED_POLICY_REVISION, handoffUri } from '../../src/handoff/renderer.js'

interface Appended {
  readonly workstreamId: string
  readonly sessionId: string
}

async function seed(db: TestDatabase): Promise<Appended> {
  const workstreamId = randomUUID()
  const client = await db.pool.connect()
  try {
    return await db.asRole(client, 'agora_product', async () => {
      await client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
      await client.query('BEGIN')
      const opened = await openSession(client, workstreamId, { podUid: 'pod-a', provenance: {} })
      await client.query('COMMIT')
      return { workstreamId, sessionId: opened.sessionId }
    })
  } finally {
    client.release()
  }
}

/** Appends one acp.envelope fact with its raw frame text, exactly the way the capture seam does. */
async function envelope(db: TestDatabase, seeded: Appended, frame: unknown, meta: { method: string | null; rpcKind: string }): Promise<void> {
  const client = await db.pool.connect()
  try {
    await db.asRole(client, 'agora_product', async () => {
      await client.query('BEGIN')
      await appendFact(client, seeded.workstreamId, {
        sessionId: seeded.sessionId,
        kind: 'acp.envelope',
        payloadRawText: JSON.stringify(frame),
        acp: {
          direction: 'client_to_agent',
          rpcKind: meta.rpcKind as 'request' | 'notification',
          method: meta.method,
          correlatedMethod: null,
          rpcId: null,
          commandId: null,
          connectionId: 'conn-1',
          observationId: randomUUID(),
          frameSize: Buffer.byteLength(JSON.stringify(frame)),
        },
      })
      await client.query('COMMIT')
    })
  } finally {
    client.release()
  }
}

const prompt = (text: string) => ({ method: 'session/prompt', params: { sessionId: 'ctx-1', prompt: [{ type: 'text', text }] } })
const update = (sessionUpdate: string, body: Record<string, unknown>) => ({ method: 'session/update', params: { sessionId: 'ctx-1', update: { sessionUpdate, ...body } } })

test('an empty range renders nothing at all — not an empty resource (CONT-002)', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db)
    assert.equal(await renderHandoff(db.pool, { workstreamId: seeded.workstreamId, commandId: 'cmd-1', w: 3, h: 3 }), null)
    assert.equal(await renderHandoff(db.pool, { workstreamId: seeded.workstreamId, commandId: 'cmd-1', w: 5, h: 3 }), null)
  })
})

test('the rendering folds the range in seq order and excludes bootstrap bookkeeping', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db)
    await envelope(db, seeded, prompt('what is the plan?'), { method: 'session/prompt', rpcKind: 'request' })
    await envelope(db, seeded, update('agent_message_chunk', { content: { type: 'text', text: 'here it is' } }), { method: 'session/update', rpcKind: 'notification' })
    await envelope(db, seeded, { method: 'session/new', params: {} }, { method: 'session/new', rpcKind: 'request' })
    await envelope(db, seeded, { method: 'initialize', params: {} }, { method: 'initialize', rpcKind: 'request' })

    const rendered = await renderHandoff(db.pool, { workstreamId: seeded.workstreamId, commandId: 'cmd-1', w: 0, h: 99 })

    assert.ok(rendered !== null)
    assert.match(rendered.text, /user: what is the plan\?/)
    assert.match(rendered.text, /agent: here it is/)
    assert.ok(!rendered.text.includes('session/new'), 'transport frames are not context')
    assert.ok(!rendered.text.includes('initialize'))
    assert.equal(rendered.uri, handoffUri(seeded.workstreamId, 'cmd-1'))
    assert.equal(rendered.policyRevision, SEED_POLICY_REVISION)
    assert.equal(rendered.degraded, false)
  })
})

test('rendering the same range twice is byte-identical — the digest is what proves delivery', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db)
    await envelope(db, seeded, prompt('one'), { method: 'session/prompt', rpcKind: 'request' })
    await envelope(db, seeded, update('agent_thought_chunk', { content: { type: 'text', text: 'thinking' } }), { method: 'session/update', rpcKind: 'notification' })
    await envelope(db, seeded, update('tool_call_update', { title: 'read', status: 'completed', content: { type: 'text', text: 'file bytes' } }), { method: 'session/update', rpcKind: 'notification' })

    const first = await renderHandoff(db.pool, { workstreamId: seeded.workstreamId, commandId: 'cmd-1', w: 0, h: 99 })
    const second = await renderHandoff(db.pool, { workstreamId: seeded.workstreamId, commandId: 'cmd-1', w: 0, h: 99 })

    assert.equal(first?.text, second?.text)
    assert.equal(first?.digest, second?.digest)
  })
})

test('only the final plan state survives, and a previous Handoff is never nested', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db)
    await envelope(db, seeded, update('plan', { entries: [{ content: 'first draft' }] }), { method: 'session/update', rpcKind: 'notification' })
    await envelope(db, seeded, update('plan', { entries: [{ content: 'what we actually did' }] }), { method: 'session/update', rpcKind: 'notification' })
    await envelope(
      db,
      seeded,
      { method: 'session/prompt', params: { sessionId: 'ctx-1', prompt: [{ type: 'resource', resource: { uri: 'agora://workstreams/w/handoffs/older', text: 'a whole earlier handoff' } }] } },
      { method: 'session/prompt', rpcKind: 'request' },
    )

    const rendered = await renderHandoff(db.pool, { workstreamId: seeded.workstreamId, commandId: 'cmd-1', w: 0, h: 99 })

    assert.ok(rendered !== null)
    assert.ok(!rendered.text.includes('first draft'), 'superseded plan states describe nothing anyone acted on')
    assert.match(rendered.text, /what we actually did/)
    assert.match(rendered.text, /handoff: agora:\/\/workstreams\/w\/handoffs\/older/)
    assert.ok(!rendered.text.includes('a whole earlier handoff'), 'card metadata only — nesting would compound every Handoff')
  })
})

test('a frame this revision does not name becomes a manifest entry, never an injected payload', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db)
    await envelope(db, seeded, update('some_future_update', { secretish: 'raw payload' }), { method: 'session/update', rpcKind: 'notification' })

    const rendered = await renderHandoff(db.pool, { workstreamId: seeded.workstreamId, commandId: 'cmd-1', w: 0, h: 99 })

    assert.match(rendered!.text, /unrendered: session\/update:some_future_update/)
    assert.ok(!rendered!.text.includes('raw payload'))
  })
})

test('a thought over its budget is truncated on a boundary and says exactly what was cut', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db)
    const huge = 'é'.repeat(BUDGETS.oneThought) // two bytes per character: comfortably over
    await envelope(db, seeded, update('agent_thought_chunk', { content: { type: 'text', text: huge } }), { method: 'session/update', rpcKind: 'notification' })

    const rendered = await renderHandoff(db.pool, { workstreamId: seeded.workstreamId, commandId: 'cmd-1', w: 0, h: 99 })

    assert.match(rendered!.text, /\[truncated by handoff-seed-v1\]/)
    assert.match(rendered!.text, /original_bytes=\d+ sha256=[0-9a-f]{64}/)
    assert.ok(!rendered!.text.includes('�'), 'never cut mid-code-point')
  })
})

test('a message that arrived as a prompt and was replayed as a chunk is rendered once', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db)
    await envelope(db, seeded, prompt('say it once'), { method: 'session/prompt', rpcKind: 'request' })
    await envelope(db, seeded, update('user_message_chunk', { content: { type: 'text', text: 'say it once' } }), { method: 'session/update', rpcKind: 'notification' })

    const rendered = await renderHandoff(db.pool, { workstreamId: seeded.workstreamId, commandId: 'cmd-1', w: 0, h: 99 })

    const occurrences = rendered!.text.split('user: say it once').length - 1
    assert.equal(occurrences, 1, 'rendering it twice would tell the next context it was said twice')
  })
})

test('a range that overflows the resource budget degrades, with a manifest and previews', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db)
    // Essential content alone past 512 KiB: 12 messages of 64 KiB.
    for (let i = 0; i < 12; i += 1) {
      await envelope(db, seeded, prompt(`${String(i)}-${'x'.repeat(64 * 1024)}`), { method: 'session/prompt', rpcKind: 'request' })
    }

    const rendered = await renderHandoff(db.pool, { workstreamId: seeded.workstreamId, commandId: 'cmd-1', w: 0, h: 999 })

    assert.equal(rendered!.degraded, true)
    assert.match(rendered!.text, /fidelity=degraded/)
    assert.match(rendered!.text, /manifest: seq=\d+ kind=acp\.envelope sha256=[0-9a-f]{64}/)
    assert.match(rendered!.text, /preview: seq=/)
    // The most recent essential items survive complete; the oldest are previews.
    assert.ok(rendered!.text.includes('user: 11-'))
  })
})
