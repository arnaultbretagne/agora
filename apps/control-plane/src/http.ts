// Control-plane HTTP API (S2 Step 7): Workstreams and complete Intents over node:http, with
// Problem+JSON errors whose detail is always populated (findings §6.8). Product data flows
// through the product pool; the operational work view is read through the engine pool so the two
// authority boundaries of contracts/db/schema.sql stay observable end to end.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { validateIntentShape, type CatalogueView } from '@agora/domain'
import { authorIntent, loadLatestIntentEvent, withTransaction, type RevisionSet } from '@agora/engine'
import { sendJson, sendProblem } from './problem.js'
import { STUB_CATALOGUE, STUB_REVISION_SET } from './catalogue.js'

export interface ControlPlaneOptions {
  readonly productPool: pg.Pool
  readonly enginePool?: pg.Pool
  readonly catalogue?: CatalogueView
  readonly revisionSet?: RevisionSet
  readonly nowSql?: string
}

const PRINCIPAL_HEADER = 'x-forwarded-email'

function principal(req: IncomingMessage): string | null {
  const value = req.headers[PRINCIPAL_HEADER]
  if (typeof value !== 'string' || value.length === 0) return null
  return value
}

function idempotencyKey(req: IncomingMessage): string | null {
  const value = req.headers['idempotency-key']
  if (typeof value !== 'string' || value.length === 0) return null
  return value
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) return { ok: false }
  }
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false }
  }
}

interface RequestUrl {
  readonly method: string
  readonly segments: readonly string[]
}

