import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withTestDatabase, RuntimeControlFake, BrokerFake, type TestDatabase } from '@agora/testkit'
import { harnessId, capabilityId } from '@agora/domain'
import type { Intent } from '@agora/domain'
import type { OwnerRequest, OwnerResponse } from '@agora/owner-requests'
import { authorIntent } from '../src/authoring.js'
import { OwnerVerbRunner, MissingIncarnationError, UnwiredVerbError, type VerbRunnerTransport } from '../src/verb-runner.js'
import type { VerbContext } from '../src/verb-executor.js'

const WORKSTREAM = '11111111-1111-4111-8111-111111111111'

async function setup(db: TestDatabase): Promise<void> {
  await db.pool.query("INSERT INTO workstreams (id, owner_principal, title, create_request_key, head_seq) VALUES ($1, 'o', 't', 'k', 0)", [WORKSTREAM])
}

async function withIntent(db: TestDatabase, value: Intent): Promise<void> {
  const client = await db.pool.connect()
  try {
    await authorIntent(client, { workstreamId: WORKSTREAM, principal: 'p', requestKey: 'r1', intent: value, revisionSet: {} })
  } finally {
    client.release()
  }
}

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    power: 'on',
    harness: harnessId('claude-code'),
    capabilities: new Set([capabilityId('provider.anthropic')]),
    model: 'sonnet',
    effort: 'default',
    persona: 'default',
    ...overrides,
  }
}

function context(overrides: Partial<VerbContext> = {}): VerbContext {
  return { workstreamId: WORKSTREAM, intentSeq: 1, workGeneration: 1, claimToken: 'claim-1', rule: 'POWER-001', ...overrides }
}

/** Routes create_pod/cleanup_pod to a RuntimeControlFake, attach_grant/detach_grant to a BrokerFake — the same split apps/runtime-control and apps/broker actually own. */
function fakeTransport(runtimeControl: RuntimeControlFake, broker: BrokerFake): VerbRunnerTransport {
  return {
    route: (operation) => (operation === 'create_pod' || operation === 'cleanup_pod' ? 'runtime-control' : 'broker'),
    send: async (owner: string, request: OwnerRequest): Promise<OwnerResponse> => {
      const fake = owner === 'runtime-control' ? runtimeControl : broker
      return fake.handle(request)
    },
  }
}

test('BUILD: dispatches create_pod with the Intent\'s harness and a fresh reserved incarnation', async () => {
  await withTestDatabase(async (db) => {
    await setup(db)
    await withIntent(db, intent())
    const runtimeControl = new RuntimeControlFake()
    const runner = new OwnerVerbRunner({ pool: db.pool, transport: fakeTransport(runtimeControl, new BrokerFake()) })
    await runner.execute('BUILD', context())
    const targets = runtimeControl.targets()
    assert.equal(targets.length, 1)
    assert.equal(targets[0]!.kind, 'pod')
  })
})

test('BUILD retried under a new work generation reuses the same reserved incarnation as the first, settled attempt', async () => {
  await withTestDatabase(async (db) => {
    await setup(db)
    await withIntent(db, intent())
    const runtimeControl = new RuntimeControlFake()
    const runner = new OwnerVerbRunner({ pool: db.pool, transport: fakeTransport(runtimeControl, new BrokerFake()) })
    await runner.execute('BUILD', context({ workGeneration: 1 }))
    const firstTarget = runtimeControl.targets()[0]!.id
    await runner.execute('BUILD', context({ workGeneration: 2 }))
    // A second BUILD on an already-settled create_pod is idempotent by construction (the reserved
    // target is reused) — no second Pod should have appeared under a different target id.
    assert.equal(runtimeControl.targets().length, 1)
    assert.equal(runtimeControl.targets()[0]!.id, firstTarget)
  })
})

test('TURN_OFF without a prior BUILD is refused rather than inventing a target', async () => {
  await withTestDatabase(async (db) => {
    await setup(db)
    const runner = new OwnerVerbRunner({ pool: db.pool, transport: fakeTransport(new RuntimeControlFake(), new BrokerFake()) })
    await assert.rejects(() => runner.execute('TURN_OFF', context()), MissingIncarnationError)
  })
})

