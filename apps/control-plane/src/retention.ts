// Retention (S11 Step 2 — continuity.md "Storage and retention", P14).
//
// Two jobs, and the second is the one worth being careful about:
//
//   1. remove recovery material nothing needs any more, after its grace period;
//   2. delete a Workstream — which means extinguishing its execution FIRST, and only then removing
//      what could have restored it.
//
// Every query here says what it must NOT delete before it says what it may. That ordering is not
// stylistic: the failure mode of a retention sweep is not "it kept too much", it is "it removed the
// recovery point nobody had noticed was still needed", and that failure is silent until someone
// tries to restore.
import type pg from 'pg'

export interface RetentionSettings {
  readonly unreferencedSaveGraceDays: number
  readonly latestSavePerSessionGraceDays: number
  readonly saveWithoutPayloadGraceHours: number
  readonly sweepBatchSize: number
}

export class MissingRetentionSettingError extends Error {
  constructor(readonly field: string) {
    super(`retention settings are missing ${field}; pin it in contracts/catalogue/retention-settings.json`)
    this.name = 'MissingRetentionSettingError'
  }
}

export function readRetentionSettings(document: Record<string, unknown>): RetentionSettings {
  const positive = (field: keyof RetentionSettings): number => {
    const value = document[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new MissingRetentionSettingError(field)
    return value
  }
  return {
    unreferencedSaveGraceDays: positive('unreferencedSaveGraceDays'),
    latestSavePerSessionGraceDays: positive('latestSavePerSessionGraceDays'),
    saveWithoutPayloadGraceHours: positive('saveWithoutPayloadGraceHours'),
    sweepBatchSize: positive('sweepBatchSize'),
  }
}

export interface SweepResult {
  readonly deletedSaves: number
  readonly deletedPayloads: number
}

/**
 * The Saves this sweep may never touch, as one SQL predicate. Kept in one place because every
 * deletion below has to respect all of it, and a rule that lives in two queries eventually lives in
 * one and a half.
 *
 *   - named by an Anchor: it IS the recovery point;
 *   - named by a Session's `origin_save_id`: a restore either used it or is still using it;
 *   - the latest Save of a Session whose attribution has not ended, or ended recently: "what did
 *     that Session end with" stays answerable for as long as the Session is retained.
 */
const PROTECTED = `
  s.id IN (SELECT save_id FROM anchors)
  OR s.id IN (SELECT origin_save_id FROM sessions WHERE origin_save_id IS NOT NULL)
  OR s.id IN (
    SELECT DISTINCT ON (session_id) id FROM saves ORDER BY session_id, created_at DESC
  ) AND EXISTS (
    SELECT 1 FROM sessions se
    WHERE se.id = s.session_id
      AND (se.attribution_ended_at IS NULL OR se.attribution_ended_at > now() - make_interval(days => $2))
  )`

/**
 * Removes Saves nothing needs any more. Payload bytes go with their metadata, in that order: a
 * payload without a Save is unidentifiable garbage, while a Save without its payload is a promise
 * that cannot be kept — so if the sweep is interrupted between them, the second state is the one to
 * be in, and it is the one the next pass finishes.
 */
export async function sweepUnreferencedSaves(client: pg.PoolClient, settings: RetentionSettings, nowSql = 'now()'): Promise<SweepResult> {
  const candidates = await client.query(
    `SELECT s.id FROM saves s
     WHERE s.created_at < ${nowSql} - make_interval(days => $1)
       AND NOT (${PROTECTED})
     ORDER BY s.created_at
     LIMIT $3`,
    [settings.unreferencedSaveGraceDays, settings.latestSavePerSessionGraceDays, settings.sweepBatchSize],
  )
  const ids = candidates.rows.map((row) => (row as { id: string }).id)
  if (ids.length === 0) return { deletedSaves: 0, deletedPayloads: 0 }

  const payloads = await client.query('DELETE FROM save_payloads WHERE save_id = ANY($1::uuid[])', [ids])
  await client.query('DELETE FROM save_invalidations WHERE save_id = ANY($1::uuid[])', [ids])
  const saves = await client.query('DELETE FROM saves WHERE id = ANY($1::uuid[])', [ids])
  return { deletedSaves: saves.rowCount ?? 0, deletedPayloads: payloads.rowCount ?? 0 }
}

/**
 * Removes Save metadata whose bytes were never committed — a capture that died between the two
 * commits TURN_OFF makes. Bounded by its own, much shorter grace: an hour covers a controller
 * restart mid-shutdown, and past that the row describes nothing that exists.
 */
export async function sweepSavesWithoutPayloads(client: pg.PoolClient, settings: RetentionSettings, nowSql = 'now()'): Promise<SweepResult> {
  const candidates = await client.query(
    `SELECT s.id FROM saves s
     WHERE s.created_at < ${nowSql} - make_interval(hours => $1)
       AND NOT EXISTS (SELECT 1 FROM save_payloads p WHERE p.save_id = s.id)
       AND NOT (${PROTECTED})
     ORDER BY s.created_at
     LIMIT $3`,
    [settings.saveWithoutPayloadGraceHours, settings.latestSavePerSessionGraceDays, settings.sweepBatchSize],
  )
  const ids = candidates.rows.map((row) => (row as { id: string }).id)
  if (ids.length === 0) return { deletedSaves: 0, deletedPayloads: 0 }
  await client.query('DELETE FROM save_invalidations WHERE save_id = ANY($1::uuid[])', [ids])
  const result = await client.query('DELETE FROM saves WHERE id = ANY($1::uuid[])', [ids])
  return { deletedSaves: result.rowCount ?? 0, deletedPayloads: 0 }
}

export type DeletionOutcome =
  | { readonly kind: 'deleted' }
  /** Execution is not extinguished; nothing was removed, and the reason says what still exists. */
  | { readonly kind: 'refused'; readonly reason: string }

export interface ExtinctionEvidence {
  /** Pods still known to the owner for this Workstream — from a FRESH inventory, never a cached count. */
  readonly livePods: number
  /** Retirement obligations not yet discharged (a force-deleted Pod on a partitioned node, OFF-005). */
  readonly unresolvedObligations: number
}

/**
 * Deletes a Workstream and everything that could have restored it — but only once its execution is
 * provably gone. The order is the whole point (continuity.md): extinguish, THEN remove recovery
 * material. Deleting a payload while a Pod could still be restoring from it would leave that Pod
 * holding native state nothing can account for.
 *
 * The evidence is passed in rather than read here: proving extinction is the owners' job, and a
 * retention module that went looking for it would be a second, quieter authority on what "off"
 * means.
 */
export async function deleteWorkstream(client: pg.PoolClient, workstreamId: string, evidence: ExtinctionEvidence): Promise<DeletionOutcome> {
  if (evidence.livePods > 0) {
    return { kind: 'refused', reason: `${String(evidence.livePods)} Pod(s) still exist for this Workstream; deletion waits for extinction, it does not cause it` }
  }
  if (evidence.unresolvedObligations > 0) {
    return { kind: 'refused', reason: `${String(evidence.unresolvedObligations)} retirement obligation(s) are unresolved; a Pod that may still be running is not extinct (OFF-005)` }
  }
  const live = await client.query('SELECT id FROM sessions WHERE workstream_id = $1 AND attribution_ended_at IS NULL', [workstreamId])
  if (live.rowCount !== 0) {
    return { kind: 'refused', reason: 'a Session still holds attribution; end it before the Workstream is deleted' }
  }

  // Recovery material first, then history, then the Workstream itself. Each step is inside the
  // caller's transaction: a half-deleted Workstream is worse than one still there.
  await client.query('DELETE FROM save_payloads WHERE save_id IN (SELECT id FROM saves WHERE workstream_id = $1)', [workstreamId])
  await client.query('DELETE FROM save_invalidations WHERE save_id IN (SELECT id FROM saves WHERE workstream_id = $1)', [workstreamId])
  await client.query('DELETE FROM anchors WHERE workstream_id = $1', [workstreamId])
  await client.query('DELETE FROM saves WHERE workstream_id = $1', [workstreamId])
  await client.query('DELETE FROM shutdowns WHERE workstream_id = $1', [workstreamId])
  await client.query('DELETE FROM command_dispatches WHERE workstream_id = $1', [workstreamId])
  await client.query('DELETE FROM publication_targets WHERE workstream_id = $1', [workstreamId])
  await client.query('DELETE FROM workstream_facts WHERE workstream_id = $1', [workstreamId])
  await client.query('DELETE FROM sessions WHERE workstream_id = $1', [workstreamId])
  await client.query('DELETE FROM workstream_reconciliation_work WHERE workstream_id = $1', [workstreamId])
  await client.query('DELETE FROM owner_attempts WHERE workstream_id = $1', [workstreamId])
  await client.query('DELETE FROM workstream_intent_events WHERE workstream_id = $1', [workstreamId])
  await client.query('DELETE FROM workstreams WHERE id = $1', [workstreamId])
  return { kind: 'deleted' }
}
