// Admission checklist (S8 Step 4 — execution.md "Session birth and admission"): checked at every
// prompt dispatch (Handoff admission is the same check, S9). Re-runs the SAME rule evaluation the
// reconciliation worker itself uses (packages/domain's evaluate(), POWER through CONVERGE) against
// FRESH observation, never a cached verdict from the last tick — "a database commit alone cannot
// reopen a stale path" (execution.md). Admission is granted iff evaluation reaches `CONVERGED`:
// every domain the current Intent covers is currently, actually true, verified this instant. Two
// rows can produce `CONVERGED` — CONVERGE-001 (the normal "everything matches" path) and POWER-001
// (an off Intent already off, converged before construction/session/config/sync are ever reached,
// 004_power.md) — admission checks the RESULT, not which rule produced it; this module never
// re-derives the battery of checks itself and never widens or narrows what CONVERGED already means,
// it is a consumer of the rule tables, not a second copy of them.
import { evaluate, type Intent, type ObservationReader, type RuleResolution } from '@agora/domain'
import type { ObservationSource } from '@agora/engine'

export type AdmissionDecision = { readonly admitted: true } | { readonly admitted: false; readonly reason: string }

export async function checkAdmission(observationSource: ObservationSource, workstreamId: string, intent: Intent, resolve: RuleResolution): Promise<AdmissionDecision> {
  const reader: ObservationReader = await observationSource.reader(workstreamId)
  const evaluation = evaluate(intent, reader, resolve)
  if (evaluation.kind === 'result' && evaluation.result.kind === 'CONVERGED') return { admitted: true }
  if (evaluation.kind === 'acquisition_incomplete') {
    return { admitted: false, reason: `${evaluation.field} is ${evaluation.reason} (${evaluation.rule} could not read it)` }
  }
  const resultDescription = evaluation.result.kind === 'ACTION' ? `ACTION(${evaluation.result.verb})` : evaluation.result.kind
  return { admitted: false, reason: `not yet converged: ${evaluation.rule} selected ${resultDescription}` }
}