function route(req: IncomingMessage): RequestUrl {
  const url = new URL(req.url ?? '/', 'http://localhost')
  return { method: req.method ?? 'GET', segments: url.pathname.split('/').filter((s) => s.length > 0) }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createControlPlaneServer(options: ControlPlaneOptions): Server {
  const catalogue = options.catalogue ?? STUB_CATALOGUE
  const revisionSet = options.revisionSet ?? STUB_REVISION_SET
  const nowSql = options.nowSql
  const productPool = options.productPool
  const enginePool = options.enginePool ?? options.productPool

  return createServer((req, res) => {
    void (async () => {
      const { method, segments } = route(req)
      if (segments[0] !== 'v1') {
        return sendProblem(res, 404, 'Not found', `no resource at ${req.url ?? '/'}`)
      }
      if (segments[1] === 'healthz' && method === 'GET') {
        return sendJson(res, 200, { ok: true })
      }
      if (segments[1] !== 'workstreams') {
        return sendProblem(res, 404, 'Not found', `no resource at ${req.url ?? '/'}`)
      }

      if (segments.length === 2) {
        const owner = principal(req)
        if (owner === null) return sendProblem(res, 401, 'Unauthenticated', 'the authentication proxy did not supply a principal')
        if (method === 'POST') {
          const key = idempotencyKey(req)
          if (key === null) return sendProblem(res, 400, 'Missing Idempotency-Key', 'the Idempotency-Key header is required')
          const body = await readJsonBody(req)
          if (!body.ok) return sendProblem(res, 400, 'Invalid JSON', 'the request body must be valid JSON')
          const shape = body.body as Record<string, unknown>
          const title = shape?.['title']
          if (typeof title !== 'string' || title.length === 0 || title.length > 200) {
            return sendProblem(res, 422, 'Invalid title', 'title must be a string of 1 to 200 characters')
          }
          const id = randomUUID()
          const inserted = await productPool.query(
            `INSERT INTO workstreams (id, owner_principal, title, create_request_key)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (owner_principal, create_request_key) DO NOTHING
             RETURNING id, title, owner_principal, created_at, updated_at`,
            [id, owner, title, key],
          )
          if (inserted.rowCount === 1) {
            return sendJson(res, 201, serializedWorkstream(inserted.rows[0]!))
          }
          const existing = await productPool.query(
            'SELECT id, title, owner_principal, created_at, updated_at FROM workstreams WHERE owner_principal = $1 AND create_request_key = $2',
            [owner, key],
          )
          return sendJson(res, 200, serializedWorkstream(existing.rows[0]!))
        }
        if (method === 'GET') {
          const owned = await productPool.query(
            'SELECT id, title, owner_principal, created_at, updated_at FROM workstreams WHERE owner_principal = $1 ORDER BY created_at',
            [owner],
          )
          return sendJson(res, 200, owned.rows.map(serializedWorkstream))
        }
        return sendProblem(res, 405, 'Method not allowed', `${method} is not supported on /v1/workstreams`)
      }

      const workstreamId = segments[2] ?? ''
      if (!UUID_PATTERN.test(workstreamId)) {
        return sendProblem(res, 404, 'Not found', 'no Workstream with this id')
      }
      const owner = principal(req)
      if (owner === null) return sendProblem(res, 401, 'Unauthenticated', 'the authentication proxy did not supply a principal')
      const owns = await productPool.query('SELECT 1 FROM workstreams WHERE id = $1 AND owner_principal = $2', [workstreamId, owner])
      if (owns.rowCount === 0) {
        return sendProblem(res, 404, 'Not found', 'no owned Workstream with this id')
      }

      if (segments.length === 3) {
        if (method === 'GET') {
          const found = await productPool.query('SELECT id, title, owner_principal, created_at, updated_at FROM workstreams WHERE id = $1', [workstreamId])
          return sendJson(res, 200, serializedWorkstream(found.rows[0]!))
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req)
          if (!body.ok) return sendProblem(res, 400, 'Invalid JSON', 'the request body must be valid JSON')
          const title = (body.body as Record<string, unknown>)?.['title']
          if (typeof title !== 'string' || title.length === 0 || title.length > 200) {
            return sendProblem(res, 422, 'Invalid title', 'title must be a string of 1 to 200 characters')
          }
          const updated = await productPool.query(
            `UPDATE workstreams SET title = $2, updated_at = ${nowSql ?? 'now()'} WHERE id = $1
             RETURNING id, title, owner_principal, created_at, updated_at`,
            [workstreamId, title],
          )
          return sendJson(res, 200, serializedWorkstream(updated.rows[0]!))
        }
        return sendProblem(res, 405, 'Method not allowed', `${method} is not supported on /v1/workstreams/{id}`)
      }

      if (segments.length === 4 && segments[3] === 'intent') {
        if (method === 'PUT') {
          const key = idempotencyKey(req)
          if (key === null) return sendProblem(res, 400, 'Missing Idempotency-Key', 'the Idempotency-Key header is required')
          const body = await readJsonBody(req)
          if (!body.ok) return sendProblem(res, 400, 'Invalid JSON', 'the request body must be valid JSON')
          const shape = validateIntentShape(body.body, catalogue)
          if (!shape.valid) {
            const detail = shape.errors.map((error) => `${error.field}: ${error.message}`).join('; ')
            return sendProblem(res, 422, 'Invalid Intent', detail)
          }
          const outcome = await withTransaction(productPool, (client) =>
            authorIntent(
              client,
              { workstreamId, principal: owner, requestKey: key, intent: shape.intent, revisionSet },
              { nowSql },
            ),
          )
          if (outcome.kind === 'unknown_workstream') return sendProblem(res, 404, 'Not found', 'no owned Workstream with this id')
          if (outcome.kind === 'conflict') {
            return sendProblem(res, 409, 'Request key conflict', `the Idempotency-Key was already used with a different complete Intent (event ${outcome.intentSeq})`)
          }
          return sendJson(res, outcome.kind === 'created' ? 201 : 200, { status: outcome.kind, intentSeq: outcome.intentSeq })
        }
        if (method === 'GET') {
          const event = await loadLatestIntentEvent(productPool, workstreamId)
          if (event === null) return sendProblem(res, 404, 'No Intent', 'this Workstream has no Intent event yet')
          const work = await enginePool.query(
            'SELECT intent_seq, work_generation, due_at, attempt_count, blocking_cause, claim_token FROM workstream_reconciliation_work WHERE workstream_id = $1',
            [workstreamId],
          )
          const row = work.rows[0]
          return sendJson(res, 200, {
            workstreamId,
            intent: event.intent,
            intentSeq: event.intentSeq,
            revisionSet: event.revisionSet,
            createdAt: event.createdAt,
            work:
              row === undefined
                ? null
                : {
                    intentSeq: row['intent_seq'],
                    workGeneration: row['work_generation'],
                    dueAt: row['due_at'],
                    attemptCount: row['attempt_count'],
                    blockingCause: row['blocking_cause'],
                    claimed: row['claim_token'] !== null,
                    note: 'operational scheduling state, not a convergence proof',
                  },
          })
        }
      }

      return sendProblem(res, 405, 'Method not allowed', `${method} is not supported here`)
    })().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendProblem(res, 500, 'Internal error', detail)
      else res.destroy()
    })
  })
}

interface WorkstreamRow {
  readonly id: string
  readonly title: string
  readonly owner_principal: string
  readonly created_at: Date
  readonly updated_at: Date
}

function serializedWorkstream(row: WorkstreamRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    ownerPrincipal: row.owner_principal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
