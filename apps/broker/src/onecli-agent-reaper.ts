import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { recordAudit } from './audit.js'
import type { OneCliControlAdapter } from './onecli-adapter.js'
import { listLiveOnecliAgentIdentifiers } from './onecli-agents-repository.js'

/**
 * ADR 0015 / P13: reconciles OneCLI's Agent inventory against the Agents this Broker still owns,
 * and deletes the ones it does not.
 *
 * Why it is needed at all: `revokeExecutionGrant` deletes a Session's Agent, but nothing did when
 * a Broker crashed between `ensureSelectiveAgent` and the grant row, when a revoke's OneCLI call
 * failed (revocation deliberately does not depend on OneCLI succeeding), or when a Session was
 * cleaned up by another path. The instance this plan was written against had **15** such orphans
 * live. Under `secretMode: all` that was untidy; under grants each orphan is a standing Agent
 * access token attached to real provider credentials, so leaving them is a security debt, not
 * housekeeping.
 *
 * This is NOT `apps/web/src/idle-reaper.ts`, which suspends idle Agora Sessions — a different
 * object with a different lifecycle. Nothing here ever touches a Session.
 *
 * WHAT THIS NO LONGER DOES, and it is the important part. It used to decide, on its own timers,
 * that a Session had been quiet long enough for its Agent to be forfeit. It got that decision
 * wrong in the only way that matters: it deleted the Agents of Sessions that were merely
 * suspended, and every one of them then failed to resume (2026-08-11: 14 out of 14). An Agent's
 * lifecycle is now driven by the Session Runtime's own — provisioned on issue/renew, released on
 * suspend, deleted on revoke — so the component that decides a Runtime's fate is the component
 * that decides its Agent's. This reaper decides nothing about Sessions any more; it reconciles.
 *
 * Two safety rails remain, both deliberate:
 *
 * 1. **Only `sagt-` Agents.** That prefix is `grant-service.ts`'s own derivation
 *    (`onecliIdentifierFor`). The operator's `default` Agent, and anything a human created in the
 *    OneCLI dashboard, are never candidates — this reaper cleans up after Agora, not after people.
 * 2. **A grace window on OneCLI's own `createdAt`.** `ensureSelectiveAgent` necessarily runs
 *    before `ensureOnecliAgentMapping` commits, so an Agent for an in-flight issue exists in
 *    OneCLI for a moment while the Broker has no row for it yet. Anything younger than the window
 *    is left alone, so a concurrent issue can never be reaped out from under itself. This window
 *    is now the ONLY thing standing between a legitimate Agent and deletion, which is exactly why
 *    the protection set it complements is a single unambiguous column rather than a heuristic.
 */
export const ORPHAN_GRACE_MS = 15 * 60 * 1000

/**
 * How long an `active` mapping that has NO grant row is given before it counts as stranded rather
 * than in-flight. It only ever applies to that one shape (a Broker crash between the mapping
 * insert and the grant insert); a mapping that HAS a grant is owned by the Session lifecycle and
 * is never aged out here, however long ago that grant expired.
 */
export const UNGRANTED_MAPPING_STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** `grant-service.ts#onecliIdentifierFor` — the only Agents Agora itself creates. */
const AGORA_AGENT_PREFIX = 'sagt-'

export interface ReapResult {
  readonly scanned: number
  readonly reaped: readonly string[]
  /** Orphans that were within the grace window, left for a later cycle. */
  readonly skippedTooYoung: number
}

/**
 * One reconciliation pass. Fail-soft per Agent: a delete OneCLI refuses is logged as a denied
 * audit row and the pass continues, because one stuck Agent must not stop the other orphans from
 * being cleaned up. A failure to LIST is a hard error — an empty list must never be read as "every
 * Agent is an orphan", which would delete every live Session's credential authority.
 */
export async function reapOrphanOnecliAgents(pool: pg.Pool, onecli: OneCliControlAdapter, now: Date): Promise<ReapResult> {
  const agents = await onecli.listAgents()

  const client = await pool.connect()
  let live: readonly string[]
  try {
    live = await listLiveOnecliAgentIdentifiers(client, new Date(now.getTime() - UNGRANTED_MAPPING_STALE_AFTER_MS))
  } finally {
    client.release()
  }
  const protectedIdentifiers = new Set(live)

  const candidates = agents.filter((agent) => agent.identifier.startsWith(AGORA_AGENT_PREFIX) && !protectedIdentifiers.has(agent.identifier))
  const tooYoung = candidates.filter((agent) => now.getTime() - agent.createdAt.getTime() < ORPHAN_GRACE_MS)
  const reapable = candidates.filter((agent) => now.getTime() - agent.createdAt.getTime() >= ORPHAN_GRACE_MS)

  const reaped: string[] = []
  for (const agent of reapable) {
    let failure: string | undefined
    try {
      await onecli.deleteAgent(agent.identifier)
      reaped.push(agent.identifier)
    } catch (error) {
      failure = error instanceof Error ? error.name : 'unknown_error'
    }
    const auditClient = await pool.connect()
    try {
      await recordAudit(auditClient, {
        id: randomUUID(),
        actorKind: 'system',
        actorId: 'onecli-agent-reaper',
        sessionId: null,
        actionClass: 'onecli_agent.reap',
        decision: failure ? 'denied' : 'approved',
        policyVersion: null,
        // The identifier is a SHA-256 prefix of the Session id, never the Session id itself, and
        // carries no credential material.
        detail: failure ? { onecliIdentifier: agent.identifier, code: failure } : { onecliIdentifier: agent.identifier },
        createdAt: now,
      })
    } finally {
      auditClient.release()
    }
  }

  return { scanned: agents.length, reaped, skippedTooYoung: tooYoung.length }
}

export interface ReaperHandle {
  stop(): void
}

/**
 * Runs one pass immediately (Broker startup is exactly when orphans from a crashed predecessor are
 * most likely) and then every `intervalMs`. Never throws into the caller: a reap failure is
 * operational noise, not a reason to take the Broker down — the next cycle retries.
 */
export function startOrphanAgentReaper(pool: pg.Pool, onecli: OneCliControlAdapter, intervalMs: number, onError?: (error: unknown) => void): ReaperHandle {
  const run = (): void => {
    void reapOrphanOnecliAgents(pool, onecli, new Date()).catch((error: unknown) => onError?.(error))
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
