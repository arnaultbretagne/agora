// The verb runner (S5): a verb becomes one or more owner requests under one attempt key, each
// verifying ownership and preconditions. It returns no reconciliation value — the engine emits the
// continuation tick after the attempt ends. Per-verb recovery encodes each verb's "Idempotency and
// recovery" paragraph (003 verbs); the ACP-facing recovery bodies stay stubs until S8/S9 wire them.
import type pg from 'pg'
import type { Verb } from '@agora/domain'
import type { VerbContext, VerbExecutor } from './verb-executor.js'
import { OwnerClient, type OwnerRequest, type OwnerResponse } from '@agora/owner-requests'
import { isRetired } from './retirement.js'
import { dispatchAttempt, hasUnresolvedAttempts, markAttemptUnknown, reserveAttempt, type AttemptReservation } from './attempts.js'

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

interface VerbPlan {
  readonly operation: string
  readonly target: OwnerTargetSpec
  readonly payload: Record<string, unknown>
}

interface OwnerTargetSpec {
  readonly kind: 'concrete' | 'reserved'
  readonly id: string
}

/**
 * Per-verb request plans. BUILD creates on a reserved slot; TURN_OFF/REVOKE/GRANT act on concrete
 * targets (Pod UID / Agent id); RESTORE/START/REFILL/SET_* are ACP-facing and remain explicit
 * stubs — their recovery functions arrive with S8/S9 and until then fail typed, never silently.
 */
/** The attempt identity is stable per (Workstream, rule, generation): a retry under the same generation keeps the key. */
export function attemptKeyFor(verb: Verb, context: VerbContext): string {
  return `${context.workstreamId}/${verb}/${context.rule}/${context.workGeneration}`
}

function planFor(verb: Verb, context: VerbContext): VerbPlan {
  switch (verb) {
    case 'BUILD':
      return { operation: 'create_pod', target: { kind: 'reserved', id: `slot:${context.workstreamId}:${context.intentSeq}` }, payload: { workstreamId: context.workstreamId, intentSeq: context.intentSeq } }
    case 'TURN_OFF':
      return { operation: 'cleanup_pod', target: { kind: 'concrete', id: `pod:${context.workstreamId}` }, payload: { workstreamId: context.workstreamId } }
    case 'GRANT':
      return { operation: 'attach_grant', target: { kind: 'concrete', id: `agent:${context.workstreamId}` }, payload: { workstreamId: context.workstreamId } }
    case 'REVOKE':
      return { operation: 'detach_grant', target: { kind: 'concrete', id: `agent:${context.workstreamId}` }, payload: { workstreamId: context.workstreamId } }
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
    const plan = planFor(verb, context)
    const nowSql = this.options.nowSql ?? 'now()'
    const pool = this.options.pool

    if (await isRetired(pool, plan.target.id)) {
      // A retired target refuses positive work at the engine too — the owner would reject it; the
      // engine surfaces the typed cause instead of a generic owner error.
      throw new Error(`target_retired:${plan.target.id}`)
    }

    const epochRow = await pool.query('SELECT epoch FROM mutation_epochs WHERE workstream_id = $1', [context.workstreamId])
    const epoch: number = epochRow.rows[0]?.['epoch'] ?? 1

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
        revisionSet: { attempt: attemptKeyFor(verb, context) },
        dispatchOwner: `attempt:${attemptKeyFor(verb, context)}`,
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
    const client = new OwnerClient((request) => this.options.transport.send(owner, request))
    const { response } = await client.submit({
      epoch,
      workstreamId: context.workstreamId,
      attemptKey: reservation.attemptKey,
      operation: plan.operation,
      target: plan.target,
      payload: plan.payload,
      payloadDigest: reservation.payloadDigest,
      revisionSet: { attempt: attemptKeyFor(verb, context) },
    })

    if (response.kind === 'rejected_stale_epoch' || response.kind === 'rejected_key_mismatch' || response.kind === 'unknown') {
      // The runner never selects a different verb on failure: the attempt state carries the truth
      // and the engine's backoff/budget machinery decides what happens next (ENGINE-011 shape).
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
