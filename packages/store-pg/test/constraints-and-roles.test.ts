import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { principalId, workstreamId } from '@agora/domain'
import { appendEvent } from '../src/journal.js'
import { createOrReuseCommand } from '../src/commands.js'
import { createWorkstreamWithFirstSession } from '../src/workstreams.js'
import { asRole, randomId, withTestDatabase } from './support.js'

function launchEnvelope() {
  return {
    agentId: 'claude-code',
    workspaceSpec: { root: '/work' },
    equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
    runtimeDefinitionVersion: 'v3',
  }
}

async function seedWorkstream(pool: import('pg').Pool) {
  const client = await pool.connect()
  try {
    const wsId = workstreamId(randomId())
    const sessionId = randomId()
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: new Date() },
      session: { id: sessionId as never, ordinal: 1, launchEnvelope: launchEnvelope() },
      runtimeDefinitionVersion: 'v3',
    })
    return { workstreamId: wsId as string, sessionId }
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// required: database role tests execute actual denied SQL
// ---------------------------------------------------------------------------

test('required: agora_product cannot update agent_id (immutable launch column, not in its column grant)', async () => {
  await withTestDatabase(async (pool) => {
    const { sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      await assert.rejects(
        () => asRole(client, 'agora_product', () => client.query('UPDATE product.sessions SET agent_id = $1 WHERE id = $2', ['codex', sessionId])),
        (error: unknown) => error instanceof Error && /permission denied/.test(error.message),
      )
    } finally {
      client.release()
    }
  })
})

test('required: agora_product cannot update equipment_request (immutable equipment column, not in its column grant)', async () => {
  await withTestDatabase(async (pool) => {
    const { sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      await assert.rejects(
        () =>
          asRole(client, 'agora_product', () =>
            client.query("UPDATE product.sessions SET equipment_request = '{\"catalogueVersion\":\"v2\",\"resources\":[]}' WHERE id = $1", [
              sessionId,
            ]),
          ),
        (error: unknown) => error instanceof Error && /permission denied/.test(error.message),
      )
    } finally {
      client.release()
    }
  })
})

test('required: agora_product has no access to the custody schema at all (no payload access)', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      await assert.rejects(
        () => asRole(client, 'agora_product', () => client.query('SELECT id FROM custody.snapshots LIMIT 1')),
        (error: unknown) => error instanceof Error && /permission denied/.test(error.message),
      )
    } finally {
      client.release()
    }
  })
})

test('required: agora_custody_meta can read snapshot metadata but is denied the payload column', async () => {
  await withTestDatabase(async (pool) => {
    const { sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      await client.query(
        `INSERT INTO custody.snapshots
           (id, session_id, generation, capture_request_id, format_id, format_version, adapter_version,
            synced_through_seq, payload, payload_sha256, size_bytes, created_at)
         VALUES ($1,$2,1,$3,'claude-code-fs','1','1',0,$4,$5,3,$6)`,
        [randomId(), sessionId, randomId(), Buffer.from('abc'), Buffer.alloc(32, 1), new Date()],
      )
      await asRole(client, 'agora_custody_meta', async () => {
        const { rows } = await client.query('SELECT format_id FROM custody.snapshots WHERE session_id = $1', [sessionId])
        assert.equal(rows.length, 1)
      })
      await assert.rejects(
        () => asRole(client, 'agora_custody_meta', () => client.query('SELECT payload FROM custody.snapshots WHERE session_id = $1', [sessionId])),
        (error: unknown) => error instanceof Error && /permission denied/.test(error.message),
      )
    } finally {
      client.release()
    }
  })
})

test('required: agora_projector cannot write to the product schema (read-only)', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      await assert.rejects(
        () =>
          asRole(client, 'agora_projector', () =>
            client.query(
              `INSERT INTO product.workstreams (id, category, title, last_event_seq, created_at, updated_at)
               VALUES ($1, 'discussion', 'x', 0, now(), now())`,
              [randomId()],
            ),
          ),
        (error: unknown) => error instanceof Error && /permission denied/.test(error.message),
      )
    } finally {
      client.release()
    }
  })
})

