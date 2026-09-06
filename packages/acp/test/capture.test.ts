import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { openSession } from '@agora/journal'
import { createPersist, journalDuplexStream } from '../src/index.js'

const PRODUCT = 'agora_product'

async function connect(db: TestDatabase): Promise<pg.PoolClient> {
  return db.pool.connect()
}

async function setup(db: TestDatabase, client: pg.PoolClient): Promise<string> {
  const id = crypto.randomUUID()
  await client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [id, 'owner@example.com', 'w', crypto.randomUUID()])
  await client.query('BEGIN')
  try {
    await openSession(client, id, { podUid: 'pod-1', provenance: {} }, { nowSql: db.nowSql })
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
  return id
}

test('the raw frame text is persisted and read back with the 64-bit integer intact', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await setup(db, client)
      const session = (await client.query('SELECT id FROM sessions WHERE workstream_id = $1', [workstreamId])).rows[0]!['id'] as string
      const persist = createPersist(client, { workstreamId, sessionId: session, connectionId: 'conn-1', nowSql: db.nowSql, commandIdFor: () => null })
      const bigId = '9007199254740993'
      const frame = `{"jsonrpc":"2.0","method":"vendor/example","params":{"cursor":${bigId},"x":1}}`
      const persisted = await persist('agent_to_client', frame)
      assert.ok(persisted.seq > 0)

      // Reads that need fidelity select payload::text — the default jsonb → JS parse would round.
      const row = (await client.query('SELECT payload::text AS raw FROM workstream_facts WHERE workstream_id = $1 ORDER BY seq DESC LIMIT 1', [workstreamId])).rows[0]!
      assert.ok(String(row['raw']).includes(bigId), `the exact integer must survive: ${row['raw']}`)
      const lossy = (await client.query('SELECT payload FROM workstream_facts WHERE workstream_id = $1 ORDER BY seq DESC LIMIT 1', [workstreamId])).rows[0]!['payload']
      assert.equal(Number(lossy['params']['cursor']), 9007199254740992, 'the default read path is lossy — which is why the canonical value is the raw text')
    } finally {
      client.release()
    }
  })
})

test('two identical envelopes produce two facts — content is never a deduplication key', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await setup(db, client)
      const session = (await client.query('SELECT id FROM sessions WHERE workstream_id = $1', [workstreamId])).rows[0]!['id'] as string
      const persist = createPersist(client, { workstreamId, sessionId: session, connectionId: 'conn-1', nowSql: db.nowSql, commandIdFor: () => null })
      const frame = '{"jsonrpc":"2.0","method":"vendor/example"}'
      const first = await persist('agent_to_client', frame)
      const second = await persist('agent_to_client', frame)
      assert.notEqual(first.observationId, second.observationId)
      const count = (await client.query("SELECT count(*)::int AS n FROM workstream_facts WHERE workstream_id = $1 AND kind = 'acp.envelope'", [workstreamId])).rows[0]!['n']
      assert.equal(count, 2)
    } finally {
      client.release()
    }
  })
})

test('an invalid frame produces a content-free diagnostic and no fact', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await setup(db, client)
      const session = (await client.query('SELECT id FROM sessions WHERE workstream_id = $1', [workstreamId])).rows[0]!['id'] as string
      const persist = createPersist(client, { workstreamId, sessionId: session, connectionId: 'conn-1', nowSql: db.nowSql, commandIdFor: () => null })
      // A batch: rejected by stable v1.
      await assert.rejects(() => persist('agent_to_client', '[{"jsonrpc":"2.0","id":1,"method":"a"}]'), /acp_protocol_error:batch/)
      const facts = (await client.query("SELECT count(*)::int AS n FROM workstream_facts WHERE workstream_id = $1 AND kind = 'acp.envelope'", [workstreamId])).rows[0]!['n']
      assert.equal(facts, 0)
      const diagnostics = (await client.query('SELECT direction, error_class, size, digest FROM acp_diagnostics WHERE workstream_id = $1', [workstreamId])).rows[0]!
      assert.equal(diagnostics['error_class'], 'batch')
      assert.equal(diagnostics['direction'], 'agent_to_client')
      assert.ok(Number(diagnostics['size']) > 0)
      assert.match(String(diagnostics['digest']), /^[0-9a-f]{64}$/)
    } finally {
      client.release()
    }
  })
})

test('outbound commit is ordered before the transport write', async () => {
  await withTestDatabase(async (db) => {
    const client = await connect(db)
    try {
      const workstreamId = await setup(db, client)
      const session = (await client.query('SELECT id FROM sessions WHERE workstream_id = $1', [workstreamId])).rows[0]!['id'] as string
      const persist = createPersist(client, { workstreamId, sessionId: session, connectionId: 'conn-1', nowSql: db.nowSql, commandIdFor: () => null })

      const events: string[] = []
      const written: Uint8Array[] = []
      const persistSpy = async (direction: Parameters<typeof persist>[0], text: string): Promise<void> => {
        events.push(`persist:start`)
        await persist(direction, text)
        events.push(`persist:committed`)
      }

      const inner = {
        readable: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        writable: new WritableStream<Uint8Array>({
          write: async (chunk) => {
            events.push('forward')
            written.push(chunk)
          },
        }),
      }
      const journaled = journalDuplexStream(inner, persistSpy)
      const writer = journaled.writable.getWriter()
      await writer.write(new TextEncoder().encode('{"jsonrpc":"2.0","id":"req-9","method":"vendor/example"}\n'))
      await writer.close()

      assert.equal(written.length, 1, 'the frame was forwarded')
      const committedAt = events.indexOf('persist:committed')
      const forwardAt = events.indexOf('forward')
      assert.ok(committedAt !== -1 && forwardAt !== -1 && committedAt < forwardAt, `commit must precede forward: ${events.join(',')}`)
    } finally {
      client.release()
    }
  })
})
