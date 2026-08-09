import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { principalId, workstreamId } from '@agora/domain'
import { createWorkstreamWithFirstSession, patchWorkstreamMetadata } from '../src/workstreams.js'
import { appendEvent } from '../src/journal.js'
import { projectWorkstream } from '../src/projector.js'
import { getWorkstreamDetail, listWorkstreamsForPrincipal } from '../src/reads.js'
import { migrate } from '../src/migrate.js'
import {
  deleteSessionConfigIntent,
  getAgentConfigCatalogue,
  listSessionConfigIntent,
  markSessionConfigIntentApplied,
  putAgentConfigCatalogue,
  putSessionConfigIntent,
} from '../src/config-options.js'
import { randomId, withTestDatabase } from './support.js'

/** The exact shape both shipped Agents advertise (see each agent's own SPIKE.md: `model` and `effort` selects). */
const ADVERTISED = [
  {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue: 'sonnet',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'opus', name: 'Opus' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    type: 'select',
    category: 'thought_level',
    currentValue: 'high',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  },
]

function launchEnvelope(agentId = 'claude-code') {
  return {
    agentId,
    workspaceSpec: { root: '/work' },
    equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
    runtimeDefinitionVersion: 'v1',
  }
}

async function seedWorkstream(pool: pg.Pool, options: { owner?: string; title?: string; agentId?: string } = {}) {
  const client = await pool.connect()
  try {
    const wsId = workstreamId(randomId())
    const sessionId = randomId()
    await createWorkstreamWithFirstSession(client, {
      workstream: {
        id: wsId,
        category: 'discussion',
        title: options.title ?? 'Première question posée',
        owner: principalId(options.owner ?? 'alice'),
        createdAt: new Date(),
      },
      session: { id: sessionId as never, ordinal: 1, launchEnvelope: launchEnvelope(options.agentId) },
      runtimeDefinitionVersion: 'v1',
    })
    return { workstreamId: wsId as string, sessionId }
  } finally {
    client.release()
  }
}

test('the catalogue stores what the Agent advertised and strips currentValue (one Session’s state is not a catalogue entry)', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      const written = await putAgentConfigCatalogue(client, {
        agentId: 'claude-code',
        runtimeDefinitionVersion: 'v1',
        options: ADVERTISED,
        observedAt: new Date('2026-08-07T10:00:00Z'),
      })
      assert.equal(written, true)

      const catalogue = await getAgentConfigCatalogue(client, 'claude-code', 'v1')
      assert.equal(catalogue?.options.length, 2)
      for (const option of catalogue!.options) {
        assert.ok(!('currentValue' in option), `currentValue leaked into the catalogue: ${JSON.stringify(option)}`)
      }
      // Everything else survives verbatim — the values are what the selector renders.
      assert.deepEqual((catalogue!.options[0] as { options: unknown }).options, ADVERTISED[0]!.options)
      assert.equal((catalogue!.options[1] as { category: string }).category, 'thought_level')
    } finally {
      client.release()
    }
  })
})

test('an empty or non-array advertisement never replaces a real one', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      await putAgentConfigCatalogue(client, { agentId: 'a', runtimeDefinitionVersion: 'v1', options: ADVERTISED, observedAt: new Date() })
      assert.equal(await putAgentConfigCatalogue(client, { agentId: 'a', runtimeDefinitionVersion: 'v1', options: [], observedAt: new Date() }), false)
      assert.equal(
        await putAgentConfigCatalogue(client, { agentId: 'a', runtimeDefinitionVersion: 'v1', options: undefined, observedAt: new Date() }),
        false,
      )
      const catalogue = await getAgentConfigCatalogue(client, 'a', 'v1')
      assert.equal(catalogue?.options.length, 2)
    } finally {
      client.release()
    }
  })
})

test('the catalogue is per runtime-definition version, and an older observation never overwrites a newer one', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      await putAgentConfigCatalogue(client, {
        agentId: 'claude-code',
        runtimeDefinitionVersion: 'v2',
        options: [{ id: 'model', name: 'Model', options: [{ value: 'opus-5', name: 'Opus 5' }] }],
        observedAt: new Date('2026-08-07T12:00:00Z'),
      })
      // A late-arriving observation from BEFORE the one already recorded must not win.
      await putAgentConfigCatalogue(client, {
        agentId: 'claude-code',
        runtimeDefinitionVersion: 'v2',
        options: [{ id: 'model', name: 'Model', options: [{ value: 'stale', name: 'Stale' }] }],
        observedAt: new Date('2026-08-07T11:00:00Z'),
      })
      const v2 = await getAgentConfigCatalogue(client, 'claude-code', 'v2')
      assert.equal(((v2!.options[0] as { options: { value: string }[] }).options)[0]?.value, 'opus-5')
      // A different version of the same Agent is a different memo, not an overwrite.
      assert.equal(await getAgentConfigCatalogue(client, 'claude-code', 'v1'), undefined)
    } finally {
      client.release()
    }
  })
})

