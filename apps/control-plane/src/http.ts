// Control-plane HTTP API (S2 Step 7 + S4): Workstreams, complete Intents, prompts, permission
// decisions and the resumable feed, over node:http, with Problem+JSON errors whose detail is
// always populated (findings §6.8). Product data flows through the product pool; the operational
// work view is read through the engine pool so the authority boundaries of
// contracts/db/schema.sql stay observable end to end.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { validateIntentShape, type CatalogueView, type Intent, type RuleResolution } from '@agora/domain'
import { authorIntent, loadLatestIntentEvent, withTransaction, type ObservationSource, type RevisionSet } from '@agora/engine'
import { DispatchConflictError, reserveDispatch, replayDispatch, markUnknown } from '@agora/acp'
import type { AgentChannels } from './agent-channel.js'
import { sendJson, sendProblem } from './problem.js'
import { STUB_CATALOGUE, STUB_REVISION_SET } from './catalogue.js'
import { checkAdmission } from './admission.js'
import { NoBridgeAvailableError } from './real-channel-connector.js'

export interface AdmissionCheckOptions {
  readonly observationSource: ObservationSource
  readonly resolve: RuleResolution
}

export interface ControlPlaneOptions {
  readonly productPool: pg.Pool
  readonly enginePool?: pg.Pool
  readonly catalogue?: CatalogueView
  readonly revisionSet?: RevisionSet
  readonly nowSql?: string
  /** Live ACP channels (S4). Absent in worker-only deployments: prompts answer 503. */
  readonly channels?: AgentChannels
  /** S8 Step 4: re-verified fresh at every prompt dispatch. Absent in deployments where the owners
   * (runtime-control/broker) aren't wired either — there is nothing real to admit against yet, same
   * as S2's stub-catalogue mode; prompts there skip the check rather than being permanently refused. */
  readonly admission?: AdmissionCheckOptions
}

