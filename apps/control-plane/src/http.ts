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
import { DispatchConflictError, reserveDispatch, replayDispatch, markNeverSent } from '@agora/acp'
import type { AgentChannels } from './agent-channel.js'
import { sendJson, sendProblem } from './problem.js'
import { STUB_CATALOGUE, STUB_REVISION_SET } from './catalogue.js'
import { checkAdmission } from './admission.js'
import { NoBridgeAvailableError } from './real-channel-connector.js'
import { recoverPromptDelivery, type PromptRecoveryOptions } from './recovery/context.js'
import { handleAdminRevisions, type AdminPublishOptions } from './http/admin-publish.js'
import { isRevisionCurrent } from '@agora/policy'
import type { Metrics } from '@agora/telemetry'

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
  /** S8 Step 5: resolves an ambiguous previous prompt against the harness's own replay before
   * refusing a new turn. Absent in deployments without real owners — the CONT-005 gate then simply
   * refuses, exactly as it did before recovery existed. */
  readonly recovery?: PromptRecoveryOptions
  /** S10: publishing a reviewed catalogue revision. Absent, the endpoint answers 503 — a deployment
   * that has not decided who may re-pin its images does not get a default answer to that question. */
  readonly publication?: Omit<AdminPublishOptions, 'productPool'>
  /**
   * This process's own catalogue revision id (S10, ENGINE-014/SESSION-A11). Every mutation is fenced
   * against the durably SELECTED revision: a worker whose local catalogue is not the selected one
   * refuses rather than acting on it, which is what stops two workers on different images from
   * oscillating an image or authority target between them. Absent, or with no selection published,
   * nothing is fenced — a deployment that has never published a revision has none to be stale against.
   */
  readonly revisionId?: string
  /** S11: the process's metric registry, rendered at /v1/metrics. */
  readonly metrics?: Metrics
  /** S11: owner connectivity, for readiness. Absent in modes with no owners to check. */
  readonly readiness?: () => Promise<{ readonly ready: boolean; readonly reason: string }>
}

