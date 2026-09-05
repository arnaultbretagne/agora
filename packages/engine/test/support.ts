import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { capabilityId, harnessId, type Intent } from '@agora/domain'
import type { TestDatabase } from '@agora/testkit'
import { authorIntent, type AuthorIntentOutcome, type RevisionSet } from '../src/index.js'

export const PRODUCT = 'agora_product'
export const ENGINE = 'agora_engine'

export const REVISION_SET: RevisionSet = { catalogue: 'stub-s2' }

export function intentOf(power: 'on' | 'off'): Intent {
  return {
    power,
    harness: harnessId('claude-code'),
    capabilities: new Set([capabilityId('provider.invoke')]),
    model: 'model-a',
    effort: 'default',
    persona: 'default',
  }
}

export async function createWorkstream(client: pg.PoolClient, owner = 'owner@example.com'): Promise<string> {
  const id = randomUUID()
  await client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [
    id,
    owner,
    'workstream',
    randomUUID(),
  ])
  return id
}

export async function author(
  db: TestDatabase,
  client: pg.PoolClient,
  workstreamId: string,
  intent: Intent,
  requestKey: string = randomUUID(),
): Promise<AuthorIntentOutcome> {
  return authorIntent(
    client,
    { workstreamId, principal: 'owner@example.com', requestKey, intent, revisionSet: REVISION_SET },
    { nowSql: db.nowSql },
  )
}

export async function workRow(client: pg.PoolClient, workstreamId: string): Promise<Record<string, unknown> | null> {
  const result = await client.query('SELECT * FROM workstream_reconciliation_work WHERE workstream_id = $1', [workstreamId])
  return result.rowCount === 0 ? null : result.rows[0]!
}
