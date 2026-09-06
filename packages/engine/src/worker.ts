// Worker evaluation (ADR 0003 tick, engine contract): claim a bounded batch, load the pointed-to
// Intent, build a fresh ObservationReader per row, evaluate the ordered rules, and dispatch the
// outcome. The executor is called outside any transaction — the worker only issues single
// autonomous statements, so no transaction is ever held across the executor.
import { evaluate, harnessId, type Intent, type RuleResolution } from '@agora/domain'
import type pg from 'pg'
import { DEFAULT_BACKOFF, backoffDelayMs, type BackoffPolicy } from './backoff.js'
import { errorMessage } from './db.js'
import { loadIntentEvent, notifyTick, type EngineTimeOptions, type SerializedIntent } from './authoring.js'
import type { ObservationSource } from './observation-source.js'
import { claimDue, finalize, release, reschedule, type ClaimedWorkRow } from './workset.js'
import { hasUnresolvedAttempts } from './attempts.js'
import type { VerbContext, VerbExecutor } from './verb-executor.js'

export type WorkerOutcome = 'finalized' | 'action' | 'hold' | 'retry' | 'acquisition' | 'blocked' | 'stale'

export interface ScanSummary extends Record<WorkerOutcome, number> {
  readonly claimed: number
}

export interface WorkerOptions extends EngineTimeOptions {
  readonly pool: pg.Pool
  readonly observationSource: ObservationSource
  readonly executor: VerbExecutor
  readonly resolve: RuleResolution
  readonly backoff?: BackoffPolicy
  readonly claimBatch?: number
  readonly leaseMs?: number
  readonly logger?: (message: string) => void
}

function toDomainIntent(serialized: SerializedIntent): Intent | null {
  if ((serialized.power !== 'on' && serialized.power !== 'off') || serialized.persona !== 'default' || !Array.isArray(serialized.capabilities)) {
    return null
  }
  return {
    power: serialized.power,
    harness: harnessId(serialized.harness),
    capabilities: new Set(serialized.capabilities),
    model: serialized.model,
    effort: serialized.effort,
    persona: 'default',
  }
}

export function createScan(options: WorkerOptions): () => Promise<ScanSummary> {
  const now = options.nowSql ?? 'now()'
  const policy = options.backoff ?? DEFAULT_BACKOFF
  const logger = options.logger ?? (() => {})

  return async (): Promise<ScanSummary> => {
    const claimed = await claimDue(options.pool, {
      limit: options.claimBatch ?? 8,
      leaseMs: options.leaseMs ?? 30_000,
      nowSql: options.nowSql,
    })
    const summary: ScanSummary = { claimed: claimed.length, finalized: 0, action: 0, hold: 0, retry: 0, acquisition: 0, blocked: 0, stale: 0 }
    for (const row of claimed) {
      try {
        summary[await processRow(options, policy, logger, row, now)] += 1
      } catch (error) {
        logger(`worker error on workstream ${row.workstreamId}: ${errorMessage(error)}`)
        const handled = await reschedule(options.pool, row, {
          delayMs: policy.recheckDelayMs,
          attemptCount: row.attemptCount,
          blockingCause: 'worker_error',
          lastError: { message: errorMessage(error) },
          nowSql: options.nowSql,
        })
        summary[handled ? 'blocked' : 'stale'] += 1
      }
    }
    return summary
  }
}

