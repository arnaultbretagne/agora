// The verb runner (S5 scaffold, wired for real in S8): a verb becomes one or more owner requests
// under one attempt key, each verifying ownership and preconditions, dispatched and settled
// through the same tracked attempt lifecycle ENGINE-006/007/008 already exercise
// (reserve -> dispatch -> settle/unknown, never a direct untracked transport call). Per-verb
// recovery encodes each verb's "Idempotency and recovery" paragraph (003 verbs); the ACP-facing
// recovery bodies stay stubs until S8/S9 wire them.
import type pg from 'pg'
import type { Verb } from '@agora/domain'
import type { QueryClient } from './db.js'
import type { VerbContext, VerbExecutor } from './verb-executor.js'
import { isCleanupOperation, isPositiveOperation, payloadDigest, type OwnerRequest, type OwnerResponse, type OwnerTarget } from '@agora/owner-requests'
import { isRetired, retireTarget } from './retirement.js'
import { dispatchAttempt, hasUnresolvedAttempts, markAttemptUnknown, reopenAttemptForRecovery, reserveAttempt, unresolvedRepeatOf, type AttemptReservation } from './attempts.js'
import { loadLatestIntentEvent } from './authoring.js'

export interface VerbRunnerTransport {
  /** The owner the verb talks to, by operation namespace. */
  route(operation: string): string
  send(owner: string, request: OwnerRequest): Promise<OwnerResponse>
}

export interface VerbRunnerOptions {
  readonly pool: pg.Pool
  readonly transport: VerbRunnerTransport
  readonly nowSql?: string
  readonly logger?: (message: string) => void
}

export class UnwiredVerbError extends Error {
  readonly code = 'verb_unwired'

  constructor(readonly verb: Verb) {
    super(`verb ${verb} has no owner wiring before its slice (S8/S9)`)
    this.name = 'UnwiredVerbError'
  }
}

export class MissingIncarnationError extends Error {
  readonly code = 'missing_incarnation'

  constructor(readonly workstreamId: string, readonly verb: Verb) {
    super(`${verb} needs a prior BUILD's incarnation for ${workstreamId}, and none is on record`)
    this.name = 'MissingIncarnationError'
  }
}

interface VerbPlan {
  readonly operation: string
  readonly target: OwnerTarget
  readonly payload: Record<string, unknown>
}

/** The attempt identity is stable per (Workstream, rule, generation): a retry under the same generation keeps the key. */
export function attemptKeyFor(verb: Verb, context: VerbContext): string {
  return `${context.workstreamId}/${verb}/${context.rule}/${context.workGeneration}`
}

/**
 * BUILD's reserved target id (the incarnation): a fresh one, unless a still-possibly-accepted
 * create_pod attempt already reserved one for this Workstream — reusing it is what makes a
 * crash-then-retry BUILD land on the exact same reserved target instead of abandoning it
 * (engine.md: "the resulting late resource is discoverable by its pre-recorded correlation").
 */
async function incarnationForBuild(client: QueryClient, workstreamId: string): Promise<string> {
  const existing = await currentIncarnation(client, workstreamId)
  return existing ?? crypto.randomUUID()
}

/**
 * The incarnation a prior BUILD reserved for this Workstream — GRANT/TURN_OFF act on the SAME
 * concrete target BUILD did, never a freshly invented one. Looked up from owner_attempts (no
 * separate "current incarnation" table to keep in sync): a create_pod attempt that might still be
 * accepted (settled, dispatched, or unknown — never assumed absent) names it as its own target id.
 */
export async function currentIncarnation(
  client: QueryClient,
  workstreamId: string,
  options: { readonly includeRetired?: boolean } = {},
): Promise<string | undefined> {
  const result = await client.query(
    `SELECT target_id FROM owner_attempts a
     WHERE a.workstream_id = $1 AND a.operation = 'create_pod' AND a.state IN ('settled', 'dispatched', 'unknown')
       -- A RETIRED incarnation is not the current one, however recent it is. Reusing one was a
       -- permanent wedge, live: BUILD re-created a Pod under an incarnation the owner had already
       -- retired (allowed, because a create targets a RESERVED slot and retirement only blocks
       -- positive work on CONCRETE targets), and then every later operation on it, gate_release
       -- first of all, was refused as stale for ever. The Pod ran, the seam never opened, and
       -- nothing anywhere said why.
       AND ($2 OR NOT EXISTS (SELECT 1 FROM target_retirements r WHERE r.target_id = a.target_id))
     ORDER BY a.reserved_at DESC LIMIT 1`,
    [workstreamId, options.includeRetired === true],
  )
  return (result.rows[0] as { target_id?: string } | undefined)?.target_id
}

