import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import type { VerbContext, VerbExecutor } from '@agora/engine'
import type { Verb } from '@agora/domain'
import { openSession, bindAcpContext } from '@agora/journal'
import { getAnchor, recordSave } from '@agora/custody'
import { createTurnOffExecutor, type CaptureAttempt, type CaptureSource } from '../../src/verbs/turn-off.js'

function context(workstreamId: string): VerbContext {
  return { workstreamId, intentSeq: 1, workGeneration: 1, claimToken: 'claim-1', rule: 'POWER-002' }
}

/** Records the order verbs reached the owner path — the ordering IS the contract here. */
class RecordingInner implements VerbExecutor {
  readonly verbs: Verb[] = []
  async execute(verb: Verb): Promise<void> {
    this.verbs.push(verb)
  }
}

class StubCapture implements CaptureSource {
  readonly commits: { stagingId: string; saveId: string }[] = []
  attempts = 0
  constructor(private readonly answer: (budgetMs: number) => Promise<CaptureAttempt> | CaptureAttempt) {}
  async attemptCapture(request: { budgetMs: number }): Promise<CaptureAttempt> {
    this.attempts += 1
    return this.answer(request.budgetMs)
  }
  async commitPayload(request: { stagingId: string; saveId: string }): Promise<void> {
    this.commits.push({ stagingId: request.stagingId, saveId: request.saveId })
  }
}

const CAPTURED: CaptureAttempt = {
  kind: 'captured',
  capture: {
    stagingId: 'staging-1',
    checksum: `sha256:${'a'.repeat(64)}`,
    byteLength: 13063,
    formatId: 'claude-code-transcript',
    formatVersion: 1,
    driverRevision: 'claude-code-transcript-1',
    frontierW: 4,
    nativeOrigin: { podUid: 'pod-uid-1' },
    workspaceDeps: {},
    contextId: 'ctx-1',
    processGeneration: 0,
  },
}

async function seed(db: TestDatabase, options: { bindContext?: boolean } = {}): Promise<{ workstreamId: string; sessionId: string; incarnation: string }> {
  const workstreamId = randomUUID()
  const incarnation = `inc-${randomUUID().slice(0, 8)}`
  await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
  // The incarnation TURN_OFF acts on is discovered exactly the way packages/engine discovers it.
  await db.pool.query(
    `INSERT INTO owner_attempts (attempt_key, workstream_id, epoch, operation, target_kind, target_id, payload_digest, state, dispatch_owner, revision_set)
     VALUES ($1, $2, 1, 'create_pod', 'reserved', $3, 'digest', 'settled', 'runtime-control', '{}'::jsonb)`,
    [`attempt-${incarnation}`, workstreamId, incarnation],
  )
  const client = await db.pool.connect()
  let sessionId: string
  try {
    await client.query('BEGIN')
    const opened = await openSession(client, workstreamId, { podUid: 'pod-uid-1', provenance: {} }, { nowSql: db.nowSql })
    sessionId = opened.sessionId
    if (options.bindContext !== false) await bindAcpContext(client, sessionId, { contextId: 'ctx-1', processGeneration: 0 })
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  return { workstreamId, sessionId, incarnation }
}

test('the Pod goes even when the capture answers nothing: OFF-001', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, incarnation } = await seed(db)
    const inner = new RecordingInner()
    // A capture that never produces anything, exactly as a hung one looks from here.
    const capture = new StubCapture(() => ({ kind: 'unavailable', reason: 'the Pod did not answer within its budget' }))
    const executor = createTurnOffExecutor({ inner, productPool: db.pool, enginePool: db.pool, capture, preservationBudgetMs: 5000 })

    await executor.execute('TURN_OFF', context(workstreamId))

    // Authority was cut BEFORE any preservation was attempted, and termination happened regardless.
    assert.deepEqual(inner.verbs, ['REVOKE', 'TURN_OFF'])
    const row = (await db.pool.query('SELECT * FROM shutdowns WHERE workstream_id = $1', [workstreamId])).rows[0]!
    assert.equal(row['capture_outcome'], 'expired')
    assert.match(row['capture_detail'] as string, /did not answer/)
    assert.notEqual(row['terminated_at'], null, 'the Pod was terminated whether or not anything was preserved')
    assert.equal(row['save_id'], null)
    // The old Anchor (here: none at all) is untouched. Nothing was published over it.
    assert.equal(await getAnchor(db.pool, workstreamId, 'claude-code'), null)
    assert.equal(incarnation, row['incarnation'])
  })
})

