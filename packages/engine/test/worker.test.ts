import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { latch, withTestDatabase, type TestDatabase } from '@agora/testkit'
import type { Authorization, RuleResolution } from '@agora/domain'
import type { ObservationSource } from '../src/index.js'
import {
  backoffDelayMs,
  claimDue,
  createCoalescedRunner,
  createScan,
  FakeObservationSource,
  RecordingVerbExecutor,
  type ScanSummary,
  type WorkerOptions,
} from '../src/index.js'
import { author, createWorkstream, ENGINE, intentOf, PRODUCT, workRow } from './support.js'

const RESOLVE: RuleResolution = {
  harnessDigest: () => 'digest-a',
  capabilityGrants: () => new Set<Authorization>(),
}

function ok<T>(value: T) {
  return { ok: true as const, value }
}

const POLICY = { baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0, maxAttempts: 2, recheckDelayMs: 1_000 }

function workerOptions(db: TestDatabase, source: FakeObservationSource, executor: RecordingVerbExecutor, overrides: Partial<WorkerOptions> = {}): WorkerOptions {
  return {
    pool: db.pool,
    observationSource: source,
    executor,
    resolve: RESOLVE,
    nowSql: db.nowSql,
    claimBatch: 8,
    leaseMs: 60_000,
    backoff: POLICY,
    ...overrides,
  }
}

async function connect(db: TestDatabase): Promise<pg.PoolClient> {
  return db.pool.connect()
}

test('an off Intent against empty fake inventories reaches POWER-001 and finalizes the row', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      const source = new FakeObservationSource({ 'observation.power': ok('off') })
      const executor = new RecordingVerbExecutor()
      const summary: ScanSummary = await createScan(workerOptions(db, source, executor))()
      assert.equal(summary.finalized, 1)
      assert.equal(await workRow(client, id), null)
      assert.equal(executor.calls.length, 0)
      assert.equal(source.readerCountFor(id), 1, 'one fresh reader per tick')
    } finally {
      client.release()
    }
  })
})

test('an on Intent against an empty construction selects BUILD once per tick and the continuation re-evaluates from POWER', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on')))
      const source = new FakeObservationSource({
        'observation.power': ok('on'),
        'observation.construction': ok({ kind: 'empty' }),
      })
      const executor = new RecordingVerbExecutor()
      const scan = createScan(workerOptions(db, source, executor))

      const first = await scan()
      assert.equal(first.action, 1)
      assert.equal(executor.calls.length, 1)
      const context = executor.calls[0]!.context
      assert.equal(context.workstreamId, id)
      assert.equal(context.intentSeq, 1)
      assert.equal(context.workGeneration, 1)
      assert.ok(context.claimToken.length > 0)
      assert.equal(context.rule, 'CONSTRUCT-001')

      const row = await workRow(client, id)
      assert.ok(row, 'BUILD does not finalize')
      assert.equal(row!['claim_token'], null)

      source.setScript({
        'observation.power': ok('on'),
        'observation.construction': ok({ kind: 'set', digests: new Set(['digest-a']), incoherent: false }),
        'observation.session': ok('live'),
        'observation.model': ok('model-a'),
        'observation.effort': ok('default'),
        'observation.sync': ok('current'),
        'observation.grants.attached': ok(new Set<Authorization>()),
        'observation.grants.effective': ok(new Set<Authorization>()),
      })
      const second = await scan()
      assert.equal(second.finalized, 1)
      assert.equal(executor.calls.length, 1, 'no second BUILD after the envelope converged')
      assert.equal(await workRow(client, id), null)
    } finally {
      client.release()
    }
  })
})

test('the executor is never called inside a transaction', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on')))
      const source = new FakeObservationSource({
        'observation.power': ok('on'),
        'observation.construction': ok({ kind: 'empty' }),
      })
      const executor = new RecordingVerbExecutor()
      const statements: string[] = []
      const original = db.pool.query.bind(db.pool)
      db.pool.query = ((...args: unknown[]) => {
        const first = args[0]
        statements.push(typeof first === 'string' ? first : String((first as { text?: string }).text))
        return (original as (...a: unknown[]) => unknown)(...args) as never
      }) as typeof db.pool.query
      try {
        await createScan(workerOptions(db, source, executor))()
      } finally {
        db.pool.query = original
      }
      assert.equal(executor.calls.length, 1)
      assert.equal(statements.some((sql) => /^\s*(BEGIN|START TRANSACTION|COMMIT|ROLLBACK)\b/i.test(sql)), false)
    } finally {
      client.release()
    }
  })
})

