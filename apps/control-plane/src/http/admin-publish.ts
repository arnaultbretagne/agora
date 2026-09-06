// The operator endpoint that publishes a reviewed catalogue revision (S10 Step 3).
//
// Publication is an operator action, not a user one: it changes what every Workstream in the
// deployment is reconciled against. So it is authenticated as a SERVICE ACTOR — a principal the
// deployment configured, not whatever the authentication proxy happened to put in the header for a
// logged-in human. A product user with a valid session must not be able to re-pin an image digest.
//
// The request itself supplies no policy. It names a revision id and the revision set the deployment
// already reviewed; the catalogue files behind it are the ones this process was configured with.
// Publication records the selection and schedules the wakes; the rule tables then decide, per
// Workstream, what the new revision actually implies (a re-pinned digest becomes CONSTRUCT-002 on
// its own — nothing here names a verb).
import type { IncomingMessage, ServerResponse } from 'node:http'
import type pg from 'pg'
import { advancePublication, publishRevision, selectedRevision, unfinishedPublications, type RevisionSet } from '@agora/policy'
import { sendJson, sendProblem } from '../problem.js'

export interface AdminPublishOptions {
  readonly productPool: pg.Pool
  /**
   * The principal allowed to publish. Absent, the endpoint is closed entirely — a deployment that
   * has not decided who may re-pin its images does not get a default answer to that question.
   */
  readonly servicePrincipal?: string
  /** The revision this process itself was configured with; what an operator publishes by default. */
  readonly revisionSet?: RevisionSet
  readonly batchSize?: number
  readonly logger?: (message: string) => void
}

function actorOf(req: IncomingMessage): string | null {
  const header = req.headers['x-agora-service-actor']
  const value = Array.isArray(header) ? header[0] : header
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Handles `POST /v1/admin/revisions` (publish) and `GET /v1/admin/revisions` (what is selected, and
 * what is still owed). Returns false when the path is not one of those, so the caller can continue
 * routing.
 */
export async function handleAdminRevisions(
  options: AdminPublishOptions,
  req: IncomingMessage,
  res: ServerResponse,
  segments: readonly string[],
  method: string,
): Promise<boolean> {
  if (segments[1] !== 'admin' || segments[2] !== 'revisions' || segments.length !== 3) return false

  if (options.servicePrincipal === undefined) {
    sendProblem(res, 503, 'Publication not configured', 'this deployment has no service actor authorized to publish a revision')
    return true
  }
  const actor = actorOf(req)
  if (actor === null) {
    sendProblem(res, 401, 'Unauthenticated', 'publication requires the service actor header')
    return true
  }
  if (actor !== options.servicePrincipal) {
    // Deliberately not 404: an operator with the wrong actor should learn that, not hunt a route.
    sendProblem(res, 403, 'Forbidden', `principal ${actor} is not the configured publication service actor`)
    return true
  }

  if (method === 'GET') {
    const [selected, unfinished] = await Promise.all([selectedRevision(options.productPool), unfinishedPublications(options.productPool)])
    sendJson(res, 200, { selected, unfinished })
    return true
  }
  if (method !== 'POST') {
    sendProblem(res, 405, 'Method not allowed', 'publish with POST or read the selection with GET')
    return true
  }

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  let body: { revisionId?: unknown; revisionSet?: unknown }
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
  } catch {
    sendProblem(res, 400, 'Invalid JSON', 'the request body must be valid JSON')
    return true
  }
  if (typeof body?.revisionId !== 'string' || body.revisionId.length === 0) {
    sendProblem(res, 422, 'Invalid revision', 'revision_id is required')
    return true
  }
  const revisionSet = (body.revisionSet as RevisionSet | undefined) ?? options.revisionSet
  if (revisionSet === undefined) {
    sendProblem(res, 422, 'Invalid revision', 'revision_set is required when this process carries no configured catalogue')
    return true
  }

  const client = await options.productPool.connect()
  let publicationId: string
  try {
    await client.query('BEGIN')
    // The selection and the publication commit together: from here on, anything resolved under the
    // previous revision is obsolete and rejected immediately, without waiting for the sweep.
    const publication = await publishRevision(client, { revisionId: body.revisionId, revisionSet })
    await client.query('COMMIT')
    publicationId = publication.id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  // Enumeration and re-enqueue are bounded and resumable, so the response does not wait for them —
  // it reports what was durably recorded, and the sweep owes the rest.
  const advanced = await advancePublication(options.productPool, publicationId, {
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    maxPasses: 20,
  })
  options.logger?.(`published revision ${body.revisionId} (${advanced.state})`)
  sendJson(res, 202, { publicationId, revisionId: body.revisionId, state: advanced.state })
  return true
}
