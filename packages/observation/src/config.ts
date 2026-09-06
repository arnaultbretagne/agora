// observation.model / observation.effort (002 Observation; S8 Step 3): the actual current values
// of a live ACP context's config options, under the snapshot/continuous-stream freshness contract
// (execution.md). This module is deliberately thin — the freshness proof (is this snapshot from
// the CURRENT live context, not a stale one) is the caller's job, using the same process-generation
// check session.ts already makes; a value handed here is trusted as already fresh.
export interface ConfigSnapshot {
  readonly model: string
  readonly effort: string
}

/** `null` (defined only when observation.session = live) — the caller passes no snapshot when it isn't. */
export function normalizeModel(snapshot: ConfigSnapshot | null): string | null {
  return snapshot?.model ?? null
}

export function normalizeEffort(snapshot: ConfigSnapshot | null): string | null {
  return snapshot?.effort ?? null
}
