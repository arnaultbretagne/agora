import type { PoolClient } from 'pg'
import {
  addMembership,
  createWorkstream,
  openSession,
  removeMembership,
  type CreateWorkstreamInput,
  type OpenSessionInput,
  type PrincipalId,
  type Session,
  type WorkstreamMembershipRole,
  type Workstream,
} from '@agora/domain'

export interface CreateWorkstreamWithFirstSessionInput {
  readonly workstream: CreateWorkstreamInput
  readonly session: Omit<OpenSessionInput, 'workstreamId'>
  readonly runtimeDefinitionVersion: string
}

/**
 * A Workstream is always created atomically with its owner membership and first Session intent
 * (docs/specs/02-domain-model.md). The first Session of a fresh Workstream is its current Session.
 */
export async function createWorkstreamWithFirstSession(
  client: PoolClient,
  input: CreateWorkstreamWithFirstSessionInput,
): Promise<{ workstream: Workstream; session: Session }> {
  const workstream = createWorkstream(input.workstream)
  const session = openSession({ ...input.session, workstreamId: workstream.id })
  const owner = workstream.memberships[0]
  if (!owner) throw new Error('unreachable: createWorkstream always seeds one owner membership')

  await client.query('BEGIN')
  try {
    await client.query(
      `INSERT INTO product.workstreams
         (id, category, title, title_source, pinned, last_event_seq, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $6)`,
      [workstream.id, workstream.category, workstream.title, workstream.titleSource, workstream.pinned, input.workstream.createdAt],
    )
    await client.query(
      `INSERT INTO product.workstream_memberships (workstream_id, principal_id, role, added_at)
       VALUES ($1, $2, $3, $4)`,
      [workstream.id, owner.principalId, owner.role, owner.addedAt],
    )
    await client.query(
      `INSERT INTO product.sessions
         (id, workstream_id, ordinal, agent_id, phase, is_current, workspace_spec, equipment_request,
          runtime_definition_version, last_event_seq, created_at)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, 0, $9)`,
      [
        session.id,
        workstream.id,
        session.ordinal,
        session.agentId,
        session.phase,
        JSON.stringify(session.launchEnvelope.workspaceSpec),
        JSON.stringify(session.launchEnvelope.equipmentRequest),
        input.runtimeDefinitionVersion,
        input.workstream.createdAt,
      ],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }

  return { workstream: { ...workstream, currentSessionId: session.id }, session }
}

interface MembershipRow {
  readonly principal_id: string
  readonly role: WorkstreamMembershipRole
}

async function loadMemberships(client: PoolClient, workstreamId: string): Promise<Workstream['memberships']> {
  const { rows } = await client.query<MembershipRow & { added_at: Date }>(
    `SELECT principal_id, role, added_at FROM product.workstream_memberships
     WHERE workstream_id = $1 ORDER BY added_at`,
    [workstreamId],
  )
  return rows.map((row) => ({
    principalId: row.principal_id as PrincipalId,
    role: row.role,
    addedAt: row.added_at,
  }))
}

/**
 * Row-locks the Workstream first (docs/specs/02: "membership mutation locks the Workstream before
 * counting owners") so concurrent demotions/removals cannot both leave zero owners — the pure
 * `removeMembership`/domain guard only checks the snapshot it is given; the lock makes that
 * snapshot authoritative for the duration of the transaction.
 */
export async function removeWorkstreamMembership(
  client: PoolClient,
  workstreamId: string,
  principalId: PrincipalId,
): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT id FROM product.workstreams WHERE id = $1 FOR UPDATE', [workstreamId])
    const memberships = await loadMemberships(client, workstreamId)
    const workstream = { id: workstreamId, memberships } as Workstream
    removeMembership(workstream, principalId) // throws workstream_last_owner_required if illegal
    await client.query('DELETE FROM product.workstream_memberships WHERE workstream_id = $1 AND principal_id = $2', [
      workstreamId,
      principalId,
    ])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export async function addWorkstreamMembership(
  client: PoolClient,
  workstreamId: string,
  principalId: PrincipalId,
  role: WorkstreamMembershipRole,
  addedAt: Date,
): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT id FROM product.workstreams WHERE id = $1 FOR UPDATE', [workstreamId])
    const memberships = await loadMemberships(client, workstreamId)
    const workstream = { id: workstreamId, memberships } as Workstream
    addMembership(workstream, principalId, role, addedAt) // throws workstream_membership_duplicate if illegal
    await client.query(
      `INSERT INTO product.workstream_memberships (workstream_id, principal_id, role, added_at)
       VALUES ($1, $2, $3, $4)`,
      [workstreamId, principalId, role, addedAt],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

/**
 * Changing the current Session is transactional (docs/specs/02): validate the target belongs to
 * this Workstream, clear the previous pointer, set the target, commit. The Workstream row is
 * locked FIRST (like journal.ts's appendEvent) so concurrent switches serialize instead of
 * racing clear-then-set across transactions, which can otherwise violate the "at most one
 * current Session" unique index instead of cleanly resolving to a single winner.
 */
export async function setCurrentSession(client: PoolClient, workstreamId: string, sessionId: string): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT id FROM product.workstreams WHERE id = $1 FOR UPDATE', [workstreamId])
    const { rows } = await client.query<{ workstream_id: string }>(
      'SELECT workstream_id FROM product.sessions WHERE id = $1 FOR UPDATE',
      [sessionId],
    )
    const target = rows[0]
    if (!target || target.workstream_id !== workstreamId) {
      throw new Error('current_session_workstream_mismatch: target Session does not belong to this Workstream')
    }
    await client.query('UPDATE product.sessions SET is_current = false WHERE workstream_id = $1 AND is_current', [
      workstreamId,
    ])
    await client.query('UPDATE product.sessions SET is_current = true WHERE id = $1', [sessionId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
