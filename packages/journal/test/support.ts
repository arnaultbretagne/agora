import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { TestDatabase } from '@agora/testkit'
import { openSession, type OpenedSession } from '../src/index.js'

export const PRODUCT = 'agora_product'
export const PROJECTOR = 'agora_projector'

export async function createWorkstream(db: TestDatabase, client: pg.PoolClient): Promise<string> {
  const id = randomUUID()
  await db.asRole(client, PRODUCT, () =>
    client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [
      id,
      'owner@example.com',
      'workstream',
      randomUUID(),
    ]),
  )
  return id
}

export async function openTestSession(db: TestDatabase, client: pg.PoolClient, workstreamId: string, podUid = 'pod-a'): Promise<OpenedSession> {
  return db.asRole(client, PRODUCT, () =>
    withTx(db, client, () => openSession(client, workstreamId, { podUid, provenance: { harness: 'claude-code' } }, { nowSql: db.nowSql })),
  )
}

/** openSession/appendFact run in the caller's transaction: tests wrap them the same way production must. */
export async function withTx<T>(db: TestDatabase, client: pg.PoolClient, body: () => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    const result = await body()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}
