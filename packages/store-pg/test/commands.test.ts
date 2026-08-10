import assert from 'node:assert/strict'
import { test } from 'node:test'
import { principalId, workstreamId } from '@agora/domain'
import { createOrReuseCommand, failStrandedPromptCommands, transitionCommandState } from '../src/commands.js'
import { bindAcpSession, bindCapabilities } from '../src/sessions.js'
import { createWorkstreamWithFirstSession } from '../src/workstreams.js'
import { randomId, withTestDatabase } from './support.js'

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
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: new Date() },
      session: { id: randomId() as never, ordinal: 1, launchEnvelope: launchEnvelope() },
      runtimeDefinitionVersion: 'v3',
    })
    return wsId as string
  } finally {
    client.release()
  }
}

test('required: a duplicate command (same idempotency scope/key) does not duplicate the row — same command returned', async () => {
  await withTestDatabase(async (pool) => {
    const wsId = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      const input = {
        type: 'RenameWorkstream' as const,
        workstreamId: workstreamId(wsId),
        actor: { kind: 'human' as const, id: principalId('alice') },
        idempotencyScope: 'rename',
        idempotencyKey: 'retry-key-1',
        acceptedAt: new Date(),
        request: { title: 'New title' },
      }
      const first = await createOrReuseCommand(client, input)
      const second = await createOrReuseCommand(client, input)
      assert.equal(first.id, second.id)

      const { rows } = await client.query('SELECT * FROM product.commands WHERE workstream_id = $1', [wsId])
      assert.equal(rows.length, 1)
    } finally {
      client.release()
    }
  })
})

test('required: concurrent identical retries collapse to one command row (DB UNIQUE constraint is the race-safe source of truth)', async () => {
  await withTestDatabase(async (pool) => {
    const wsId = await seedWorkstream(pool)
    const clients = await Promise.all(Array.from({ length: 8 }, () => pool.connect()))
    try {
      const input = {
        type: 'RenameWorkstream' as const,
        workstreamId: workstreamId(wsId),
        actor: { kind: 'human' as const, id: principalId('alice') },
        idempotencyScope: 'rename',
        idempotencyKey: 'race-key',
        acceptedAt: new Date(),
        request: { title: 'Racing title' },
      }
      const results = await Promise.all(clients.map((client) => createOrReuseCommand(client, input)))
      const ids = new Set(results.map((r) => r.id))
      assert.equal(ids.size, 1)

      const { rows } = await clients[0]!.query('SELECT * FROM product.commands WHERE workstream_id = $1 AND idempotency_key = $2', [
        wsId,
        'race-key',
      ])
      assert.equal(rows.length, 1)
    } finally {
      for (const client of clients) client.release()
    }
  })
})

test('command state transitions and typed completion', async () => {
  await withTestDatabase(async (pool) => {
    const wsId = await seedWorkstream(pool)
    const client = await pool.connect()
    try {
      const command = await createOrReuseCommand(client, {
        type: 'RenameWorkstream',
        workstreamId: workstreamId(wsId),
        actor: { kind: 'human', id: principalId('alice') },
        idempotencyScope: 'rename',
        idempotencyKey: 'key-2',
        acceptedAt: new Date(),
        request: {},
      })
      await transitionCommandState(client, command.id, 'dispatching', new Date())
      await transitionCommandState(client, command.id, 'failed', new Date(), { code: 'boom', detail: 'nope' })

      const { rows } = await client.query('SELECT state, error_code, completed_at FROM product.commands WHERE id = $1', [command.id])
      assert.equal(rows[0].state, 'failed')
      assert.equal(rows[0].error_code, 'boom')
      assert.notEqual(rows[0].completed_at, null)
    } finally {
      client.release()
    }
  })
})

/**
 * Seeds a Workstream plus its first Session, returning both ids — the stranded-prompt sweep works
 * on turns, which are keyed by Session as well as by Command.
 */
