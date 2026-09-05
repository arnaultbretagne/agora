// Bounded exponential backoff with jitter and a per-row attempt budget. The values here are S2
// working defaults; the deployment must pin claim duration, backoff cap and recheck bounds before
// acceptance (engine contract "Retry budgets and fairness") — S11 owns that pinning.
export interface BackoffPolicy {
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
  readonly maxAttempts: number
  readonly recheckDelayMs: number
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.25,
  maxAttempts: 5,
  recheckDelayMs: 300_000,
}

export function backoffDelayMs(policy: BackoffPolicy, attempt: number, random: () => number = Math.random): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(policy.maxDelayMs, exponential)
  return Math.round(capped * (1 + policy.jitterRatio * random()))
}
