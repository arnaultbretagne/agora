// The conformance table, verbatim from execution.md ("Harness and owner conformance"). It is data
// here so a report can say which required behavior each check answers for, and so a row with no
// runnable check is visibly unanswered rather than silently absent.
export type ConformanceRowId =
  | 'launch-and-identity'
  | 'configuration-and-bootstrap'
  | 'quiescence-and-delivery'
  | 'continuity-and-custody'
  | 'isolation-and-onecli'
  | 'ownership-and-recovery'

export interface ConformanceRow {
  readonly id: ConformanceRowId
  readonly requiredBehavior: string
  readonly evidenceBeforeEnablement: string
}

export const CONFORMANCE_TABLE: readonly ConformanceRow[] = [
  {
    id: 'launch-and-identity',
    requiredBehavior: 'Launch and identity',
    evidenceBeforeEnablement: 'Gated Pod before ACP; stable incarnation correlation; bounded startup and safe process-loss retirement',
  },
  {
    id: 'configuration-and-bootstrap',
    requiredBehavior: 'Configuration and bootstrap',
    evidenceBeforeEnablement: 'Actual fresh/restored values, dependent options, default persona and declared provider prerequisites',
  },
  {
    id: 'quiescence-and-delivery',
    requiredBehavior: 'Quiescence and delivery',
    evidenceBeforeEnablement: 'Bounded local drain/fencing; old callback attribution; unknown acceptance recovery without blind resend',
  },
  {
    id: 'continuity-and-custody',
    requiredBehavior: 'Continuity and custody',
    evidenceBeforeEnablement: 'Consistent capture/restore, compatibility, exclusions and verifiable native input lineage across supported compaction',
  },
  {
    id: 'isolation-and-onecli',
    requiredBehavior: 'Isolation and OneCLI',
    evidenceBeforeEnablement: 'Actual allowed/denied provider operations, attached/effective comparison, revoked existing tunnels and rejected bypass paths',
  },
  {
    id: 'ownership-and-recovery',
    requiredBehavior: 'Ownership and recovery',
    evidenceBeforeEnablement: 'Late creation/mutation discovery, stale-writer fencing, missed-watch recovery and physical extinction proof',
  },
] as const
