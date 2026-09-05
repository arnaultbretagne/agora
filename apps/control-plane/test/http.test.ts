import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type pg from 'pg'
import { createScan, FakeObservationSource, RecordingVerbExecutor } from '@agora/engine'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { createControlPlaneServer } from '../src/http.js'

function ok<T>(value: T) {
  return { ok: true as const, value }
}

const RESOLVE = { harnessDigest: () => 'digest-a', capabilityGrants: () => new Set<never>() }

function offIntent(): Record<string, unknown> {
  return {
    power: 'off',
    harness: 'claude-code',
    capabilities: ['workspace.read'],
    model: 'model-a',
    effort: 'default',
    persona: 'default',
  }
}

interface RunningApi {
  readonly port: number
  readonly close: () => Promise<void>
}

const request = (port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown): Promise<Response> => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

async function startApi(db: TestDatabase): Promise<RunningApi> {
  const server = createControlPlaneServer({ productPool: db.pool, enginePool: db.pool, nowSql: db.nowSql })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const OWNER = { 'x-forwarded-email': 'owner@example.com' }

async function createWorkstream(port: number, key: string): Promise<{ status: number; id: string }> {
  const response = await request(port, '/v1/workstreams', { ...OWNER, 'idempotency-key': key }, 'POST', { title: 'demo' })
  const body = (await response.json()) as { id: string }
  return { status: response.status, id: body.id }
}

test('requests without the proxy principal are unauthenticated with a populated problem detail', async () => {
  await withTestDatabase(async (db) => {
    const api_ = await startApi(db)
    try {
      const response = await request(api_.port, '/v1/workstreams', {}, 'POST', { title: 'x' })
      assert.equal(response.status, 401)
      const problem = (await response.json()) as { title: string; status: number; detail: string }
      assert.equal(problem.status, 401)
      assert.ok(problem.detail.length > 0)
    } finally {
      await api_.close()
    }
  })
})

test('POST /workstreams requires an Idempotency-Key and replays the same key', async () => {
  await withTestDatabase(async (db) => {
    const api_ = await startApi(db)
    try {
      const missing = await request(api_.port, '/v1/workstreams', { ...OWNER }, 'POST', { title: 'x' })
      assert.equal(missing.status, 400)
      const created = await request(api_.port, '/v1/workstreams', { ...OWNER, 'idempotency-key': 'key-1' }, 'POST', { title: 'demo' })
      assert.equal(created.status, 201)
      const workstream = (await created.json()) as { id: string }
      const replay = await request(api_.port, '/v1/workstreams', { ...OWNER, 'idempotency-key': 'key-1' }, 'POST', { title: 'demo' })
      assert.equal(replay.status, 200)
      const replayed = (await replay.json()) as { id: string }
      assert.equal(replayed.id, workstream.id)
      const list = await request(api_.port, '/v1/workstreams', { ...OWNER })
      const workstreams = (await list.json()) as Array<{ id: string; title: string }>
      assert.equal(workstreams.length, 1)
      assert.equal(workstreams[0]!.title, 'demo')
    } finally {
      await api_.close()
    }
  })
})

test('workstream read, rename and ownership isolation', async () => {
  await withTestDatabase(async (db) => {
    const api_ = await startApi(db)
    try {
      const { id } = await createWorkstream(api_.port, 'key-1')
      const other = await request(api_.port, `/v1/workstreams/${id}`, { 'x-forwarded-email': 'intruder@example.com' })
      assert.equal(other.status, 404)
      const renamed = await request(api_.port, `/v1/workstreams/${id}`, { ...OWNER }, 'PATCH', { title: 'renamed' })
      assert.equal(renamed.status, 200)
      const body = (await renamed.json()) as { title: string }
      assert.equal(body.title, 'renamed')
      const invalid = await request(api_.port, `/v1/workstreams/${id}`, { ...OWNER }, 'PATCH', { title: '' })
      assert.equal(invalid.status, 422)
      const problem = (await invalid.json()) as { detail: string }
      assert.ok(problem.detail.length > 0)
    } finally {
      await api_.close()
    }
  })
})

test('PUT intent validates the complete shape against the stub catalogue', async () => {
  await withTestDatabase(async (db) => {
    const api_ = await startApi(db)
    try {
      const { id } = await createWorkstream(api_.port, 'key-1')
      const invalid = await request(api_.port, `/v1/workstreams/${id}/intent`, { ...OWNER, 'idempotency-key': 'k' }, 'PUT', { power: 'maybe' })
      assert.equal(invalid.status, 422)
      const problem = (await invalid.json()) as { detail: string }
      assert.ok(problem.detail.length > 0)
      const retiredHarness = await request(api_.port, `/v1/workstreams/${id}/intent`, { ...OWNER, 'idempotency-key': 'k2' }, 'PUT', {
        power: 'on',
        harness: 'retired',
        capabilities: ['provider.invoke'],
        model: 'model-a',
        effort: 'default',
        persona: 'default',
      })
      assert.equal(retiredHarness.status, 422)
    } finally {
      await api_.close()
    }
  })
})

test('PUT intent: created, replayed, conflict, unknown workstream', async () => {
  await withTestDatabase(async (db) => {
    const api_ = await startApi(db)
    try {
      const { id } = await createWorkstream(api_.port, 'key-1')
      const created = await request(api_.port, `/v1/workstreams/${id}/intent`, { ...OWNER, 'idempotency-key': 'intent-1' }, 'PUT', offIntent())
      assert.equal(created.status, 201)
      assert.deepEqual(await created.json(), { status: 'created', intentSeq: 1 })
      const replayed = await request(api_.port, `/v1/workstreams/${id}/intent`, { ...OWNER, 'idempotency-key': 'intent-1' }, 'PUT', offIntent())
      assert.equal(replayed.status, 200)
      assert.deepEqual(await replayed.json(), { status: 'replayed', intentSeq: 1 })
      const conflict = await request(
        api_.port,
        `/v1/workstreams/${id}/intent`,
        { ...OWNER, 'idempotency-key': 'intent-1' },
        'PUT',
        offIntent(),
      )
      void conflict
      const different = await request(
        api_.port,
        `/v1/workstreams/${id}/intent`,
        { ...OWNER, 'idempotency-key': 'intent-1' },
        'PUT',
        { ...offIntent(), model: 'model-b' },
      )
      assert.equal(different.status, 409)
      const unknown = await request(
        api_.port,
        `/v1/workstreams/00000000-0000-4000-8000-000000000000/intent`,
        { ...OWNER, 'idempotency-key': 'intent-9' },
        'PUT',
        offIntent(),
      )
      assert.equal(unknown.status, 404)
    } finally {
      await api_.close()
    }
  })
})

test('the worker finalizes an off Intent and the operational view shows the absence of the work row', async () => {
  await withTestDatabase(async (db) => {
    const api_ = await startApi(db)
    try {
      const { id } = await createWorkstream(api_.port, 'key-1')
      const put = await request(api_.port, `/v1/workstreams/${id}/intent`, { ...OWNER, 'idempotency-key': 'intent-1' }, 'PUT', offIntent())
      assert.equal(put.status, 201)

      const before = (await (await request(api_.port, `/v1/workstreams/${id}/intent`, { ...OWNER })).json()) as { work: { note: string; dueAt: string } }
      assert.ok(before.work, 'the row is scheduled right after authoring')
      assert.match(before.work.note, /not a convergence proof/)

      const source = new FakeObservationSource({ 'observation.power': ok('off') })
      const executor = new RecordingVerbExecutor()
      const summary = await createScan({
        pool: db.pool as pg.Pool,
        observationSource: source,
        executor,
        resolve: RESOLVE,
        nowSql: db.nowSql,
      })()
      assert.equal(summary.finalized, 1)

      const after = (await (await request(api_.port, `/v1/workstreams/${id}/intent`, { ...OWNER })).json()) as {
        intentSeq: number
        intent: { power: string }
        work: unknown
      }
      assert.equal(after.intentSeq, 1)
      assert.equal(after.intent.power, 'off')
      assert.equal(after.work, null)
    } finally {
      await api_.close()
    }
  })
})
