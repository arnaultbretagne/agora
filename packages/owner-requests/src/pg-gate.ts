// Postgres-backed owner record (engine.md — the owner request protocol; P5): every owner (runtime
// control S6, broker S7) embeds this instead of re-deciding the contract. One request loads only
// the three rows decideOwnerRequest actually needs — never the whole table — so a stale epoch or a
// reused attempt key with a different payload is rejected before any downstream call, and a reused
// key with a matching digest replays the recorded response without repeating it.
import type pg from 'pg'
import { decideOwnerRequest, recordOwnerResponse, type OwnerDecision, type OwnerRecord } from './server.js'
import type { OwnerRequest, OwnerResponse } from './protocol.js'

export interface OwnerGate {
  decide(request: OwnerRequest): Promise<OwnerDecision>
  record(request: OwnerRequest, response: OwnerResponse): Promise<void>
  /** Marks a concrete target retired: positive operations against it are refused from now on. */
  retire(workstreamId: string, targetId: string): Promise<void>
}

export class PgOwnerGate implements OwnerGate {
  /** `owner` partitions the shared tables — e.g. "runtime-control", "broker" — never a Workstream field. */
  constructor(
    private readonly pool: pg.Pool,
    private readonly owner: string,
  ) {}

  async decide(request: OwnerRequest): Promise<OwnerDecision> {
    const record = await this.#loadRecordFor(request)
    return decideOwnerRequest({ record, request })
  }

  async record(request: OwnerRequest, response: OwnerResponse): Promise<void> {
    const before = await this.#loadRecordFor(request)
    const after = recordOwnerResponse(before, request, response)
    await this.pool.query(
      `INSERT INTO owner_record_epochs (owner, workstream_id, epoch) VALUES ($1, $2, $3)
       ON CONFLICT (owner, workstream_id) DO UPDATE SET epoch = GREATEST(owner_record_epochs.epoch, EXCLUDED.epoch)`,
      [this.owner, request.workstreamId, after.epoch],
    )
    await this.pool.query(
      `INSERT INTO owner_record_attempts (owner, attempt_key, workstream_id, payload_digest, response) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner, attempt_key) DO NOTHING`,
      [this.owner, request.attemptKey, request.workstreamId, request.payloadDigest, JSON.stringify(response)],
    )
  }

  async retire(workstreamId: string, targetId: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO owner_record_retired_targets (owner, target_id, workstream_id) VALUES ($1, $2, $3) ON CONFLICT (owner, target_id) DO NOTHING',
      [this.owner, targetId, workstreamId],
    )
  }

  async #loadRecordFor(request: OwnerRequest): Promise<OwnerRecord> {
    const [epochResult, attemptResult, retiredResult] = await Promise.all([
      this.pool.query('SELECT epoch FROM owner_record_epochs WHERE owner = $1 AND workstream_id = $2', [this.owner, request.workstreamId]),
      this.pool.query('SELECT payload_digest, response FROM owner_record_attempts WHERE owner = $1 AND attempt_key = $2', [this.owner, request.attemptKey]),
      this.pool.query('SELECT 1 FROM owner_record_retired_targets WHERE owner = $1 AND target_id = $2', [this.owner, request.target.id]),
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
