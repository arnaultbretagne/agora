// The arithmetic of an execution's deadline and token (docs/specs/executions.md, "The deadline"; docs/specs/credentials.md,
// "Between turns"), apart from the clock and the log, so that hours of a sandbox's life can be played step by step.
import type { ProcessView } from '@agora/harness-bridge/processes'

/** The deadline a move sets: a lease from now, never beyond the ceiling, six hours after the last prompt by default. */
export function nextDeadline(now: number, leaseSeconds: number, lastPrompt: number, ceilingSeconds: number): number {
  return Math.min(now + leaseSeconds * 1000, lastPrompt + ceilingSeconds * 1000)
}

/** An execution's token's life: an hour by default, never under three leases, so that a renewal is not due at every step. */
export function tokenLife(tokenSeconds: number, leaseSeconds: number): number {
  return Math.max(tokenSeconds, 3 * leaseSeconds)
}

/** A new token is due when the deadline about to be set comes within half a token's life of the end of the one in place. */
export function tokenDue(heldUntil: number, deadline: number, lifeSeconds: number): boolean {
  return heldUntil - deadline < (lifeSeconds / 2) * 1000
}

/** The same process in two listings: its pid, and a start the bridge estimates to the hundredth of a second, read twice. */
const same = (a: Pick<ProcessView, 'pid' | 'startedAt'>, b: Pick<ProcessView, 'pid' | 'startedAt'>): boolean =>
  a.pid === b.pid && Math.abs(Date.parse(a.startedAt) - Date.parse(b.startedAt)) < 1000

/**
 * Whether the agent's work still runs: a process the bridge lists now that it did not list as the first prompt left — what
 * ran then is the harness's own. Both listings are the bridge's, read on its own clock.
 */
export function working(now: readonly ProcessView[], baseline: readonly Pick<ProcessView, 'pid' | 'startedAt'>[]): boolean {
  return now.some((p) => !baseline.some((b) => same(p, b)))
}
