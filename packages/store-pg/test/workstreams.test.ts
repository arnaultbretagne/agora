import assert from 'node:assert/strict'
import { test } from 'node:test'
import { principalId, workstreamId } from '@agora/domain'
import { addWorkstreamMembership, createWorkstreamWithFirstSession, removeWorkstreamMembership, setCurrentSession } from '../src/workstreams.js'
import { randomId, withTestDatabase } from './support.js'

function launchEnvelope() {
  return {
    agentId: 'claude-code',
    workspaceSpec: { root: '/work' },
    equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
    runtimeDefinitionVersion: 'v3',
  }
}

test('createWorkstreamWithFirstSession is atomic and the first Session is current', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      const now = new Date('2026-08-03T00:00:00Z')
      const wsId = workstreamId(randomId())
      const sId = randomId()
      const { workstream, session } = await createWorkstreamWithFirstSession(client, {
        workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: now },
        session: { id: sId as never, ordinal: 1, launchEnvelope: launchEnvelope() },
        runtimeDefinitionVersion: 'v3',
      })
      assert.equal(workstream.currentSessionId, session.id)

      const { rows: wsRows } = await client.query('SELECT * FROM product.workstreams WHERE id = $1', [wsId])
      assert.equal(wsRows.length, 1)
      const { rows: memberRows } = await client.query('SELECT * FROM product.workstream_memberships WHERE workstream_id = $1', [wsId])
      assert.equal(memberRows.length, 1)
      assert.equal(memberRows[0].role, 'owner')
      const { rows: sessionRows } = await client.query('SELECT * FROM product.sessions WHERE id = $1', [sId])
      assert.equal(sessionRows.length, 1)
      assert.equal(sessionRows[0].is_current, true)
      assert.equal(sessionRows[0].phase, 'requested')
    } finally {
      client.release()
    }
  })
})

test('required: the last owner cannot be removed (application role denied by the domain guard)', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      const now = new Date()
      const wsId = workstreamId(randomId())
      await createWorkstreamWithFirstSession(client, {
        workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: now },
        session: { id: randomId() as never, ordinal: 1, launchEnvelope: launchEnvelope() },
        runtimeDefinitionVersion: 'v3',
      })
      await assert.rejects(
        () => removeWorkstreamMembership(client, wsId, principalId('alice')),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'workstream_last_owner_required',
      )
    } finally {
      client.release()
    }
  })
})

test('adding a second owner then removing the first succeeds', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      const now = new Date()
      const wsId = workstreamId(randomId())
      await createWorkstreamWithFirstSession(client, {
        workstream: { id: wsId, category: 'discussion', title: 'Hello', owner: principalId('alice'), createdAt: now },
        session: { id: randomId() as never, ordinal: 1, launchEnvelope: launchEnvelope() },
        runtimeDefinitionVersion: 'v3',
      })
      await addWorkstreamMembership(client, wsId, principalId('bob'), 'owner', now)
      await removeWorkstreamMembership(client, wsId, principalId('alice'))
      const { rows } = await client.query('SELECT principal_id FROM product.workstream_memberships WHERE workstream_id = $1', [wsId])
      assert.deepEqual(rows.map((r) => r.principal_id).sort(), ['bob'])
    } finally {
      client.release()
    }
  })
})

test('required: setCurrentSession rejects a Session from another Workstream, and a valid switch leaves exactly one current', async () => {
  await withTestDatabase(async (pool) => {
    const client = await pool.connect()
    try {
      const now = new Date()
      const wsAId = workstreamId(randomId())
      const { session: sessionA1 } = await createWorkstreamWithFirstSession(client, {
        workstream: { id: wsAId, category: 'discussion', title: 'A', owner: principalId('alice'), createdAt: now },
        session: { id: randomId() as never, ordinal: 1, launchEnvelope: launchEnvelope() },
        runtimeDefinitionVersion: 'v3',
      })
      const wsBId = workstreamId(randomId())
      const { session: sessionB1 } = await createWorkstreamWithFirstSession(client, {
        workstream: { id: wsBId, category: 'discussion', title: 'B', owner: principalId('bob'), createdAt: now },
        session: { id: randomId() as never, ordinal: 1, launchEnvelope: launchEnvelope() },
        runtimeDefinitionVersion: 'v3',
      })

      await assert.rejects(() => setCurrentSession(client, wsAId, sessionB1.id), /current_session_workstream_mismatch/)

      // Open a second Session on Workstream A and switch to it.
      const sessionA2Id = randomId()
      await client.query(
        `INSERT INTO product.sessions (id, workstream_id, ordinal, agent_id, phase, is_current, workspace_spec, equipment_request, runtime_definition_version, last_event_seq, created_at)
         VALUES ($1,$2,2,'claude-code','requested',false,'{}','{"catalogueVersion":"v1","resources":[]}','v3',0,$3)`,
        [sessionA2Id, wsAId, now],
      )
      await setCurrentSession(client, wsAId, sessionA2Id)

      const { rows } = await client.query('SELECT id, is_current FROM product.sessions WHERE workstream_id = $1', [wsAId])
      const current = rows.filter((r) => r.is_current)
      assert.equal(current.length, 1)
      assert.equal(current[0].id, sessionA2Id)
      void sessionA1
    } finally {
      client.release()
    }
  })
})

test('required: a concurrent current-Session switch leaves exactly one current', async () => {
  await withTestDatabase(async (pool) => {
    const setupClient = await pool.connect()
    const now = new Date()
    let wsId!: import('@agora/domain').WorkstreamId
    const candidateIds: string[] = []
    try {
      wsId = workstreamId(randomId())
      await createWorkstreamWithFirstSession(setupClient, {
        workstream: { id: wsId, category: 'discussion', title: 'Race', owner: principalId('alice'), createdAt: now },
        session: { id: randomId() as never, ordinal: 1, launchEnvelope: launchEnvelope() },
        runtimeDefinitionVersion: 'v3',
      })
      for (let ordinal = 2; ordinal <= 6; ordinal += 1) {
        const id = randomId()
        candidateIds.push(id)
        await setupClient.query(
          `INSERT INTO product.sessions (id, workstream_id, ordinal, agent_id, phase, is_current, workspace_spec, equipment_request, runtime_definition_version, last_event_seq, created_at)
           VALUES ($1,$2,$3,'claude-code','requested',false,'{}','{"catalogueVersion":"v1","resources":[]}','v3',0,$4)`,
          [id, wsId, ordinal, now],
        )
      }
    } finally {
      setupClient.release()
    }

    const clients = await Promise.all(candidateIds.map(() => pool.connect()))
    try {
      await Promise.all(candidateIds.map((id, i) => setCurrentSession(clients[i]!, wsId, id)))
      const verifyClient = await pool.connect()
      try {
        const { rows } = await verifyClient.query('SELECT id, is_current FROM product.sessions WHERE workstream_id = $1', [wsId])
        const current = rows.filter((r) => r.is_current)
        assert.equal(current.length, 1)
        assert.ok(candidateIds.includes(current[0].id))
      } finally {
        verifyClient.release()
      }
    } finally {
      for (const client of clients) client.release()
    }
  })
})