test('unavailable evidence reschedules with an acquisition blocking cause, never a verb', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on')))
      const source = new FakeObservationSource({
        'observation.power': ok('on'),
        'observation.construction': () => ({ ok: false as const, reason: 'unavailable' as const }),
      })
      const executor = new RecordingVerbExecutor()
      // Taken before the scan, not after: the bounded recheck is a few seconds out, and a slow runner
      // can spend longer than that between the scan and this assertion — which made the test fail on
      // correct behaviour. What is being asserted is that the row was pushed FORWARD rather than left
      // claimed or turned into a verb, and that is what this compares against.
      const beforeScan = Date.now()
      const summary = await createScan(workerOptions(db, source, executor))()
      assert.equal(summary.acquisition, 1)
      assert.equal(executor.calls.length, 0)
      const row = await workRow(client, id)
      assert.equal(row!['blocking_cause'], 'acquisition:observation.construction')
      assert.ok(((row!['due_at'] as Date)).getTime() > beforeScan, 'rescheduled forward: a bounded recheck, not a held claim')
    } finally {
      client.release()
    }
  })
})

test('a HOLD reschedules with a bounded due time and clears the claim', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on')))
      const source = new FakeObservationSource({
        'observation.power': ok('on'),
        'observation.construction': ok({ kind: 'set', digests: new Set(['digest-a']), incoherent: false }),
        'observation.grants.attached': ok(new Set<Authorization>()),
        'observation.grants.effective': ok(new Set<Authorization>()),
        'observation.session': ok('pending'),
      })
      const executor = new RecordingVerbExecutor()
      // Taken before the scan, not after: the bounded recheck is a few seconds out, and a slow runner
      // can spend longer than that between the scan and this assertion — which made the test fail on
      // correct behaviour. What is being asserted is that the row was pushed FORWARD rather than left
      // claimed or turned into a verb, and that is what this compares against.
      const beforeScan = Date.now()
      const summary = await createScan(workerOptions(db, source, executor))()
      assert.equal(summary.hold, 1)
      assert.equal(executor.calls.length, 0)
      const row = await workRow(client, id)
      assert.equal(row!['claim_token'], null)
      const holdDelay = backoffDelayMs(POLICY, 1)
      assert.ok(((row!['due_at'] as Date)).getTime() > beforeScan, 'rescheduled forward: a bounded recheck, not a held claim')
      assert.ok(((row!['due_at'] as Date)).getTime() < Date.now() + holdDelay + 5_000)
    } finally {
      client.release()
    }
  })
})

test('ENGINE-011: an exhausted retry budget keeps a durable bounded recheck without repeating the unchanged action', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on')))
      const source = new FakeObservationSource({
        'observation.power': ok('on'),
        'observation.construction': ok({ kind: 'empty' }),
      })
      const executor = new RecordingVerbExecutor().failWith('BUILD', () => new Error('runtime control unavailable'))
      const scan = createScan(workerOptions(db, source, executor))

      await scan()
      const firstRow = await workRow(client, id)
      assert.equal(firstRow!['attempt_count'], 1)
      assert.equal(firstRow!['blocking_cause'], null)

      await db.advanceClock(10_000)
      const second = await scan()
      assert.equal(second.blocked, 1)
      const exhaustedRow = await workRow(client, id)
      assert.equal(exhaustedRow!['attempt_count'], 2)
      assert.equal(exhaustedRow!['blocking_cause'], 'action_exhausted:BUILD')
      const dueAt: Date = (exhaustedRow!['due_at'] as Date)
      assert.ok(dueAt.getTime() > Date.now() + 500, 'exhausted rows wait for the bounded recheck interval')

      await db.advanceClock(POLICY.recheckDelayMs)
      const third = await scan()
      assert.equal(third.claimed, 1)
      assert.equal(third.blocked, 1)
      assert.equal(executor.calls.length, 2, 'the unchanged action is not repeated after the budget is exhausted')
      const stillThere = await workRow(client, id)
      assert.ok(stillThere, 'the row is never deleted')
      assert.equal(stillThere!['blocking_cause'], 'action_exhausted:BUILD')
    } finally {
      client.release()
    }
  })
})

test('ENGINE-010: dropped notifications lose nothing and thousands of duplicates coalesce into bounded scans', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      const source = new FakeObservationSource({ 'observation.power': ok('off') })
      const executor = new RecordingVerbExecutor()
      const scan = createScan(workerOptions(db, source, executor))

      let executions = 0
      const paused = latch()
      const slowScan = async (): Promise<void> => {
        executions += 1
        if (executions === 1) await paused.released
        await scan()
      }
      const runner = createCoalescedRunner(slowScan, () => {})
      const first = runner.run()
      for (let i = 0; i < 5_000; i += 1) {
        void runner.run()
      }
      paused.release()
      await first
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      assert.ok(executions <= 3, `duplicates must coalesce, got ${executions} scans`)
      assert.ok(executions >= 2, 'the coalesced continuation scan must still run')
      assert.equal(await workRow(client, id), null, 'polling finds the durable due work without any listener')
    } finally {
      client.release()
    }
  })
})