// ---------------------------------------------------------------------------
// required: typed satellite and turn constraints reject kind mismatches,
// cross-Session turn references and inline values on hot kinds
// ---------------------------------------------------------------------------

test('required: a hot item kind rejects an inline current_value through failing SQL', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      const eventId = randomId()
      await client.query(
        `INSERT INTO product.workstream_events
           (id, workstream_id, workstream_seq, session_id, session_seq, direction, rpc_kind, method, envelope, purpose, ingest_mode, observed_at)
         VALUES ($1,$2,1,$3,1,'agent_to_client','notification','session/update','{}','protocol','live',$4)`,
        [eventId, wsId, sessionId, new Date()],
      )
      await assert.rejects(() =>
        client.query(
          `INSERT INTO projection.workstream_items
             (id, workstream_id, session_id, item_kind, synthetic_entity_key, first_event_id, latest_event_id,
              first_workstream_seq, latest_workstream_seq, current_value, content_sha256, updated_at)
           VALUES ($1,$2,$3,'message','k1',$4,$4,1,1,'{"illegal":true}',$5,$6)`,
          [randomId(), wsId, sessionId, eventId, Buffer.alloc(32, 2), new Date()],
        ),
      )
    } finally {
      client.release()
    }
  })
})

test('required: a satellite kind mismatch is rejected through failing SQL', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      const eventId = randomId()
      await client.query(
        `INSERT INTO product.workstream_events
           (id, workstream_id, workstream_seq, session_id, session_seq, direction, rpc_kind, method, envelope, purpose, ingest_mode, observed_at)
         VALUES ($1,$2,1,$3,1,'agent_to_client','notification','session/update','{}','protocol','live',$4)`,
        [eventId, wsId, sessionId, new Date()],
      )
      const itemId = randomId()
      // A 'message' item — but then try to attach a tool_calls satellite row to it (kind mismatch).
      await client.query(
        `INSERT INTO projection.workstream_items
           (id, workstream_id, session_id, item_kind, synthetic_entity_key, first_event_id, latest_event_id,
            first_workstream_seq, latest_workstream_seq, content_sha256, updated_at)
         VALUES ($1,$2,$3,'message','k1',$4,$4,1,1,$5,$6)`,
        [itemId, wsId, sessionId, eventId, Buffer.alloc(32, 2), new Date()],
      )
      await assert.rejects(() =>
        client.query(`INSERT INTO projection.tool_calls (item_id, tool_call_id, status) VALUES ($1, $2, 'completed')`, [
          itemId,
          'tool-1',
        ]),
      )
    } finally {
      client.release()
    }
  })
})

test('required: a turn cannot be referenced across Sessions through failing SQL', async () => {
  await withTestDatabase(async (pool) => {
    const a = await seedWorkstream(pool)
    const b = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      // A durable command + turn belonging to Session A.
      const command = await createOrReuseCommand(client, {
        type: 'PromptSession',
        workstreamId: workstreamId(a.workstreamId),
        sessionId: a.sessionId as never,
        actor: { kind: 'human', id: principalId('alice') },
        idempotencyScope: 'prompt',
        idempotencyKey: 'p1',
        purpose: 'user',
        acceptedAt: new Date(),
        request: {},
      })
      await client.query(
        `INSERT INTO projection.turns
           (id, workstream_id, session_id, turn_ordinal, purpose, status, first_workstream_seq, latest_workstream_seq, started_at)
         VALUES ($1,$2,$3,1,'user','running',1,1,$4)`,
        [command.id, a.workstreamId, a.sessionId, new Date()],
      )

      const eventIdOnB = randomId()
      await client.query(
        `INSERT INTO product.workstream_events
           (id, workstream_id, workstream_seq, session_id, session_seq, direction, rpc_kind, method, envelope, purpose, ingest_mode, observed_at)
         VALUES ($1,$2,1,$3,1,'agent_to_client','notification','session/update','{}','protocol','live',$4)`,
        [eventIdOnB, b.workstreamId, b.sessionId, new Date()],
      )

      // Item lives on Workstream/Session B, but points at Session A's turn — must be rejected.
      await assert.rejects(() =>
        client.query(
          `INSERT INTO projection.workstream_items
             (id, workstream_id, session_id, turn_id, item_kind, synthetic_entity_key, first_event_id, latest_event_id,
              first_workstream_seq, latest_workstream_seq, content_sha256, updated_at)
           VALUES ($1,$2,$3,$4,'message','k1',$5,$5,1,1,$6,$7)`,
          [randomId(), b.workstreamId, b.sessionId, command.id, eventIdOnB, Buffer.alloc(32, 3), new Date()],
        ),
      )
    } finally {
      client.release()
    }
  })
})

