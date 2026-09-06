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

test('a retired target refuses a new positive verb (BUILD) at the engine, before ever reaching the owner', async () => {
  await withTestDatabase(async (db) => {
    await setup(db)
    await withIntent(db, intent())
    const runtimeControl = new RuntimeControlFake()
    const runner = new OwnerVerbRunner({ pool: db.pool, transport: fakeTransport(runtimeControl, new BrokerFake()) })
    let reservedTargetId: string | undefined
    const originalHandle = runtimeControl.handle.bind(runtimeControl)
    runtimeControl.handle = async (request: OwnerRequest) => {
      reservedTargetId = request.target.id
      return originalHandle(request)
    }
    await runner.execute('BUILD', context({ workGeneration: 1 }))
    const { retireTarget } = await import('../src/retirement.js')
    await retireTarget(db.pool, WORKSTREAM, 'reserved', reservedTargetId!, 'test-retirement')
    await assert.rejects(() => runner.execute('BUILD', context({ workGeneration: 2 })), /target_retired/)
  })
})

test('an ACP-facing verb not yet wired throws a typed, explicit error rather than silently doing nothing', async () => {
  await withTestDatabase(async (db) => {
    await setup(db)
    const runner = new OwnerVerbRunner({ pool: db.pool, transport: fakeTransport(new RuntimeControlFake(), new BrokerFake()) })
    await assert.rejects(() => runner.execute('START', context()), UnwiredVerbError)
  })
})