test('a successful capture commits the Save, binds its payload and advances the Anchor', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, sessionId } = await seed(db)
    const inner = new RecordingInner()
    const capture = new StubCapture(() => CAPTURED)
    const executor = createTurnOffExecutor({ inner, productPool: db.pool, enginePool: db.pool, capture, imageDigest: `sha256:${'b'.repeat(64)}` })

    await executor.execute('TURN_OFF', context(workstreamId))

    const row = (await db.pool.query('SELECT * FROM shutdowns WHERE workstream_id = $1', [workstreamId])).rows[0]!
    assert.equal(row['capture_outcome'], 'captured')
    assert.equal(row['anchor_outcome'], 'published')
    const save = (await db.pool.query('SELECT * FROM saves WHERE id = $1', [row['save_id']])).rows[0]!
    assert.equal(save['session_id'], sessionId, 'the Save names the Session that produced it')
    assert.equal(Number(save['frontier_w']), 4, 'the frontier is the driver\'s, carried through untouched')
    assert.equal(save['driver_revision'], 'claude-code-transcript-1')
    // The bytes are bound only after the metadata exists.
    assert.deepEqual(capture.commits, [{ stagingId: 'staging-1', saveId: row['save_id'] }])
    const anchor = await getAnchor(db.pool, workstreamId, 'claude-code')
    assert.equal(anchor?.saveId, row['save_id'])
    assert.notEqual(row['terminated_at'], null)
  })
})

test('OFF-002: a restart never resets the deadline and never redoes a committed capture', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId } = await seed(db)
    const capture = new StubCapture(() => CAPTURED)
    const first = createTurnOffExecutor({ inner: new RecordingInner(), productPool: db.pool, enginePool: db.pool, capture, preservationBudgetMs: 60_000 })
    await first.execute('TURN_OFF', context(workstreamId))
    const afterFirst = (await db.pool.query('SELECT deadline_at, save_id FROM shutdowns WHERE workstream_id = $1', [workstreamId])).rows[0]!

    // A different process, a much larger budget, a fresh clock: the deadline it discovers is the one
    // already owed, and the capture it finds already committed is not attempted again.
    const second = createTurnOffExecutor({ inner: new RecordingInner(), productPool: db.pool, enginePool: db.pool, capture, preservationBudgetMs: 600_000 })
    await second.execute('TURN_OFF', context(workstreamId))
    const afterSecond = (await db.pool.query('SELECT deadline_at, save_id FROM shutdowns WHERE workstream_id = $1', [workstreamId])).rows[0]!

    assert.deepEqual(afterSecond['deadline_at'], afterFirst['deadline_at'], 'the shutdown deadline is pinned once')
    assert.equal(afterSecond['save_id'], afterFirst['save_id'])
    assert.equal(capture.attempts, 1, 'the committed result was discovered, not recomputed')
  })
})