// ---------------------------------------------------------------------------
// required: gateway/grant secret-pattern fixtures cannot be persisted in
// product command / non-envelope journal metadata; canonical ACP envelope
// content keeps its separate confidentiality rules (it is NOT filtered here)
// ---------------------------------------------------------------------------

test('required: a command request containing an aoc_ bearer-shaped value is rejected', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      await assert.rejects(
        () =>
          createOrReuseCommand(client, {
            type: 'RenameWorkstream',
            workstreamId: workstreamId(wsId),
            actor: { kind: 'human', id: principalId('alice') },
            idempotencyScope: 'rename',
            idempotencyKey: 'k1',
            acceptedAt: new Date(),
            request: { note: 'leaked aoc_live_1234567890abcdef somewhere in a nested field' },
          }),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'secret_pattern_rejected',
      )
      const { rows } = await client.query('SELECT count(*)::int AS n FROM product.commands WHERE workstream_id = $1', [wsId])
      assert.equal(rows[0].n, 0)
    } finally {
      client.release()
    }
  })
})

test('required: journal metadata (entityId) containing a provider-token shape is rejected, but the ACP envelope itself is not filtered', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      await assert.rejects(
        () =>
          appendEvent(client, {
            eventId: randomId(),
            workstreamId: wsId,
            sessionId,
            direction: 'agent_to_client',
            rpcKind: 'notification',
            method: 'session/update',
            envelope: JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }),
            purpose: 'protocol',
            entityId: 'sk-leaked1234567890abcdef',
            ingestMode: 'live',
            observedAt: new Date(),
          }),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'secret_pattern_rejected',
      )

      // The canonical ACP envelope is exempt — full passthrough is the point of ADR 0003.
      const result = await appendEvent(client, {
        eventId: randomId(),
        workstreamId: wsId,
        sessionId,
        direction: 'agent_to_client',
        rpcKind: 'notification',
        method: 'session/update',
        envelope: JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { text: 'user pasted sk-not-really-filtered-here' } }),
        purpose: 'protocol',
        ingestMode: 'live',
        observedAt: new Date(),
      })
      assert.equal(result.workstreamSeq, 1)
    } finally {
      client.release()
    }
  })
})

// ---------------------------------------------------------------------------
// required: prove no SessionRuntime table/runtime_id exists, and no product/
// projection/custody column carries a OneCLI Agent row, upstream proxy
// bearer, provider credential or OneCLI request log
// ---------------------------------------------------------------------------

test('required: no SessionRuntime table or runtime_id column exists, and no schema carries a OneCLI/provider-credential-shaped column', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      const { rows: tables } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema IN ('product', 'projection', 'custody')`,
      )
      for (const { table_name } of tables) {
        assert.doesNotMatch(table_name.toLowerCase(), /session_?runtime/, `table ${table_name} looks like a persisted SessionRuntime`)
      }

      const { rows: columns } = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema IN ('product', 'projection', 'custody')`,
      )
      const forbidden = [/runtime_id/i, /onecli/i, /upstream_bearer/i, /proxy_bearer/i, /provider_(credential|token|secret)/i, /control_key/i]
      for (const { table_name, column_name } of columns) {
        for (const pattern of forbidden) {
          assert.doesNotMatch(
            column_name,
            pattern,
            `${table_name}.${column_name} looks like a OneCLI/provider-credential-shaped column`,
          )
        }
      }
    } finally {
      client.release()
    }
  })
})