test('ENGINE-015: a stale action completion cannot postpone or overwrite a newer wake', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const id = await createWorkstream(client)
      await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on')))
      const paused = latch()
      let pauseNext = true
      const source = new FakeObservationSource({
        'observation.power': ok('on'),
        'observation.construction': ok({ kind: 'empty' }),
      })
      const executor = new RecordingVerbExecutor()
      const originalExecute = executor.execute.bind(executor)
      executor.execute = async (verb, context) => {
        await originalExecute(verb, context)
        if (pauseNext) {
          pauseNext = false
          await paused.released
        }
      }
      const scanPromise = createScan(workerOptions(db, source, executor))()

      while (executor.calls.length === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
      const interrupted = await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('on'), 'fresh-wake'))
      assert.equal(interrupted.kind, 'created')
      const wokeRow = await workRow(client, id)
      const wakeGeneration = Number(wokeRow!['work_generation'])
      const wakeDue: Date = (wokeRow!['due_at'] as Date)

      paused.release()
      const summary = await scanPromise
      assert.equal(summary.stale, 1, 'the old completion must observe that its claim was lost')
      const row = await workRow(client, id)
      assert.ok(row, 'the newer wake must survive')
      assert.equal(Number(row!['work_generation']), wakeGeneration)
      assert.equal(row!['claim_token'], null)
      assert.equal(row!['attempt_count'], 0)
      assert.equal(((row!['due_at'] as Date)).getTime(), wakeDue.getTime(), 'the stale completion must not postpone the newer due time')
      const events = await client.query('SELECT count(*)::int AS n FROM workstream_intent_events WHERE workstream_id = $1', [id])
      assert.equal(events.rows[0]!['n'], 2)
    } finally {
      client.release()
    }
  })
})

test('ENGINE-016: one repeatedly failing Workstream cannot starve other due work', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const failing = await createWorkstream(client)
      const healthy = [await createWorkstream(client), await createWorkstream(client), await createWorkstream(client), await createWorkstream(client)]
      await db.asRole(client, PRODUCT, () => author(db, client, failing, intentOf('on')))
      for (const id of healthy) {
        await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      }
      const failingSource = new FakeObservationSource({
        'observation.power': ok('on'),
        'observation.construction': ok({ kind: 'empty' }),
      })
      const healthySource = new FakeObservationSource({ 'observation.power': ok('off') })
      const sources = new Map<string, FakeObservationSource>([[failing, failingSource], ...healthy.map((id) => [id, healthySource] as const)])
      const source: ObservationSource = { reader: (id: string) => sources.get(id)!.reader(id) }
      const executor = new RecordingVerbExecutor().failWith('BUILD', () => new Error('always fails'))
      const scan = createScan(workerOptions(db, source as FakeObservationSource, executor, { claimBatch: 2 }))

      const pendingHealthy = async (): Promise<boolean> => {
        const rows = await Promise.all(healthy.map((id) => workRow(client, id)))
        return rows.some((row) => row !== null)
      }
      for (let i = 0; i < 10 && (await pendingHealthy()); i += 1) {
        await scan()
        await db.advanceClock(POLICY.maxDelayMs + POLICY.recheckDelayMs)
      }
      for (const id of healthy) {
        assert.equal(await workRow(client, id), null, `healthy workstream ${id} must finalize despite the failing neighbor`)
      }
      assert.ok(await workRow(client, failing), 'the failing row stays durably scheduled')
      assert.ok(executor.calls.every((call) => call.context.workstreamId === failing))
    } finally {
      client.release()
    }
  })
})

test('claims are bounded by the batch size', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      for (let i = 0; i < 5; i += 1) {
        const id = await createWorkstream(client)
        await db.asRole(client, PRODUCT, () => author(db, client, id, intentOf('off')))
      }
      const claimed = await db.asRole(client, ENGINE, () => claimDue(db.pool, { limit: 3, leaseMs: 60_000, nowSql: db.nowSql }))
      assert.equal(claimed.length, 3)
    } finally {
      client.release()
    }
  })
})

test('S13: a scan that never returns does not silently end reconciliation', async () => {
  // The `running` flag used to be cleared only in the finally, so one hung scan left it true for
  // ever: every later poll returned immediately and the loop went quiet while the process looked
  // healthy. Live, twice — and the only symptom was a Workstream that stopped converging.
  const logged: string[] = []
  let started = 0
  const runner = createCoalescedRunner(
    async () => {
      started += 1
      await new Promise(() => {}) // never settles, like an owner that accepts and answers nothing
    },
    (message) => logged.push(message),
    20,
  )

  void runner.run()
  await new Promise((resolve) => setTimeout(resolve, 5))
  void runner.run()
  assert.equal(started, 1, 'inside the budget, an overlapping run still coalesces')

  await new Promise((resolve) => setTimeout(resolve, 30))
  void runner.run()
  assert.equal(started, 2, 'past it, the next scan runs rather than the loop dying')
  assert.match(logged.join('\n'), /has not returned/)
  runner.dispose()
})