test('OFF-008: a Session that never bound a context is ineligible, and nothing is published over the healthy Anchor', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId, sessionId } = await seed(db, { bindContext: false })
    // A healthy Anchor from an earlier, verified Session.
    const client = await db.pool.connect()
    try {
      await client.query('BEGIN')
      const earlier = await recordSave(
        client,
        { podUid: 'pod-uid-0', processGeneration: 0, contextId: 'ctx-0', frontierW: 9, driverRevision: 'claude-code-transcript-1' },
        {
          workstreamId,
          sessionId,
          harnessId: 'claude-code',
          formatId: 'claude-code-transcript',
          formatVersion: 1,
          imageDigest: `sha256:${'c'.repeat(64)}`,
          byteLength: 10,
          checksum: `sha256:${'d'.repeat(64)}`,
          seedPolicyRevision: 'handoff-seed-v1',
          nativeOrigin: {},
          workspaceDeps: {},
        },
      )
      await client.query('INSERT INTO anchors (workstream_id, harness_id, save_id, frontier_w) VALUES ($1, $2, $3, $4)', [workstreamId, 'claude-code', earlier.save.id, 9])
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const before = await getAnchor(db.pool, workstreamId, 'claude-code')

    const capture = new StubCapture(() => CAPTURED)
    const executor = createTurnOffExecutor({ inner: new RecordingInner(), productPool: db.pool, enginePool: db.pool, capture })
    await executor.execute('TURN_OFF', context(workstreamId))

    const row = (await db.pool.query('SELECT * FROM shutdowns WHERE workstream_id = $1', [workstreamId])).rows[0]!
    assert.equal(row['capture_outcome'], 'ineligible')
    assert.match(row['capture_detail'] as string, /never bound an ACP context/)
    assert.equal(capture.attempts, 0, 'an ineligible Session is never even asked to capture')
    assert.deepEqual(await getAnchor(db.pool, workstreamId, 'claude-code'), before, 'the healthy Anchor is exactly as it was')
    assert.notEqual(row['terminated_at'], null)
  })
})

test('a refused cut is recorded as a refusal, distinct from an expired budget', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId } = await seed(db)
    const capture = new StubCapture(() => ({ kind: 'refused', reason: 'the transcript was still changing after 10000ms' }))
    const executor = createTurnOffExecutor({ inner: new RecordingInner(), productPool: db.pool, enginePool: db.pool, capture })

    await executor.execute('TURN_OFF', context(workstreamId))

    const row = (await db.pool.query('SELECT capture_outcome, capture_detail FROM shutdowns WHERE workstream_id = $1', [workstreamId])).rows[0]!
    assert.equal(row['capture_outcome'], 'refused')
    assert.match(row['capture_detail'] as string, /still changing/)
  })
})

test('the capture only gets what is LEFT of the budget, never a fresh one', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId } = await seed(db)
    const budgets: number[] = []
    const capture = new StubCapture((budgetMs) => {
      budgets.push(budgetMs)
      return { kind: 'refused', reason: 'measured' }
    })
    let clock = new Date('2026-09-06T12:00:00Z')
    const executor = createTurnOffExecutor({
      inner: new RecordingInner(),
      productPool: db.pool,
      enginePool: db.pool,
      capture,
      preservationBudgetMs: 20_000,
      now: () => clock,
    })
    // The deadline is pinned here; by the time preservation runs, 8 seconds of it are gone.
    const original = executor.execute('TURN_OFF', context(workstreamId))
    clock = new Date(clock.getTime() + 8_000)
    await original

    assert.equal(budgets.length, 1)
    assert.ok(budgets[0]! <= 20_000, 'never more than the original budget')
  })
})

test('with no custody deployed, TURN_OFF is the S7 shutdown, unchanged', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId } = await seed(db)
    const inner = new RecordingInner()
    const executor = createTurnOffExecutor({ inner, productPool: db.pool, enginePool: db.pool })

    await executor.execute('TURN_OFF', context(workstreamId))

    assert.deepEqual(inner.verbs, ['TURN_OFF'], 'no preservation, no extra revocation pass, no shutdown row')
    assert.equal((await db.pool.query('SELECT * FROM shutdowns WHERE workstream_id = $1', [workstreamId])).rowCount, 0)
  })
})

test('a verb that is not TURN_OFF passes straight through', async () => {
  await withTestDatabase(async (db) => {
    const { workstreamId } = await seed(db)
    const inner = new RecordingInner()
    const executor = createTurnOffExecutor({ inner, productPool: db.pool, enginePool: db.pool, capture: new StubCapture(() => CAPTURED) })

    await executor.execute('BUILD', context(workstreamId))

    assert.deepEqual(inner.verbs, ['BUILD'])
  })
})
