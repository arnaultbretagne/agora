// docs/specs/executions.md, "How an execution ended": the cause `execution.ended` names, read from what the
// log holds and what the mechanics saw of the claim and its Pod; and the words that say it.
import type { Observed } from '@agora/executions'
import { object, schemaValue } from './json.ts'

/** The causes, closed (docs/specs/log.md, "Entries"). */
export type CauseKind = 'bound_reached' | 'lease_expired' | 'adapter_exited' | 'agent_failed' | 'oom_killed' | 'pod_gone' | 'stopped' | 'unobserved'

export interface Cause {
  readonly kind: CauseKind
  /** `lease_expired`: a turn was running, the last one had ended, or none had been dispatched. */
  readonly turn?: 'running' | 'ended' | 'none'
  /** `adapter_exited`: as the bridge's `/info` gave them, null when unknown. */
  readonly exitCode?: number | null
  readonly signal?: string | null
  /** `pod_gone`: the Pod's reason when one was seen (`Evicted`, `Deleted`, `Error`), null otherwise. */
  readonly pod?: string | null
}

/** A deadline within this of the bound is the bound: both are computed from the same turn, a few ms apart. */
const TOLERANCE_MS = 1500

export interface EndFacts {
  /** The execution's `execution.lost` content, if it was lost. */
  readonly lost: Record<string, unknown> | null
  readonly stopped: boolean
  /** Its turn still running as the claim disappears, with the bound Agora sets on its deadline. */
  readonly running: { readonly bound: number } | null
  /** It dispatched a turn before. */
  readonly prompted: boolean
  readonly observed: Observed | null
  readonly now: number
}

/**
 * Why the claim disappeared, the first that applies: the agent's own end (the deadline moved to now for it),
 * the Pod killed for lack of memory, nothing seen of the claim, the Pod gone before its deadline, the person's
 * Stop, the bound reached during a turn, else the lease run out.
 */
export function causeOf(facts: EndFacts): Cause {
  const { observed } = facts
  // Numbers read back from the log are lossless: plain ones here.
  const lost = object(schemaValue(facts.lost))
  if (lost?.reason === 'adapter_exited')
    return { kind: 'adapter_exited', exitCode: typeof lost.exitCode === 'number' ? lost.exitCode : null, signal: typeof lost.signal === 'string' ? lost.signal : null }
  if (lost?.reason === 'agent_failed') return { kind: 'agent_failed' }
  if (observed?.pod?.reason === 'OOMKilled') return { kind: 'oom_killed' }
  if (observed === null) return { kind: 'unobserved' }
  const deadline = Date.parse(observed.claim.spec?.lifecycle?.shutdownTime ?? '')
  const deleted = Date.parse(observed.claim.metadata.deletionTimestamp ?? '') || facts.now
  if (observed.pod !== null || !(deleted >= deadline - TOLERANCE_MS)) return { kind: 'pod_gone', pod: observed.pod?.reason ?? null }
  if (facts.stopped) return { kind: 'stopped' }
  if (facts.running !== null && deadline >= facts.running.bound - TOLERANCE_MS) return { kind: 'bound_reached' }
  return { kind: 'lease_expired', turn: facts.running !== null ? 'running' : facts.prompted ? 'ended' : 'none' }
}

/** How the agent's process ended: its exit code, or the signal that killed it. */
export function exitText(exitCode: unknown, signal: unknown): string {
  if (typeof signal === 'string' && signal !== '') return `the agent's process was killed by ${signal}`
  if (typeof exitCode === 'number') return `the agent's process exited with code ${String(exitCode)}`
  return `the agent's process exited`
}

/** The cause in words, lower case, no final stop: what follows "ended: " or "failed: ". */
export function causeText(cause: unknown): string {
  const c = object(schemaValue(cause))
  switch (c?.kind) {
    case 'bound_reached':
      return 'its sandbox reached its time bound'
    case 'lease_expired':
      return c.turn === 'running'
        ? "its sandbox's lease expired during the turn, not renewed"
        : c.turn === 'none'
          ? "its sandbox's lease expired before any turn"
          : "its sandbox's lease expired after the turn"
    case 'adapter_exited':
      return exitText(c.exitCode, c.signal)
    case 'agent_failed':
      return 'the agent stopped on an internal error'
    case 'oom_killed':
      return 'its Pod was killed for lack of memory (OOMKilled)'
    case 'pod_gone':
      return typeof c.pod === 'string' ? `its Pod was gone before its deadline (${c.pod})` : 'its Pod was gone before its deadline'
    case 'stopped':
      return 'the person stopped it'
    case 'unobserved':
      return 'its sandbox ended while Agora was not running'
    default:
      return 'its sandbox ended'
  }
}

/** Why an execution was lost, in words, lower case: what follows "lost: ". */
export function lostText(lost: unknown): string {
  const l = object(schemaValue(lost))
  switch (l?.reason) {
    case 'adapter_exited':
      return exitText(l.exitCode, l.signal)
    case 'agent_failed':
      return 'the agent stopped on an internal error'
    case 'claim_conflict':
    case 'instance_changed':
      return 'its sandbox was replaced'
    default:
      return 'its sandbox was lost'
  }
}