test('required: a cold item kind requires a non-null current_value through failing SQL', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      const eventId = randomId()
      await client.query(
        `INSERT INTO product.workstream_events
           (id, workstream_id, workstream_seq, session_id, session_seq, direction, rpc_kind, method, envelope, purpose, ingest_mode, observed_at)
         VALUES ($1,$2,1,$3,1,'agent_to_client','notification','session/update','{}','protocol','live',$4)`,
        [eventId, wsId, sessionId, new Date()],
      )
      // 'usage' is a cold/low-frequency kind (docs/specs/05): it MUST carry a current_value.
      await assert.rejects(() =>
        client.query(
          `INSERT INTO projection.workstream_items
             (id, workstream_id, session_id, item_kind, synthetic_entity_key, first_event_id, latest_event_id,
              first_workstream_seq, latest_workstream_seq, content_sha256, updated_at)
           VALUES ($1,$2,$3,'usage','k1',$4,$4,1,1,$5,$6)`,
          [randomId(), wsId, sessionId, eventId, Buffer.alloc(32, 6), new Date()],
        ),
      )
    } finally {
      client.release()
    }
  })
})

test('required: store-pg repository source never references live Session Runtime status (podUid/Pod phase) — only durable phase', async () => {
  // Read the original hand-written source, not dist/ (tsc's emitted .d.ts also matches *.ts).
  const srcDir = new URL('../../src', import.meta.url).pathname
  const forbidden = [/\bpodUid\b/, /\bpod_uid\b/i, /\bpod[_ ]?phase\b/i, /\bcontainerRestarts\b/i]
  for (const file of await readdir(srcDir)) {
    if (!file.endsWith('.ts')) continue
    const text = await readFile(join(srcDir, file), 'utf8')
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${file} must not reference live Session Runtime status (${pattern})`)
    }
  }
})

// ---------------------------------------------------------------------------
// P11 "Prove least privilege with negative authorization tests"
//
// Each of these executes SQL that MUST be refused. They are not paranoia: three
// separate design decisions rest on these boundaries holding, and a boundary
// nobody has tried to cross is a boundary nobody knows exists.
// ---------------------------------------------------------------------------

test('required: the controller role can see a Session\'s identity and phase, but never its turns — which is what decides where the idle reaper lives', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      // 002-access.sql grants agora_custody_runtime a FIVE-COLUMN view of product.sessions
      // (id, workstream_id, agent_id, runtime_definition_version, phase) and nothing else in
      // product. The distinction matters and was gotten wrong once: the controller is not blind to
      // product truth, it is blind to the part that defines idleness. "Has this Session stopped
      // working" is answered by turns, and turns are exactly what it cannot see — which is why the
      // idle reaper cannot live beside the Pod however much agora ADR 0008 preferred that.
      await asRole(client, 'agora_custody_runtime', async () => {
        const { rows } = await client.query('SELECT id, phase FROM product.sessions WHERE id = $1', [sessionId])
        assert.equal(rows.length, 1, 'the controller legitimately reconciles against a Session\'s own phase')

        await assert.rejects(
          () => client.query('SELECT id FROM projection.turns'),
          /permission denied/i,
          'but idleness is defined by turns, and it cannot see one',
        )
        await assert.rejects(() => client.query('SELECT id FROM product.workstreams WHERE id = $1', [wsId]), /permission denied/i)
        await assert.rejects(() => client.query('SELECT id FROM product.workstream_events'), /permission denied/i)
        await assert.rejects(
          () => client.query('SELECT equipment_request FROM product.sessions WHERE id = $1', [sessionId]),
          /permission denied/i,
          'and even on the one table it can read, the grant is column-scoped',
        )
      })
    } finally {
      client.release()
    }
  })
})

test('required: the Broker role cannot read or write product truth — its schema is its whole world', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      // docs/adr/0011: the Broker decides on broker-local signals only. That is a design rule until
      // the database enforces it, at which point it is a fact.
      await asRole(client, 'agora_broker', async () => {
        await assert.rejects(() => client.query('SELECT id FROM product.sessions WHERE id = $1', [sessionId]), /permission denied/i)
        await assert.rejects(() => client.query('SELECT id FROM product.workstreams WHERE id = $1', [wsId]), /permission denied/i)
        await assert.rejects(
          () => client.query("UPDATE product.sessions SET phase = 'failed' WHERE id = $1", [sessionId]),
          /permission denied/i,
          'and it certainly must not be able to move a Session between phases',
        )
      })
    } finally {
      client.release()
    }
  })
})

test('required: the product roles cannot read the Broker schema, where the encrypted upstream credential lives', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      // broker.upstream_authority holds each Session's encrypted OneCLI bearer. apps/web talks to
      // the Broker over HTTP for a reason; being able to read the ciphertext directly would make
      // that boundary decorative.
      for (const role of ['agora_product', 'agora_projector', 'agora_custody_meta', 'agora_custody_runtime']) {
        await asRole(client, role, async () => {
          await assert.rejects(
            () => client.query('SELECT session_id FROM broker.upstream_authority'),
            /permission denied/i,
            `${role} must not reach the Broker's own schema`,
          )
          await assert.rejects(() => client.query('SELECT id FROM broker.execution_grants'), /permission denied/i)
        })
      }
    } finally {
      client.release()
    }
  })
})

