import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { selectedRevision } from '@agora/policy'
import { createControlPlaneServer } from '../src/http.js'

const ACTOR = { 'x-agora-service-actor': 'agora-operator' }
const OWNER = { 'x-forwarded-email': 'owner@example.com' }

interface RunningApi {
  readonly port: number
  readonly close: () => Promise<void>
}

async function startApi(db: TestDatabase, options: { publication?: boolean; revisionId?: string } = {}): Promise<RunningApi> {
  const server = createControlPlaneServer({
    productPool: db.pool,
    enginePool: db.pool,
    nowSql: db.nowSql,
    ...(options.revisionId !== undefined ? { revisionId: options.revisionId } : {}),
    ...(options.publication === false ? {} : { publication: { servicePrincipal: 'agora-operator', revisionSet: { catalogue: 'rev-1' } } }),
  })
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

const request = (port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

/** A complete Intent the stub catalogue accepts — the fence must be the reason a request is refused, not the shape. */
function offIntent(): Record<string, unknown> {
  return { power: 'off', harness: 'claude-code', capabilities: ['workspace.read'], model: 'model-a', effort: 'default', persona: 'default', workspaceMode: 'ephemeral' }
}

async function workstream(db: TestDatabase): Promise<string> {
  const id = randomUUID()
  await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1,$2,$3,$4)', [id, 'owner@example.com', 't', randomUUID()])
  return id
}

test('publishing is an operator action: a product user, however authenticated, cannot do it', async () => {
  await withTestDatabase(async (db) => {
    const api = await startApi(db)
    try {
      // A logged-in human with a perfectly valid product session.
      const asUser = await request(api.port, '/v1/admin/revisions', OWNER, 'POST', { revisionId: 'rev-1' })
      assert.equal(asUser.status, 401, 'the product principal is not a service actor')

      const asWrongActor = await request(api.port, '/v1/admin/revisions', { 'x-agora-service-actor': 'someone-else' }, 'POST', { revisionId: 'rev-1' })
      assert.equal(asWrongActor.status, 403)
      assert.equal(await selectedRevision(db.pool), null, 'and nothing was selected by either attempt')
    } finally {
      await api.close()
    }
  })
})

test('a deployment that named no service actor closes the endpoint rather than defaulting', async () => {
  await withTestDatabase(async (db) => {
    const api = await startApi(db, { publication: false })
    try {
      const response = await request(api.port, '/v1/admin/revisions', ACTOR, 'POST', { revisionId: 'rev-1' })
      assert.equal(response.status, 503)
    } finally {
      await api.close()
    }
  })
})

test('publishing selects the revision and wakes every Workstream, including idle ones', async () => {
  await withTestDatabase(async (db) => {
    const ids = await Promise.all([workstream(db), workstream(db), workstream(db)])
    const api = await startApi(db)
    try {
      const response = await request(api.port, '/v1/admin/revisions', ACTOR, 'POST', { revisionId: 'rev-1' })
      assert.equal(response.status, 202)
      const body = (await response.json()) as { state: string; revisionId: string }
      assert.equal(body.revisionId, 'rev-1')
      assert.equal(body.state, 'complete')

      assert.equal((await selectedRevision(db.pool))?.revisionId, 'rev-1')
      const work = await db.pool.query('SELECT workstream_id FROM workstream_reconciliation_work')
      assert.deepEqual(work.rows.map((row) => (row as { workstream_id: string }).workstream_id).sort(), [...ids].sort())
    } finally {
      await api.close()
    }
  })
})

test('SESSION-A11: a worker whose local catalogue is not the selected revision refuses to author', async () => {
  await withTestDatabase(async (db) => {
    const id = await workstream(db)
    // Worker A publishes rev-2. Worker B still resolves rev-1 from its own image.
    const publisher = await startApi(db, { revisionId: 'rev-2' })
    try {
      assert.equal((await request(publisher.port, '/v1/admin/revisions', ACTOR, 'POST', { revisionId: 'rev-2' })).status, 202)
    } finally {
      await publisher.close()
    }

    const stale = await startApi(db, { revisionId: 'rev-1' })
    try {
      const refused = await request(
        stale.port,
        `/v1/workstreams/${id}/intent`,
        { ...OWNER, 'idempotency-key': randomUUID() },
        'PUT',
        offIntent(),
      )
      assert.equal(refused.status, 409, 'it refuses rather than authoring against a superseded catalogue')
      const problem = (await refused.json()) as { detail: string }
      assert.match(problem.detail, /no longer the selected one/)
    } finally {
      await stale.close()
    }

    const current = await startApi(db, { revisionId: 'rev-2' })
    try {
      const accepted = await request(
        current.port,
        `/v1/workstreams/${id}/intent`,
        { ...OWNER, 'idempotency-key': randomUUID() },
        'PUT',
        offIntent(),
      )
      assert.equal(accepted.status, 201, 'the worker on the selected revision proceeds normally')
    } finally {
      await current.close()
    }
  })
})

test('GET reports the selection and anything still owed', async () => {
  await withTestDatabase(async (db) => {
    await workstream(db)
    const api = await startApi(db)
    try {
      await request(api.port, '/v1/admin/revisions', ACTOR, 'POST', { revisionId: 'rev-1' })
      const response = await request(api.port, '/v1/admin/revisions', ACTOR)
      const body = (await response.json()) as { selected: { revisionId: string } | null; unfinished: readonly unknown[] }
      assert.equal(body.selected?.revisionId, 'rev-1')
      assert.deepEqual(body.unfinished, [], 'nothing owed once the publication completed')
    } finally {
      await api.close()
    }
  })
})

test('a retried publication of the same revision does not double the work', async () => {
  await withTestDatabase(async (db) => {
    await workstream(db)
    const api = await startApi(db)
    try {
      const first = (await (await request(api.port, '/v1/admin/revisions', ACTOR, 'POST', { revisionId: 'rev-1' })).json()) as { publicationId: string }
      const second = (await (await request(api.port, '/v1/admin/revisions', ACTOR, 'POST', { revisionId: 'rev-1' })).json()) as { publicationId: string }
      assert.equal(first.publicationId, second.publicationId)
      assert.equal((await db.pool.query('SELECT id FROM revision_publications')).rowCount, 1)
    } finally {
      await api.close()
    }
  })
})