async function handlePrompt(
  req: IncomingMessage,
  res: ServerResponse,
  productPool: pg.Pool,
  channels: AgentChannels | undefined,
  workstreamId: string,
  nowSql?: string,
  admission?: AdmissionCheckOptions,
  recovery?: PromptRecoveryOptions,
  revisionId?: string,
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

  // CONT-005: a previous prompt that may or may not have been accepted gates this one. Before
  // refusing, try to actually resolve it against the harness's own replay (S8 Step 5) — recovery
  // either proves it was delivered or proves it never was, and only an unresolvable one still
  // gates. Recovery never re-sends anything; it only settles the ambiguous record.
  if (recovery !== undefined && (await hasUnresolvedPrompt(productPool, workstreamId))) {
    const verdict = await recoverPromptDelivery(recovery, workstreamId)
    if (verdict.kind === 'unresolved') {
      return sendProblem(res, 409, 'Prompt delivery unknown', `a previous prompt may have been accepted and recovery could not resolve it: ${verdict.reason} (CONT-005)`)
    }
  }

  if (!(await isRevisionCurrent(productPool, revisionId ?? null))) {
    // ENGINE-014: rejected immediately, not after the publication sweep reaches this Workstream.
    return sendProblem(res, 409, 'Obsolete revision', `this worker resolves catalogue revision ${String(revisionId)}, which is no longer the selected one`)
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
    void channels.prompt(workstreamId, reserved.reserved.id, text).catch(async (error: unknown) => {
      console.error(`prompt flow for ${reserved!.reserved.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      // A reservation whose send never started must not sit there: the one-turn-per-Workstream gate
      // counts `reserved` as in flight, so leaving it inert makes the Workstream unpromptable for
      // ever. `markNeverSent` only accepts `reserved` — a dispatch that did reach the wire is
      // `unknown`, and the channel's own failure path owns that case.
      await settleUnsentDispatch(productPool, reserved!.reserved.id)
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
    // EVERY remaining path failed BEFORE the send started — opening the channel, resolving the Pod,
    // anything between the reservation and `session/prompt`. The reservation must not survive it:
    // the one-turn gate counts `reserved` as in flight, so an inert one makes the Workstream
    // unpromptable for ever. Found live twice — once through the bridge, once through this path,
    // which used to leave the row untouched and answer 500.
    //
    // `rejected_before_acceptance`, not `unknown`, including for the unavailable bridge: nothing
    // reached the harness, and that is exactly what "provably never sent" means. `unknown` would
    // additionally gate the NEXT prompt on CONT-005 recovery for a turn that demonstrably never
    // left this process.
    if (reserved !== undefined) await settleUnsentDispatch(productPool, reserved.reserved.id)
    if (error instanceof NoBridgeAvailableError) {
      return sendProblem(res, 503, 'Harness bridge unavailable', error.message)
    }
    void nowSql
    if (error instanceof Error && error.message === 'turn_in_flight') {
      return sendProblem(res, 409, 'Turn in flight', 'at most one prompt turn may be in flight per Workstream (findings §2.4)')
    }
    if (error instanceof Error && error.message === 'prompt_delivery_unknown') {
      return sendProblem(res, 409, 'Prompt delivery unknown', 'a previous prompt may have been accepted; its recovery must resolve before a new turn (CONT-005)')
    }
    // Nothing else knows what this was: say so here rather than letting a bare 500 carry no cause.
    console.error(`prompt for ${workstreamId} failed before dispatch: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    throw error
  }
}

/**
 * Settles a reservation whose send never started: `rejected_before_acceptance`, which is what
 * "provably never sent" means, and which stops it counting as a turn in flight.
 *
 * Never throws. It runs on failure paths — sometimes after the response has already gone out — so a
 * pool that has since closed, or a row someone else already moved on, must be a logged no-op rather
 * than a second failure on top of the first.
 */
async function settleUnsentDispatch(productPool: pg.Pool, commandId: string): Promise<void> {
  try {
    const client = await productPool.connect()
    try {
      await client.query('BEGIN')
      await markNeverSent(client, commandId)
      await client.query('COMMIT')
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  } catch (error: unknown) {
    console.error(`could not settle the unsent dispatch ${commandId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Cheap pre-check so recovery (which opens a real ACP connection) only runs when something is actually ambiguous. */
async function hasUnresolvedPrompt(productPool: pg.Pool, workstreamId: string): Promise<boolean> {
  const result = await productPool.query(
    `SELECT 1 FROM command_dispatches WHERE workstream_id = $1 AND kind = 'prompt' AND state = 'unknown' LIMIT 1`,
    [workstreamId],
  )
  return (result.rowCount ?? 0) > 0
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
  const recovery = options.recovery

  return createServer((req, res) => {
    void (async () => {
      const { method, segments } = route(req)
      if (segments[0] !== 'v1') {
        return sendProblem(res, 404, 'Not found', `no resource at ${req.url ?? '/'}`)
      }
      if (segments[1] === 'healthz' && method === 'GET') {
        return sendJson(res, 200, { ok: true })
      }
      if (segments[1] === 'readyz' && method === 'GET') {
        // Readiness reflects the owners, not this process's own liveness: an API that answers while
        // it cannot reach runtime-control would take traffic it can only refuse.
        const ready = options.readiness === undefined ? { ready: true, reason: 'no owner connectivity to check in this mode' } : await options.readiness()
        return sendJson(res, ready.ready ? 200 : 503, ready)
      }
      // S12: the reviewed public values a client may select from. The browser never invents an
      // Intent field's value; it picks one of these, and the server validates against the same view.
      if (segments[1] === 'catalogue') {
        if (method !== 'GET') return sendProblem(res, 405, 'Method not allowed', 'the catalogue is read-only')
        const harnesses = [...catalogue.harnesses].sort()
        return sendJson(res, 200, {
          revisionId: options.revisionId ?? null,
          capabilities: [...catalogue.capabilities].sort(),
          harnesses: harnesses.map((harness) => ({
            id: harness,
            models: catalogue.models(harness).map((model) => ({ id: model, efforts: catalogue.efforts(harness, model) })),
          })),
        })
      }
      if (segments[1] === 'metrics' && method === 'GET') {
        if (options.metrics === undefined) return sendProblem(res, 404, 'Not found', 'this deployment exposes no metrics')
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
        return void res.end(options.metrics.render())
      }
      // Operator surface, authenticated as a service actor rather than as a product user.
      if (await handleAdminRevisions({ productPool, ...(options.publication ?? {}) }, req, res, segments, method)) return
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
          // The revision fence runs BEFORE the shape is validated, deliberately: a worker whose
          // catalogue is superseded must not judge an Intent against that catalogue at all. Its
          // verdict on which models, efforts and capabilities are valid is exactly what is stale.
          if (!(await isRevisionCurrent(productPool, options.revisionId ?? null))) {
            return sendProblem(
              res,
              409,
              'Obsolete revision',
              `this worker resolves catalogue revision ${String(options.revisionId)}, which is no longer the selected one; it refuses rather than authoring against it (SESSION-A11)`,
            )
          }
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

      // S12: the Sessions of a Workstream, with what the operator has to be able to see — the
      // native-loss exposure CONT-012 names, which is a real number of facts, not a mood.
      if (segments.length === 4 && segments[3] === 'sessions' && method === 'GET') {
        const sessions = await productPool.query(
          `SELECT id, ordinal, opened_at, opened_at_seq, cutoff_h, origin_w, origin_save_id, pod_uid, provenance,
                  acp_context_id, process_generation, attribution_ended_at
           FROM sessions WHERE workstream_id = $1 ORDER BY ordinal`,
          [workstreamId],
        )
        const anchors = await productPool.query(
          `SELECT a.harness_id, a.save_id, a.frontier_w, a.published_at, s.created_at
           FROM anchors a JOIN saves s ON s.id = a.save_id WHERE a.workstream_id = $1`,
          [workstreamId],
        )
        const head = await productPool.query('SELECT head_seq FROM workstreams WHERE id = $1', [workstreamId])
        const headSeq = Number((head.rows[0] as { head_seq?: number } | undefined)?.head_seq ?? 0)
        return sendJson(res, 200, {
          headSeq,
          sessions: sessions.rows.map((row) => {
            const session = row as Record<string, unknown>
            return {
              id: session['id'],
              ordinal: session['ordinal'],
              openedAt: session['opened_at'],
              openingRange: { w: Number(session['origin_w']), h: Number(session['cutoff_h']) },
              restoredFromSaveId: session['origin_save_id'] ?? null,
              podUid: session['pod_uid'],
              provenance: session['provenance'],
              contextId: session['acp_context_id'] ?? null,
              processGeneration: session['process_generation'],
              attributionEndedAt: session['attribution_ended_at'] ?? null,
            }
          }),
          // CONT-012: how much of the record is newer than the newest recovery point. A live
          // context with an old Anchor is normal; what is NOT acceptable is nobody being able to
          // see how much would be lost if it ended now.
          lossExposure: anchors.rows.map((row) => {
            const anchor = row as Record<string, unknown>
            return {
              harnessId: anchor['harness_id'],
              saveId: anchor['save_id'],
              frontierW: Number(anchor['frontier_w']),
              anchoredAt: anchor['published_at'],
              factsSinceAnchor: Math.max(0, headSeq - Number(anchor['frontier_w'])),
            }
          }),
        })
      }

      if (segments.length === 4 && segments[3] === 'prompt' && method === 'POST') {
        return handlePrompt(req, res, productPool, channels, workstreamId, nowSql, admission, recovery, options.revisionId)
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
        // The options come with the request: an operator answers with what the agent offered, and a
        // client that had only ids would have to invent the choices (S12 Step 4).
        return sendJson(res, 200, { pending: channels.pendingPermissions(workstreamId) })
      }
      if (segments.length === 6 && segments[3] === 'permissions' && segments[5] === 'decision' && method === 'POST') {
        if (channels === undefined) return sendProblem(res, 503, 'No ACP channel', 'this deployment runs without ACP channels')
        const body = await readJsonBody(req)
        const optionId = (body.ok ? (body.body as Record<string, unknown>)?.['optionId'] : undefined) as unknown
        if (typeof optionId !== 'string' || optionId.length === 0) {
          return sendProblem(res, 422, 'Invalid decision', 'optionId must be a non-empty string')
        }
        const decided = channels.decidePermission(workstreamId, segments[4]!, optionId)
        if (decided === 'unknown') return sendProblem(res, 404, 'No pending permission', `no pending permission ${segments[4]} on this Workstream`)
        if (decided === 'not_offered') {
          return sendProblem(res, 422, 'Option not offered', `the agent did not offer option ${optionId} for this permission; answer with one it listed`)
        }
        return sendJson(res, 200, { decided: true })
      }
      if (segments.length === 4 && segments[3] === 'cancel' && method === 'POST') {
        if (channels === undefined) return sendProblem(res, 503, 'No ACP channel', 'this deployment runs without ACP channels')
        const body = await readJsonBody(req)
        const commandId = (body.ok ? (body.body as Record<string, unknown>)?.['commandId'] : undefined) as unknown
        if (typeof commandId !== 'string' || commandId.length === 0) {
          return sendProblem(res, 422, 'Invalid cancel', 'commandId must be the exact turn to cancel — a delayed cancel must name its intended target, never "whatever is active"')
        }
        try {
          const outcome = await channels.cancel(workstreamId, commandId)
          return sendJson(res, 202, { cancelled: outcome === 'cancel_sent' })
        } catch (error) {
          if (error instanceof Error && error.message === 'channel_not_open') {
            return sendProblem(res, 409, 'No open channel', 'there is no live ACP channel for this Workstream to cancel on')
          }
          throw error
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