async function planFor(client: QueryClient, verb: Verb, context: VerbContext): Promise<VerbPlan> {
  switch (verb) {
    case 'BUILD': {
      const intentEvent = await loadLatestIntentEvent(client, context.workstreamId)
      const harnessId = (intentEvent?.intent as { harness?: unknown } | undefined)?.harness
      if (typeof harnessId !== 'string') throw new Error(`BUILD has no harness in the current Intent for ${context.workstreamId}`)
      const incarnation = await incarnationForBuild(client, context.workstreamId)
      return { operation: 'create_pod', target: { kind: 'reserved', id: incarnation }, payload: { harnessId } }
    }
    case 'TURN_OFF': {
      // CLEANUP includes retired incarnations, and must: "concrete-target cleanup stays authorized"
      // (engine.md). A Pod outlives its incarnation's retirement often enough — a cleanup whose
      // response was lost, a Pod that came back from a late create — and refusing to name it would
      // leave a real, running Pod that nothing in the system is able to remove.
      const incarnation = await currentIncarnation(client, context.workstreamId, { includeRetired: true })
      if (incarnation === undefined) throw new MissingIncarnationError(context.workstreamId, verb)
      return { operation: 'cleanup_pod', target: { kind: 'concrete', id: incarnation }, payload: {} }
    }
    case 'GRANT': {
      const incarnation = await currentIncarnation(client, context.workstreamId)
      if (incarnation === undefined) throw new MissingIncarnationError(context.workstreamId, verb)
      const intentEvent = await loadLatestIntentEvent(client, context.workstreamId)
      const capabilities = (intentEvent?.intent as { capabilities?: unknown } | undefined)?.capabilities
      return { operation: 'attach_grant', target: { kind: 'concrete', id: incarnation }, payload: { capabilityIds: Array.isArray(capabilities) ? capabilities : [] } }
    }
    case 'REVOKE': {
      // Revocation is cleanup too: withdrawing authority from a retired incarnation is exactly
      // what a shutdown does, and it is authorized on a retired target for that reason.
      const incarnation = await currentIncarnation(client, context.workstreamId, { includeRetired: true })
      if (incarnation === undefined) throw new MissingIncarnationError(context.workstreamId, verb)
      const intentEvent = await loadLatestIntentEvent(client, context.workstreamId)
      const capabilities = (intentEvent?.intent as { capabilities?: unknown } | undefined)?.capabilities
      return { operation: 'detach_grant', target: { kind: 'concrete', id: incarnation }, payload: { capabilityIds: Array.isArray(capabilities) ? capabilities : [] } }
    }
    case 'RESTORE':
    case 'START':
    case 'REFILL':
    case 'SET_MODEL':
    case 'SET_EFFORT':
      throw new UnwiredVerbError(verb)
  }
  throw new UnwiredVerbError(verb)
}

/** Operations whose unresolved attempt blocks conflicting positive work on the same target. */
const POSITIVE_OPERATIONS = new Set(['create_pod', 'attach_grant'])

export class OwnerVerbRunner implements VerbExecutor {
  constructor(private readonly options: VerbRunnerOptions) {}