test('TURN_OFF acts on the exact same incarnation BUILD reserved', async () => {
  await withTestDatabase(async (db) => {
    await setup(db)
    await withIntent(db, intent())
    const runtimeControl = new RuntimeControlFake()
    const runner = new OwnerVerbRunner({ pool: db.pool, transport: fakeTransport(runtimeControl, new BrokerFake()) })
    await runner.execute('BUILD', context({ workGeneration: 1 }))
    const built = runtimeControl.targets()[0]!.id
    await runner.execute('TURN_OFF', context({ workGeneration: 2 }))
    assert.equal(runtimeControl.targets().length, 0, 'cleanup_pod removed exactly the Pod BUILD created')
    void built
  })
})

test('GRANT carries the Intent\'s capability ids to the Broker', async () => {
  await withTestDatabase(async (db) => {
    await setup(db)
    await withIntent(db, intent())
    const runtimeControl = new RuntimeControlFake()
    const broker = new BrokerFake()
    const runner = new OwnerVerbRunner({ pool: db.pool, transport: fakeTransport(runtimeControl, broker) })
    await runner.execute('BUILD', context({ workGeneration: 1 }))
    let capturedPayload: Record<string, unknown> | undefined
    const originalHandle = broker.handle.bind(broker)
    broker.handle = async (request: OwnerRequest) => {
      capturedPayload = request.payload
      return originalHandle(request)
    }
    await runner.execute('GRANT', context({ workGeneration: 2 }))
    assert.deepEqual(capturedPayload?.['capabilityIds'], ['provider.anthropic'])
  })
})

test('a retired incarnation is not rebuilt into — BUILD mints a fresh one, and work on the retired one is refused', async () => {
  // This test used to assert that BUILD THROWS `target_retired` after its incarnation was retired.
  // That describes a system which can never rebuild anything: every cleanup retires the
  // incarnation, so the next BUILD would be refused for ever. The live deployment found the other
  // half of the same mistake — the engine was not recording retirements at all, so BUILD happily
  // rebuilt INTO the retired incarnation and every later operation on it was refused as stale.
  //
  // The rule is about the TARGET, not the verb: a retired target refuses further work; a new
  // incarnation is a different target and is exactly what BUILD is for.
  await withTestDatabase(async (db) => {
    await setup(db)
    await withIntent(db, intent())
    const runtimeControl = new RuntimeControlFake()
    const runner = new OwnerVerbRunner({ pool: db.pool, transport: fakeTransport(runtimeControl, new BrokerFake()) })
    const seen: string[] = []
    const originalHandle = runtimeControl.handle.bind(runtimeControl)
    runtimeControl.handle = async (request: OwnerRequest) => {
      seen.push(request.target.id)
      return originalHandle(request)
    }
    await runner.execute('BUILD', context({ workGeneration: 1 }))
    const retired = seen[0]!
    const { retireTarget } = await import('../src/retirement.js')
    await retireTarget(db.pool, WORKSTREAM, 'concrete', retired, 'cleanup_pod:TURN_OFF')

    await runner.execute('BUILD', context({ workGeneration: 2 }))
    assert.equal(seen.length, 2)
    assert.notEqual(seen[1], retired, 'the retired incarnation is dead; a rebuild gets a fresh one')

    // Cleanup, on the other hand, MUST still be able to name a retired incarnation: a Pod outlives
    // its retirement whenever a cleanup response was lost, and refusing to name it would leave a
    // real running Pod nothing in the system can remove (engine.md — "concrete-target cleanup stays
    // authorized"). Live, that was the state a Workstream ended in.
    await retireTarget(db.pool, WORKSTREAM, 'concrete', seen[1]!, 'cleanup_pod:TURN_OFF')
    await runner.execute('TURN_OFF', context({ workGeneration: 3 }))
    assert.equal(seen[2], seen[1], 'TURN_OFF aims at the Pod that exists, retired or not')
  })
})

test('an ACP-facing verb not yet wired throws a typed, explicit error rather than silently doing nothing', async () => {
  await withTestDatabase(async (db) => {
    await setup(db)
    const runner = new OwnerVerbRunner({ pool: db.pool, transport: fakeTransport(new RuntimeControlFake(), new BrokerFake()) })
    await assert.rejects(() => runner.execute('START', context()), UnwiredVerbError)
  })
})