async function seedWorkstreamAndSession(pool: import('pg').Pool): Promise<{ workstreamId: string; sessionId: string }> {
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

test('required: startup sweep settles prompt Commands no live connection can ever finish, and closes their turns', async () => {
  await withTestDatabase(async (pool) => {
    const { workstreamId: wsId, sessionId } = await seedWorkstreamAndSession(pool)
    const client = await pool.connect()
    try {
      const makePrompt = async (key: string, state: 'accepted' | 'dispatching' | 'completed'): Promise<string> => {
        const command = await createOrReuseCommand(client, {
          type: 'PromptSession',
          workstreamId: workstreamId(wsId),
          sessionId: sessionId as never,
          actor: { kind: 'human', id: principalId('alice') },
          idempotencyScope: 'prompt',
          idempotencyKey: key,
          purpose: 'user',
          acceptedAt: new Date(),
          request: { prompt: [{ type: 'text', text: key }] },
        })
        if (state !== 'accepted') {
          await transitionCommandState(client, command.id, 'dispatching', new Date())
          if (state === 'completed') {
            await transitionCommandState(client, command.id, 'acknowledged', new Date())
            await transitionCommandState(client, command.id, 'completed', new Date())
          }
        }
        return command.id
      }

      // The two shapes seen on 2026-08-09: one prompt queued but never sent, one sent but never
      // answered. Plus a healthy completed one, which must be left strictly alone.
      const queued = await makePrompt('queued-never-sent', 'accepted')
      const sent = await makePrompt('sent-never-answered', 'dispatching')
      const done = await makePrompt('finished-normally', 'completed')

      let ordinal = 0
      for (const [id, ended] of [
        [queued, null],
        [sent, null],
        [done, new Date()],
      ] as const) {
        ordinal += 1
        await client.query(
          `INSERT INTO projection.turns (id, workstream_id, session_id, turn_ordinal, purpose, status,
                                         first_workstream_seq, latest_workstream_seq, started_at, ended_at)
           VALUES ($1, $2, $3, $4, 'user', $5, $6, $6, now(), $7)`,
          [id, wsId, sessionId, ordinal, ended ? 'completed' : 'running', ordinal, ended],
        )
      }

      // A Session left mid-turn: `busy` is what step 5 of docs/specs/03 sets, and nothing else
      // would ever clear it once the process holding the turn is gone. The DB will only accept
      // `busy` on a Session that is genuinely bound (001-initial.sql), so bind it the same way a
      // real bootstrap does rather than forcing the column.
      await bindCapabilities(client, sessionId, 'equipment-policy-v1', new Uint8Array(32).fill(7))
      await bindAcpSession(client, sessionId, randomId(), new Date())
      await client.query("UPDATE product.sessions SET phase = 'busy' WHERE id = $1", [sessionId])

      const swept = await failStrandedPromptCommands(client, new Date())
      assert.deepEqual(swept, { commands: 2, turns: 2, sessions: 1 })

      const { rows: phase } = await client.query<{ phase: string }>('SELECT phase FROM product.sessions WHERE id = $1', [sessionId])
      assert.equal(phase[0]?.phase, 'ready', 'a Session left busy by a dead process must be handed back, or it can never be reaped nor woken')

      const { rows } = await client.query<{ id: string; state: string; error_code: string | null; completed_at: Date | null }>(
        'SELECT id, state, error_code, completed_at FROM product.commands WHERE id = ANY($1::uuid[])',
        [[queued, sent, done]],
      )
      const byId = new Map(rows.map((r) => [r.id, r]))
      for (const id of [queued, sent]) {
        assert.equal(byId.get(id)?.state, 'failed')
        assert.equal(byId.get(id)?.error_code, 'runtime_connection_lost')
        assert.notEqual(byId.get(id)?.completed_at, null, 'a terminal Command must carry completed_at')
      }
      assert.equal(byId.get(done)?.state, 'completed', 'a finished prompt must not be touched by the sweep')
      assert.equal(byId.get(done)?.error_code, null)

      // The point of closing the turns: `listIdleSessions` skips any Session with an unfinished
      // turn, so leaving these open would keep the Session un-reapable forever.
      const { rows: turns } = await client.query<{ id: string; status: string; ended_at: Date | null }>(
        'SELECT id, status, ended_at FROM projection.turns WHERE id = ANY($1::uuid[])',
        [[queued, sent, done]],
      )
      for (const turn of turns) {
        assert.notEqual(turn.ended_at, null, `turn ${turn.id} was left open`)
      }
      assert.equal(turns.filter((t) => t.status === 'failed').length, 2)
    } finally {
      client.release()
    }
  })
})

test('required: the sweep is idempotent and touches nothing on a clean database', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      assert.deepEqual(await failStrandedPromptCommands(client, new Date()), { commands: 0, turns: 0, sessions: 0 })
    } finally {
      client.release()
    }
  })
})