async function processRow(
  options: WorkerOptions,
  policy: BackoffPolicy,
  logger: (message: string) => void,
  row: ClaimedWorkRow,
  now: string,
): Promise<WorkerOutcome> {
  const { pool, observationSource, executor, resolve } = options
  const ref = { workstreamId: row.workstreamId, claimToken: row.claimToken, workGeneration: row.workGeneration }

  const event = await loadIntentEvent(pool, row.workstreamId, row.intentSeq)
  if (event === null) {
    await reschedule(pool, ref, {
      delayMs: policy.recheckDelayMs,
      attemptCount: row.attemptCount,
      blockingCause: 'missing_intent',
      lastError: { intentSeq: row.intentSeq },
      nowSql: options.nowSql,
    })
    return 'blocked'
  }
  const intent = toDomainIntent(event.intent)
  if (intent === null) {
    await reschedule(pool, ref, {
      delayMs: policy.recheckDelayMs,
      attemptCount: row.attemptCount,
      blockingCause: 'invalid_intent',
      lastError: { intentSeq: row.intentSeq },
      nowSql: options.nowSql,
    })
    return 'blocked'
  }

  // One fresh reader per tick: no evidence is carried across ticks (engine contract).
  const reader = await observationSource.reader(row.workstreamId)
  const evaluation = evaluate(intent, reader, resolve)

  if (evaluation.kind === 'acquisition_incomplete') {
    const handled = await reschedule(pool, ref, {
      delayMs: backoffDelayMs(policy, 1),
      attemptCount: row.attemptCount,
      blockingCause: `acquisition:${evaluation.field}`,
      lastError: { field: evaluation.field, reason: evaluation.reason, rule: evaluation.rule },
      nowSql: options.nowSql,
    })
    return handled ? 'acquisition' : 'stale'
  }

  const { rule, result } = evaluation
  if (result.kind === 'CONVERGED') {
    // Conditional finalization: an off conclusion cannot land while an attempt is possibly
    // accepted (ENGINE-008/018) — the row stays due and the engine keeps watching.
    const unresolved = await hasUnresolvedAttempts(pool, row.workstreamId)
    if (unresolved) {
      await reschedule(pool, ref, {
        delayMs: backoffDelayMs(policy, 1),
        attemptCount: row.attemptCount,
        blockingCause: 'unresolved_owner_attempts',
        lastError: null,
        nowSql: options.nowSql,
      })
      return 'blocked'
    }
    const finalized = await finalize(pool, { ...ref, intentSeq: row.intentSeq })
    return finalized ? 'finalized' : 'stale'
  }
  if (result.kind === 'HOLD') {
    const handled = await reschedule(pool, ref, {
      delayMs: backoffDelayMs(policy, 1),
      attemptCount: row.attemptCount,
      blockingCause: null,
      lastError: null,
      nowSql: options.nowSql,
    })
    logger(`workstream ${row.workstreamId} holds at ${rule}`)
    return handled ? 'hold' : 'stale'
  }
  if (result.kind !== 'ACTION') {
    throw new Error(`rule ${rule} produced an unknown result kind`)
  }

  if (row.attemptCount >= policy.maxAttempts) {
    // Exhausted budget: durable bounded recheck, the unchanged action is not repeated (ENGINE-011).
    const handled = await reschedule(pool, ref, {
      delayMs: policy.recheckDelayMs,
      attemptCount: row.attemptCount,
      blockingCause: row.blockingCause ?? `action_exhausted:${result.verb}`,
      lastError: row.lastError,
      nowSql: options.nowSql,
    })
    return handled ? 'blocked' : 'stale'
  }

  const context: VerbContext = {
    workstreamId: row.workstreamId,
    intentSeq: row.intentSeq,
    workGeneration: row.workGeneration,
    claimToken: row.claimToken,
    rule,
  }
  try {
    await executor.execute(result.verb, context)
  } catch (error) {
    const attemptCount = row.attemptCount + 1
    const exhausted = attemptCount >= policy.maxAttempts
    const handled = await reschedule(pool, ref, {
      delayMs: exhausted ? policy.recheckDelayMs : backoffDelayMs(policy, attemptCount),
      attemptCount,
      blockingCause: exhausted ? `action_exhausted:${result.verb}` : null,
      lastError: { verb: result.verb, rule, attempt: attemptCount, message: errorMessage(error) },
      nowSql: options.nowSql,
    })
    logger(`workstream ${row.workstreamId} action ${result.verb} failed: ${errorMessage(error)}`)
    return handled ? (exhausted ? 'blocked' : 'retry') : 'stale'
  }

  // The action attempt ended: conditionally release for the continuation tick and emit it. Zero
  // rows means a newer wake or Intent exists — the old completion must not postpone it (ENGINE-015).
  const released = await release(pool, ref, { dueNow: true, nowSql: options.nowSql })
  await notifyTick(pool)
  logger(`workstream ${row.workstreamId} executed ${result.verb} selected by ${rule}`)
  return released ? 'action' : 'stale'
}
