// Runtime-control's own owner record (engine.md — the owner request protocol; P5): persists
// exactly the shape packages/owner-requests' decideOwnerRequest/recordOwnerResponse need, one
// request at a time — no full-table load. Stale epochs and reused attempt keys are rejected here,
// before any Kubernetes call; a reused key with a matching digest returns the recorded response
// without calling Kubernetes again (idempotent replay, ENGINE-007 shape).
import type pg from 'pg'
import {
  decideOwnerRequest,
  recordOwnerResponse,
  type OwnerDecision,
  type OwnerRecord,
  type OwnerRequest,
  type OwnerResponse,
} from '@agora/owner-requests'

export interface OwnerGate {
  /** The pure gate's decision for this request, loaded from this owner's own persisted record. */
  decide(request: OwnerRequest): Promise<OwnerDecision>
  /** Persists the response this owner produced, advancing the recorded epoch. */
  record(request: OwnerRequest, response: OwnerResponse): Promise<void>
  /** Marks a concrete target retired: positive operations against it are refused from now on. */
  retire(workstreamId: string, targetId: string): Promise<void>
}

export class PgOwnerGate implements OwnerGate {
  constructor(private readonly pool: pg.Pool) {}

  async decide(request: OwnerRequest): Promise<OwnerDecision> {
    const record = await this.#loadRecordFor(request)
    return decideOwnerRequest({ record, request })
  }

  async record(request: OwnerRequest, response: OwnerResponse): Promise<void> {
    // recordOwnerResponse only touches responses/epoch for this one attempt key — the minimal
    // record loaded here is enough to compute exactly what changed.
    const before = await this.#loadRecordFor(request)
    const after = recordOwnerResponse(before, request, response)
    await this.pool.query(
      `INSERT INTO runtime_control_epochs (workstream_id, epoch) VALUES ($1, $2)
       ON CONFLICT (workstream_id) DO UPDATE SET epoch = GREATEST(runtime_control_epochs.epoch, EXCLUDED.epoch)`,
      [request.workstreamId, after.epoch],
    )
    await this.pool.query(
      `INSERT INTO runtime_control_attempts (attempt_key, workstream_id, payload_digest, response) VALUES ($1, $2, $3, $4)
       ON CONFLICT (attempt_key) DO NOTHING`,
      [request.attemptKey, request.workstreamId, request.payloadDigest, JSON.stringify(response)],
    )
  }

  async retire(workstreamId: string, targetId: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO runtime_control_retired_targets (target_id, workstream_id) VALUES ($1, $2) ON CONFLICT (target_id) DO NOTHING',
      [targetId, workstreamId],
    )
  }

  async #loadRecordFor(request: OwnerRequest): Promise<OwnerRecord> {
    const [epochResult, attemptResult, retiredResult] = await Promise.all([
      this.pool.query('SELECT epoch FROM runtime_control_epochs WHERE workstream_id = $1', [request.workstreamId]),
      this.pool.query('SELECT payload_digest, response FROM runtime_control_attempts WHERE attempt_key = $1', [request.attemptKey]),
      this.pool.query('SELECT 1 FROM runtime_control_retired_targets WHERE target_id = $1', [request.target.id]),
    ])
    const responses = new Map<string, { digest: string; response: OwnerResponse }>()
    const attemptRow = attemptResult.rows[0] as { payload_digest: string; response: OwnerResponse } | undefined
    if (attemptRow !== undefined) responses.set(request.attemptKey, { digest: attemptRow.payload_digest, response: attemptRow.response })
    const retiredTargets = new Map<string, { readonly positiveBlocked: true }>()
    if (retiredResult.rows.length > 0) retiredTargets.set(request.target.id, { positiveBlocked: true })
    const epochRow = epochResult.rows[0] as { epoch: string | number } | undefined
    return { epoch: epochRow !== undefined ? Number(epochRow.epoch) : 0, responses, retiredTargets }
  }
}
