// Retirement obligations (execution.md — Shutdown and physical extinction, P6): recorded with the
// original deadline, discharged only on termination evidence or verified fencing. Survives
// process restarts because it lives in PostgreSQL, not in memory.
import type pg from 'pg'
import type { K8sClient } from './k8s-client.js'
import type { ObligationStore, RetirementObligation } from './inventory.js'

export interface OutstandingObligation extends RetirementObligation {
  readonly workstreamId: string
}

export interface RuntimeObligationStore extends ObligationStore {
  discharge(podName: string, evidence: 'terminated' | 'fenced'): Promise<boolean>
  /** Every obligation not yet discharged, across every Workstream (S6 wakes/sweep: exhaustive). */
  allOutstanding(): Promise<readonly OutstandingObligation[]>
}

export class PgObligationStore implements RuntimeObligationStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(input: { podName: string; workstreamId: string; reason: string; deadline: Date; nodeName: string | null }): Promise<void> {
    await this.pool.query(
      `INSERT INTO retirement_obligations (pod_name, workstream_id, reason, deadline, node_name) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (pod_name) DO NOTHING`,
      [input.podName, input.workstreamId, input.reason, input.deadline, input.nodeName],
    )
  }

  async discharge(podName: string, evidence: 'terminated' | 'fenced'): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM retirement_obligations WHERE pod_name = $1 AND $2 IN (\'terminated\', \'fenced\')', [podName, evidence])
    return (result.rowCount ?? 0) === 1
  }

  async obligationsFor(workstreamId: string): Promise<readonly RetirementObligation[]> {
    const result = await this.pool.query(
      'SELECT pod_name, reason, deadline, node_name FROM retirement_obligations WHERE workstream_id = $1 ORDER BY deadline',
      [workstreamId],
    )
    return result.rows.map(toObligation)
  }

  async allOutstanding(): Promise<readonly OutstandingObligation[]> {
    const result = await this.pool.query('SELECT pod_name, workstream_id, reason, deadline, node_name FROM retirement_obligations ORDER BY deadline')
    return result.rows.map((row) => ({ ...toObligation(row), workstreamId: row['workstream_id'] as string }))
  }
}

function toObligation(row: { pod_name: string; reason: string; deadline: Date | string; node_name: string | null }): RetirementObligation {
  return { podName: row['pod_name'], reason: row['reason'], deadline: new Date(row['deadline']).toISOString(), nodeName: row['node_name'] }
}

export interface SweepResult {
  readonly checked: number
  readonly discharged: readonly string[]
}

/**
 * Bounded reconciliation sweep (engine.md — recovery sweeps continue for live resources): checks
 * every outstanding obligation against P6 termination evidence and discharges what it can prove.
 * A partitioned or NotReady node leaves the obligation unresolved — the inventory keeps reporting
 * the footprint. Never invents absence: getPod failing closed (thrown, not 404) leaves the
 * obligation exactly where it was.
 */
export async function sweepRetirementObligations(k8s: K8sClient, obligations: RuntimeObligationStore): Promise<SweepResult> {
  const outstanding = await obligations.allOutstanding()
  const discharged: string[] = []
  for (const obligation of outstanding) {
    let pod
    try {
      pod = await k8s.getPod(obligation.podName)
    } catch {
      continue // apiserver unreachable: no evidence either way, obligation stays exactly as is.
    }
    if (pod !== undefined) {
      const status = pod['status'] as { phase?: string; containerStatuses?: readonly { state?: { terminated?: unknown } }[] } | undefined
      const terminal = status?.phase === 'Succeeded' || status?.phase === 'Failed'
      const allTerminated = (status?.containerStatuses ?? []).length > 0 && (status?.containerStatuses ?? []).every((c) => c.state?.terminated !== undefined)
      if (terminal && allTerminated) {
        if (await obligations.discharge(obligation.podName, 'terminated')) discharged.push(obligation.podName)
      }
      continue
    }
    // The Pod is gone from the API entirely. It was never scheduled (no node ever hosted it, so
    // no partition can be hiding a still-running process) — its absence alone is unambiguous.
    if (obligation.nodeName === null) {
      if (await obligations.discharge(obligation.podName, 'terminated')) discharged.push(obligation.podName)
      continue
    }
    // Otherwise only a node confirmed Ready now corroborates the kubelet actually reporting the
    // Pod gone, rather than a partition hiding a process that is still running.
    const node = await k8s.getNode(obligation.nodeName)
    const conditions = (node?.['status'] as { conditions?: readonly { type?: string; status?: string }[] } | undefined)?.conditions ?? []
    const ready = conditions.find((c) => c.type === 'Ready')?.status === 'True'
    if (ready && (await obligations.discharge(obligation.podName, 'terminated'))) discharged.push(obligation.podName)
  }
  return { checked: outstanding.length, discharged }
}