test('intent survives as desired state: recorded, marked applied, and re-recording clears the applied mark', async () => {
  await withTestDatabase(async (pool) => {
    const { sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      await putSessionConfigIntent(client, { sessionId, optionId: 'model', value: 'opus', requestedAt: new Date('2026-08-07T10:00:00Z') })
      await putSessionConfigIntent(client, { sessionId, optionId: 'fast', value: true, requestedAt: new Date('2026-08-07T10:00:01Z') })

      let intents = await listSessionConfigIntent(client, sessionId)
      assert.deepEqual(
        intents.map((i) => [i.optionId, i.value, i.appliedAt]),
        [
          ['model', 'opus', null],
          ['fast', true, null],
        ],
      )

      await markSessionConfigIntentApplied(client, { sessionId, optionId: 'model', value: 'opus', appliedAt: new Date('2026-08-07T10:00:05Z') })
      intents = await listSessionConfigIntent(client, sessionId)
      assert.ok(intents.find((i) => i.optionId === 'model')?.appliedAt instanceof Date)

      // Asking for something else is a new, unapplied intent — not an edit of an applied one.
      await putSessionConfigIntent(client, { sessionId, optionId: 'model', value: 'sonnet', requestedAt: new Date('2026-08-07T10:01:00Z') })
      intents = await listSessionConfigIntent(client, sessionId)
      const model = intents.find((i) => i.optionId === 'model')
      assert.equal(model?.value, 'sonnet')
      assert.equal(model?.appliedAt, null)
    } finally {
      client.release()
    }
  })
})

test('applying and forgetting are scoped to the exact value, so a slower call cannot settle a newer choice', async () => {
  await withTestDatabase(async (pool) => {
    const { sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      await putSessionConfigIntent(client, { sessionId, optionId: 'model', value: 'sonnet', requestedAt: new Date() })
      // The operator changed their mind while 'opus' was in flight; the in-flight call's success
      // must not mark THIS choice applied, nor must its refusal delete it.
      await markSessionConfigIntentApplied(client, { sessionId, optionId: 'model', value: 'opus', appliedAt: new Date() })
      assert.equal((await listSessionConfigIntent(client, sessionId))[0]?.appliedAt, null)

      await deleteSessionConfigIntent(client, sessionId, 'model', 'opus')
      assert.equal((await listSessionConfigIntent(client, sessionId)).length, 1)

      await deleteSessionConfigIntent(client, sessionId, 'model', 'sonnet')
      assert.equal((await listSessionConfigIntent(client, sessionId)).length, 0)
    } finally {
      client.release()
    }
  })
})

test('deleting a Session takes its configuration intent with it', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      await putSessionConfigIntent(client, { sessionId, optionId: 'model', value: 'opus', requestedAt: new Date() })
      await client.query('DELETE FROM product.workstreams WHERE id = $1', [wsId])
      const { rows } = await client.query('SELECT 1 FROM product.session_config_intent WHERE session_id = $1', [sessionId])
      assert.equal(rows.length, 0)
    } finally {
      client.release()
    }
  })
})

/**
 * The title an Agent gives itself is the whole point of P12's second half: every Workstream in
 * production was called `Untitled` while both Agents were already publishing a real title over ACP.
 */
async function appendSessionInfoTitle(pool: pg.Pool, wsId: string, sessionId: string, title: string | null, at: Date): Promise<void> {
  const client = await pool.connect()
  try {
    await appendEvent(client, {
      eventId: randomId(),
      workstreamId: wsId,
      sessionId,
      direction: 'agent_to_client',
      rpcKind: 'notification',
      method: 'session/update',
      envelope: JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'acp-1', update: { sessionUpdate: 'session_info_update', title, updatedAt: at.toISOString() } },
      }),
      purpose: 'protocol',
      ingestMode: 'live',
      observedAt: at,
    })
  } finally {
    client.release()
  }
  const projectClient = await pool.connect()
  try {
    await projectWorkstream(projectClient, wsId, at)
  } finally {
    projectClient.release()
  }
}