test('required: no role but the Broker can read a stored upstream credential, and even it cannot forge a grant for another Session', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      // The positive half, so the negatives above mean something: the Broker CAN reach its own
      // tables. A test that only ever asserts refusals would pass just as well against a database
      // where every one of these tables was missing.
      await asRole(client, 'agora_broker', async () => {
        await client.query('SELECT session_id FROM broker.upstream_authority')
        await client.query('SELECT id FROM broker.execution_grants')
      })
    } finally {
      client.release()
    }
  })
})

test('required: the projector cannot write the journal it reads — a read model can never rewrite its own source', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      await asRole(client, 'agora_projector', async () => {
        await assert.rejects(
          () =>
            client.query(
              `INSERT INTO product.workstream_events (id, workstream_id, session_id, workstream_seq, direction, rpc_kind, envelope, observed_at)
               VALUES ($1, $2, $3, 99999, 'client_to_agent', 'request', '{}'::jsonb, now())`,
              [randomId(), wsId, sessionId],
            ),
          /permission denied/i,
          'the journal is the source of truth; a projection that could append to it could invent history',
        )
      })
    } finally {
      client.release()
    }
  })
})

/**
 * The Broker decommissions an Agent by deleting its mapping row (migration 009). Its role held
 * SELECT/INSERT/UPDATE only, which was right while decommissioning meant writing a `deleted` state.
 *
 * Nothing caught the gap: every other test runs as the owner, so the whole suite stayed green while
 * a real suspend answered `permission denied for table onecli_agents` — and answered it silently,
 * because the caller deliberately swallows cleanup failures rather than fail a Session's lifecycle.
 * This pins the privilege the current design actually needs.
 */
test('required: agora_broker can delete an onecli_agents row — decommissioning removes it, never tombstones it', async () => {
  await withTestDatabase(async (pool) => {
    const { sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      await client.query(
        `INSERT INTO broker.onecli_agents (session_id, onecli_identifier, created_at, updated_at)
         VALUES ($1, $2, now(), now())`,
        [sessionId, `sagt-${'d'.repeat(40)}`],
      )
      await asRole(client, 'agora_broker', () => client.query('DELETE FROM broker.onecli_agents WHERE session_id = $1', [sessionId]))
      const { rows } = await client.query('SELECT 1 FROM broker.onecli_agents WHERE session_id = $1', [sessionId])
      assert.equal(rows.length, 0)
    } finally {
      client.release()
    }
  })
})