  async execute(verb: Verb, context: VerbContext): Promise<void> {
    const pool = this.options.pool
    const plan = await planFor(pool, verb, context)

    // A retired target refuses POSITIVE work at the engine too — the owner would reject it; the
    // engine surfaces the typed cause instead of a generic owner error. Cleanup is deliberately
    // exempt, at both ends: "concrete-target cleanup stays authorized" (engine.md), and without the
    // exemption a Pod that outlives its incarnation's retirement is one nothing can ever remove.
    if (isPositiveOperation(plan.operation) && (await isRetired(pool, plan.target.id))) {
      throw new Error(`target_retired:${plan.target.id}`)
    }

    const epochRow = await pool.query('SELECT epoch FROM mutation_epochs WHERE workstream_id = $1', [context.workstreamId])
    const epoch: number = (epochRow.rows[0] as { epoch?: number } | undefined)?.epoch ?? 1
    const attemptKey = attemptKeyFor(verb, context)

    // RECOVERY FIRST (ENGINE-008). If this exact request is already outstanding — same operation,
    // same target, same payload digest — it is re-asked under its OWN key rather than reserved
    // again. The owner answers from its record if it has one, and executes if it never got that
    // far; either way the attempt stops being possibly-accepted, which is the only thing that
    // unblocks the next positive attempt on this target. Re-asking under a fresh key is explicitly
    // not an option: it would be a second create, not an answer about the first.
    const repeat = await unresolvedRepeatOf(pool, {
      workstreamId: context.workstreamId,
      operation: plan.operation,
      target: plan.target,
      payloadDigest: payloadDigest(plan.payload),
    })
    if (repeat !== undefined) {
      const reopened = await reopenAttemptForRecovery(pool, repeat.attemptKey)
      if (reopened) {
        // The CURRENT epoch, not the one it was first asked under: this is the current owner
        // re-asking, and an older epoch is exactly what an owner is required to reject.
        const { response } = await dispatchAttempt(
          pool,
          { ...repeat, epoch },
          { operation: plan.operation, payload: plan.payload, revisionSet: { attempt: repeat.attemptKey } },
          (request) => this.options.transport.send(this.options.transport.route(plan.operation), request),
          { epoch },
        )
        this.options.logger?.(`verb ${verb} re-asked unresolved attempt ${repeat.attemptKey} -> ${response?.kind ?? 'no response'}`)
        return
      }
    }

    const reserveClient = await pool.connect()
    let reservation: AttemptReservation
    try {
      await reserveClient.query('BEGIN')
      reservation = await reserveAttempt(reserveClient, {
        workstreamId: context.workstreamId,
        epoch,
        operation: plan.operation,
        target: plan.target,
        payload: plan.payload,
        revisionSet: { attempt: attemptKey },
        dispatchOwner: `attempt:${attemptKey}`,
        positive: POSITIVE_OPERATIONS.has(plan.operation),
      })
      await reserveClient.query('COMMIT')
    } catch (error) {
      await reserveClient.query('ROLLBACK').catch(() => {})
      reserveClient.release()
      throw error
    }
    reserveClient.release()

    const owner = this.options.transport.route(plan.operation)
    const { settled, response } = await dispatchAttempt(
      pool,
      reservation,
      { operation: plan.operation, payload: plan.payload, revisionSet: { attempt: attemptKey } },
      (request) => this.options.transport.send(owner, request),
    )

    if (response === null) {
      // dispatchAttempt marked this attempt superseded before ever calling the transport
      // (ENGINE-014: a request resolved under an old revision never reaches the owner).
      this.options.logger?.(`verb ${verb} attempt ${reservation.attemptKey} superseded before dispatch (stale revision)`)
      return
    }
    // The runner never selects a different verb on failure: the attempt state carries the truth
    // (settled/unknown, already recorded by dispatchAttempt) and the engine's backoff/budget
    // machinery decides what happens next (ENGINE-011 shape) — this is observability only.
    // A cleanup the owner completed retires the target HERE too. The owner records it in its own
    // ledger (that is what refuses later positive work on it), but nothing was writing the engine's
    // side, so `isRetired` never fired and `currentIncarnation` kept handing a dead incarnation to
    // the next BUILD. Both halves have to know, and the engine's half is what stops it being
    // chosen again in the first place.
    if ((response.kind === 'completed' || response.kind === 'accepted') && isCleanupOperation(plan.operation)) {
      await retireTarget(pool, context.workstreamId, plan.target.kind, plan.target.id, `${plan.operation}:${verb}`)
    }
    if (!settled || response.kind === 'rejected_stale_epoch' || response.kind === 'rejected_key_mismatch' || response.kind === 'unknown') {
      this.options.logger?.(`verb ${verb} attempt ${reservation.attemptKey} -> ${response.kind}`)
    }
  }

  /** Conditional-finalization helper: off convergence must wait for possibly accepted attempts. */
  async hasUnresolvedAttempts(workstreamId: string): Promise<boolean> {
    return hasUnresolvedAttempts(this.options.pool, workstreamId)
  }

  async markUnknown(attemptKey: string): Promise<boolean> {
    return markAttemptUnknown(this.options.pool, attemptKey)
  }
}