async function handlePrompt(
  req: IncomingMessage,
  res: ServerResponse,
  productPool: pg.Pool,
  channels: AgentChannels | undefined,
  workstreamId: string,
  nowSql?: string,
  admission?: AdmissionCheckOptions,
): Promise<void> {
  if (channels === undefined) {
    return sendProblem(res, 503, 'No ACP channel', 'this deployment runs without ACP channels')
  }
  const key = idempotencyKey(req)
  if (key === null) return sendProblem(res, 400, 'Missing Idempotency-Key', 'the Idempotency-Key header is required')
  const body = await readJsonBody(req)
  if (!body.ok) return sendProblem(res, 400, 'Invalid JSON', 'the request body must be valid JSON')
  const text = (body.body as Record<string, unknown>)?.['text']
  if (typeof text !== 'string' || text.trim().length === 0) {
    return sendProblem(res, 422, 'Invalid prompt', 'text must be a non-empty string')
  }

  const replayed = await replayDispatch(productPool, workstreamId, key)
  if (replayed !== null) {
    return sendJson(res, 200, { commandId: replayed.id, state: replayed.state })
  }

  // Admission checklist (execution.md — "Session birth and admission"), re-verified fresh for THIS
  // dispatch — never trusting the reconciliation worker's last tick, which could be stale by now
  // ("a database commit alone cannot reopen a stale path"). A replayed command above never reaches
  // here — it was already admitted once, and re-checking a duplicate-key retry could wrongly refuse
  // an already-accepted turn if conditions drifted since.
  if (admission !== undefined) {
    const intentEvent = await loadLatestIntentEvent(productPool, workstreamId)
    const intent = intentEvent?.intent as Intent | undefined
    if (intent === undefined) {
      return sendProblem(res, 409, 'No current Intent', 'prompts require an authored Intent for this Workstream')
    }
    const decision = await checkAdmission(admission.observationSource, workstreamId, intent, admission.resolve)
    if (!decision.admitted) {
      return sendProblem(res, 409, 'Admission not granted', decision.reason)
    }
  }

  let reserved: { readonly reserved: { readonly id: string }; readonly sessionId: string } | undefined
  try {
    reserved = await withTransaction(productPool, async (client) => {
      // Admission revalidation happens in the reservation's own transaction: the current Session
      // and the no-turn-in-flight gate commit together with `reserved`, before any send.
      const current = await client.query(
        'SELECT id FROM sessions WHERE workstream_id = $1 AND attribution_ended_at IS NULL ORDER BY ordinal DESC LIMIT 1',
        [workstreamId],
      )
      if (current.rowCount === 0) {
        throw new Error('no_current_session')
      }
      const sessionId = current.rows[0]!['id'] as string
      const dispatch = await reserveDispatch(client, { workstreamId, sessionId, kind: 'prompt', request: { text }, requestKey: key })
      return { reserved: dispatch, sessionId }
    })
    await channels.ensure(workstreamId, reserved.sessionId)
    void channels.prompt(workstreamId, reserved.reserved.id, text).catch((error: unknown) => {
      console.error(`prompt flow for ${reserved!.reserved.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return sendJson(res, 202, { commandId: reserved.reserved.id, state: 'reserved' })
  } catch (error) {
    if (error instanceof Error && error.message === 'no_current_session') {
      return sendProblem(res, 409, 'No current Session', 'prompts require a current Session; power on through the Intent first')
    }
    if (error instanceof DispatchConflictError) {
      const existing = await replayDispatch(productPool, workstreamId, key)
      return sendJson(res, 200, { commandId: existing!.id, state: existing!.state })
    }
    if (error instanceof NoBridgeAvailableError) {
      // The dispatch already committed as `reserved` above (admission was granted moments ago, so
      // this is a genuine race, not the common case) — leaving it there forever would starve any
      // future turn (CONT-005 shape: an ambiguous/never-sent attempt must never sit inert). Marking
      // it `unknown` here is honest: dispatch never actually reached the harness, but the DB state
      // still needs an owner, and `unknown` is what the rest of this codebase already uses for
      // "not proven either way".
      if (reserved !== undefined) await markDispatchUnknown(productPool, reserved.reserved.id)
      return sendProblem(res, 503, 'Harness bridge unavailable', error.message)
    }
    void nowSql
    if (error instanceof Error && error.message === 'turn_in_flight') {
      return sendProblem(res, 409, 'Turn in flight', 'at most one prompt turn may be in flight per Workstream (findings §2.4)')
    }
    if (error instanceof Error && error.message === 'prompt_delivery_unknown') {
      return sendProblem(res, 409, 'Prompt delivery unknown', 'a previous prompt may have been accepted; its recovery must resolve before a new turn (CONT-005)')
    }
    throw error
  }
}

async function markDispatchUnknown(productPool: pg.Pool, commandId: string): Promise<void> {
  const client = await productPool.connect()
  try {
    await client.query('BEGIN')
    await markUnknown(client, commandId)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(`marking dispatch ${commandId} unknown failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    client.release()
  }
}

async function streamFeed(
  req: IncomingMessage,
  res: ServerResponse,
  productPool: pg.Pool,
  channels: AgentChannels | undefined,
  workstreamId: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let after = Number(url.searchParams.get('after') ?? '0')
  if (!Number.isSafeInteger(after) || after < 0) after = 0
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(':ok\n\n')
  let stopped = false
  req.on('close', () => {
    stopped = true
  })
  while (!stopped) {
    if (channels !== undefined) await channels.runProjectors(workstreamId).catch(() => {})
    const rows = (await productPool.query(
      'SELECT position, through_seq, operation, item_id, payload, created_at FROM feed_events WHERE workstream_id = $1 AND position > $2 ORDER BY position LIMIT 200',
      [workstreamId, after],
    )).rows
    for (const row of rows) {
      after = Number(row['position'])
      const frame = {
        position: row['position'],
        operation: row['operation'],
        itemId: row['item_id'],
        payload: row['payload'],
        throughSeq: row['through_seq'],
      }
      res.write(`data: ${JSON.stringify(frame)}\n\n`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
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
  const channels = options.channels
  const admission = options.admission

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

      if (segments.length === 4 && segments[3] === 'prompt' && method === 'POST') {
        return handlePrompt(req, res, productPool, channels, workstreamId, nowSql, admission)
      }
      if (segments.length === 4 && segments[3] === 'items' && method === 'GET') {
        const items = await productPool.query(
          'SELECT id, session_id, item_kind, entity_key, value, first_seq, latest_seq, updated_at FROM projection_items WHERE workstream_id = $1 ORDER BY first_seq',
          [workstreamId],
        )
        return sendJson(res, 200, {
          items: items.rows.map((row) => ({
            id: row['id'],
            sessionId: row['session_id'],
            kind: row['item_kind'],
            entityKey: row['entity_key'],
            value: row['value'],
            firstSeq: row['first_seq'],
            latestSeq: row['latest_seq'],
            updatedAt: row['updated_at'],
          })),
        })
      }
      if (segments.length === 4 && segments[3] === 'feed' && method === 'GET') {
        return streamFeed(req, res, productPool, channels, workstreamId)
      }
      if (segments.length === 5 && segments[3] === 'permissions' && segments[4] === 'pending' && method === 'GET') {
        if (channels === undefined) return sendProblem(res, 503, 'No ACP channel', 'this deployment runs without ACP channels')
        return sendJson(res, 200, { pending: channels.pendingPermissionIds(workstreamId) })
      }
      if (segments.length === 6 && segments[3] === 'permissions' && segments[5] === 'decision' && method === 'POST') {
        if (channels === undefined) return sendProblem(res, 503, 'No ACP channel', 'this deployment runs without ACP channels')
        const body = await readJsonBody(req)
        const optionId = (body.ok ? (body.body as Record<string, unknown>)?.['optionId'] : undefined) as unknown
        if (typeof optionId !== 'string' || optionId.length === 0) {
          return sendProblem(res, 422, 'Invalid decision', 'optionId must be a non-empty string')
        }
        const decided = channels.decidePermission(workstreamId, segments[4]!, optionId)
        if (!decided) return sendProblem(res, 404, 'No pending permission', `no pending permission ${segments[4]} on this Workstream`)
        return sendJson(res, 200, { decided: true })
      }
      if (segments.length === 4 && segments[3] === 'cancel' && method === 'POST') {
        if (channels === undefined) return sendProblem(res, 503, 'No ACP channel', 'this deployment runs without ACP channels')
        await channels.cancel(workstreamId)
        return sendJson(res, 202, { cancelled: true })
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