test('a Workstream is named by its Agent, over the first-message floor, in both the list and the detail read', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool, { title: 'Compare une bolée et un bol' })

    const before = await pool.connect().then(async (c) => {
      try {
        return await listWorkstreamsForPrincipal(c, 'alice', { limit: 10 })
      } finally {
        c.release()
      }
    })
    assert.equal(before.items[0]?.title, 'Compare une bolée et un bol', 'the floor is the first message, never the literal "Untitled"')

    await appendSessionInfoTitle(pool, wsId, sessionId, 'Bolée vs bol à cidre', new Date('2026-08-07T10:00:00Z'))

    const client = await pool.connect()
    try {
      const list = await listWorkstreamsForPrincipal(client, 'alice', { limit: 10 })
      assert.equal(list.items[0]?.title, 'Bolée vs bol à cidre')
      const detail = await getWorkstreamDetail(client, wsId, 'alice')
      assert.equal(detail?.title, 'Bolée vs bol à cidre')

      // The subject drifts and the Agent renames it — the newest journal position wins.
      await appendSessionInfoTitle(pool, wsId, sessionId, 'Cidre breton', new Date('2026-08-07T11:00:00Z'))
      const later = await listWorkstreamsForPrincipal(client, 'alice', { limit: 10 })
      assert.equal(later.items[0]?.title, 'Cidre breton')
    } finally {
      client.release()
    }
  })
})

test('a manual rename outranks the Agent, before and after it publishes a title', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool, { title: 'floor' })
    const client = await pool.connect()
    try {
      await patchWorkstreamMetadata(client, wsId, { title: 'Mon titre à moi' })
      await appendSessionInfoTitle(pool, wsId, sessionId, 'Ce que le harness aurait choisi', new Date('2026-08-07T10:00:00Z'))

      const detail = await getWorkstreamDetail(client, wsId, 'alice')
      assert.equal(detail?.title, 'Mon titre à moi')
      const list = await listWorkstreamsForPrincipal(client, 'alice', { limit: 10 })
      assert.equal(list.items[0]?.title, 'Mon titre à moi')
    } finally {
      client.release()
    }
  })
})

test('a cleared or blank Agent title falls back to the stored one instead of showing an empty sidebar row', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool, { title: 'Première question posée' })
    await appendSessionInfoTitle(pool, wsId, sessionId, '   ', new Date('2026-08-07T10:00:00Z'))
    const client = await pool.connect()
    try {
      assert.equal((await getWorkstreamDetail(client, wsId, 'alice'))?.title, 'Première question posée')
    } finally {
      client.release()
    }
  })
})

/**
 * The migration's own backfill: the shipped Agents have been answering `session/new` for weeks, so
 * their advertisements are already in the journal and no empty run should be needed for them.
 */
test('migration backfills the catalogue from `session/new` responses already in the journal', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstream(pool, { agentId: 'claude-code' })
    const client = await pool.connect()
    try {
      await appendEvent(client, {
        eventId: randomId(),
        workstreamId: wsId,
        sessionId,
        direction: 'agent_to_client',
        rpcKind: 'response',
        rpcId: 2,
        envelope: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'acp-1', configOptions: ADVERTISED } }),
        purpose: 'protocol',
        ingestMode: 'live',
        observedAt: new Date('2026-08-06T09:00:00Z'),
      })
      // Re-run the migration as a fresh deployment would: drop the (empty) table and its record so
      // 008 executes against a database that already holds real journal history.
      await client.query('DROP TABLE product.agent_config_catalogue, product.session_config_intent')
      await client.query("DELETE FROM public.schema_migrations WHERE filename = '008-session-configuration.sql'")
    } finally {
      client.release()
    }

    await migrate(pool)

    const readClient = await pool.connect()
    try {
      const catalogue = await getAgentConfigCatalogue(readClient, 'claude-code', 'v1')
      assert.ok(catalogue, 'the Agent that has already run needs no empty run')
      assert.deepEqual(
        catalogue!.options.map((o) => (o as { id: string }).id),
        ['model', 'effort'],
      )
      for (const option of catalogue!.options) assert.ok(!('currentValue' in option))
    } finally {
      readClient.release()
    }
  })
})
