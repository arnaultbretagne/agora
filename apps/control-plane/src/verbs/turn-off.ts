// TURN_OFF with bounded preservation (S9 Step 3 — 003 verbs, execution.md "Shutdown and physical
// extinction", OFF-001/002/008).
//
// The shape of this verb is a promise about ORDER, not about success:
//
//   1. pin the deadline, once, and never again (a restart discovers it — OFF-002);
//   2. cut authority immediately — relay closure and revocation go first, before any preservation,
//      because a context that is being preserved is still a context that can act;
//   3. attempt a capture within what is LEFT of the budget, and only if this Session is eligible;
//   4. commit the Save, then conditionally advance the Anchor;
//   5. terminate with bounded grace WHETHER OR NOT any of step 3 and 4 worked, recording the loss.
//
// Step 5 is unconditional on purpose. A shutdown that waits for a capture is a shutdown that a hung
// capture can prevent, and "the Pod is still running" is a worse outcome than "the last few turns
// were not preserved" (OFF-001). Nothing here decides WHETHER to shut down — the rule tables did
// that before this executor was ever called.
import type pg from 'pg'
import type { Verb } from '@agora/domain'
import { loadLatestIntentEvent, type VerbContext, type VerbExecutor } from '@agora/engine'
import { currentSession, currentOpeningWindow } from '@agora/journal'
import { publishAnchor, recordSave, getAnchor, type PublishOutcome } from '@agora/custody'

export interface CaptureAttempt {
  readonly kind: 'captured' | 'refused' | 'unavailable'
  readonly reason?: string
  readonly capture?: {
    readonly stagingId: string
    readonly checksum: string
    readonly byteLength: number
    readonly formatId: string
    readonly formatVersion: number
    readonly driverRevision: string
    readonly frontierW: number
    readonly nativeOrigin: unknown
    readonly workspaceDeps: unknown
    readonly contextId: string
    readonly processGeneration: number
  }
}

/**
 * Whoever can actually reach the Pod's driver. Implemented over runtime-control's custody endpoints;
 * an interface here so this verb can be tested without a cluster, and so the control plane keeps its
 * one honest relationship with Save bytes: it never sees them.
 */
export interface CaptureSource {
  attemptCapture(request: {
    readonly workstreamId: string
    readonly incarnation: string
    readonly podUid: string
    readonly contextId: string
    readonly processGeneration: number
    readonly budgetMs: number
  }): Promise<CaptureAttempt>
  /** Binds the staged bytes to the Save the control plane just committed. */
  commitPayload(request: { readonly workstreamId: string; readonly incarnation: string; readonly stagingId: string; readonly saveId: string }): Promise<void>
}

export interface TurnOffOptions {
  readonly inner: VerbExecutor
  readonly productPool: pg.Pool
  readonly enginePool: pg.Pool
  /** Absent where no custody is deployed: TURN_OFF then behaves exactly as it did in S7. */
  readonly capture?: CaptureSource
  /** Fallback harness id when the Workstream has no Intent to read one from. */
  readonly harnessId?: string
  readonly imageDigest?: string
  readonly seedPolicyRevision?: string
  /** The fixed preservation budget, pinned into the deadline on the FIRST TURN_OFF for an incarnation. */
  readonly preservationBudgetMs?: number
  readonly now?: () => Date
  readonly logger?: (message: string) => void
}

/**
 * The fallback used only where no settings file is wired (tests, and the unwired dev mode). A real
 * deployment passes the pinned value from contracts/catalogue/runtime-settings.json — S11's rule is
 * that no timing lives only in code.
 */
export const DEFAULT_PRESERVATION_BUDGET_MS = 20_000

interface ShutdownRecord {
  readonly workstreamId: string
  readonly incarnation: string
  readonly sessionId: string | null
  readonly deadlineAt: Date
  readonly captureOutcome: string
  readonly saveId: string | null
}

/**
 * Pins the shutdown deadline the first time, and returns the EXISTING one every time after. This is
 * the whole of OFF-002: a controller that restarts mid-shutdown reads back the deadline it already
 * owes. `ON CONFLICT DO NOTHING` rather than an upsert, so no path can move it forward by accident.
 */
export async function openShutdown(
  client: pg.PoolClient,
  record: { workstreamId: string; incarnation: string; sessionId: string | null; deadlineAt: Date },
): Promise<ShutdownRecord> {
  await client.query(
    `INSERT INTO shutdowns (workstream_id, incarnation, session_id, deadline_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workstream_id, incarnation) DO NOTHING`,
    [record.workstreamId, record.incarnation, record.sessionId, record.deadlineAt],
  )
  const row = await client.query(
    'SELECT workstream_id, incarnation, session_id, deadline_at, capture_outcome, save_id FROM shutdowns WHERE workstream_id = $1 AND incarnation = $2',
    [record.workstreamId, record.incarnation],
  )
  const found = row.rows[0]!
  return {
    workstreamId: found['workstream_id'] as string,
    incarnation: found['incarnation'] as string,
    sessionId: found['session_id'] as string | null,
    deadlineAt: found['deadline_at'] as Date,
    captureOutcome: found['capture_outcome'] as string,
    saveId: found['save_id'] as string | null,
  }
}

async function recordOutcome(
  client: pg.PoolClient,
  key: { workstreamId: string; incarnation: string },
  outcome: { captureOutcome: string; captureDetail?: string | null; saveId?: string | null; anchorOutcome?: string | null; terminated?: boolean },
): Promise<void> {
  await client.query(
    `UPDATE shutdowns SET
       capture_outcome = $3,
       capture_detail = coalesce($4, capture_detail),
       save_id = coalesce($5, save_id),
       anchor_outcome = coalesce($6, anchor_outcome),
       terminated_at = CASE WHEN $7 THEN now() ELSE terminated_at END
     WHERE workstream_id = $1 AND incarnation = $2`,
    [
      key.workstreamId,
      key.incarnation,
      outcome.captureOutcome,
      outcome.captureDetail ?? null,
      outcome.saveId ?? null,
      outcome.anchorOutcome ?? null,
      outcome.terminated === true,
    ],
  )
}

export function createTurnOffExecutor(options: TurnOffOptions): VerbExecutor {
  const now = options.now ?? (() => new Date())
  const log = options.logger ?? (() => {})

  return {
    async execute(verb: Verb, context: VerbContext): Promise<void> {
      if (verb !== 'TURN_OFF') return options.inner.execute(verb, context)

      const incarnation = await currentIncarnationOf(options.enginePool, context.workstreamId)
      if (incarnation === undefined || options.capture === undefined) {
        // Nothing to preserve, or nowhere to preserve it: the S7 shutdown, unchanged.
        return options.inner.execute(verb, context)
      }

      const client = await options.productPool.connect()
      try {
        const session = await currentSession(client, context.workstreamId)
        const deadlineAt = new Date(now().getTime() + (options.preservationBudgetMs ?? DEFAULT_PRESERVATION_BUDGET_MS))
        const shutdown = await openShutdown(client, {
          workstreamId: context.workstreamId,
          incarnation,
          sessionId: session?.sessionId ?? null,
          deadlineAt,
        })

        // Authority is cut first, and it is the inner executor's own revocation path that does it —
        // no preservation step runs before the Pod has stopped being able to act (003 verbs).
        await options.inner.execute('REVOKE', context).catch((error: unknown) => {
          // Revocation failing does not buy the Pod more time; the shutdown continues, and the
          // reachable owners still restrict what they own (OFF-006).
          log(`revocation during shutdown failed, continuing: ${error instanceof Error ? error.message : String(error)}`)
        })

        await preserve(options, options.capture, now, log, client, context, shutdown, session)
      } finally {
        client.release()
      }

      // Unconditional. Whatever happened above, the Pod goes.
      await options.inner.execute(verb, context)
      const terminationClient = await options.productPool.connect()
      try {
        await markTerminated(terminationClient, { workstreamId: context.workstreamId, incarnation })
      } finally {
        terminationClient.release()
      }
    },
  }
}

/**
 * The eligible-capture attempt, inside whatever is left of the pinned budget. A free function, not a
 * method, so the unconditional termination above cannot accidentally become conditional on it: this
 * returns rather than throws, always.
 */
async function preserve(
  options: TurnOffOptions,
  capture: CaptureSource,
  now: () => Date,
  log: (message: string) => void,
  client: pg.PoolClient,
  context: VerbContext,
  shutdown: ShutdownRecord,
  session: { sessionId: string; podUid: string; acpContextId: string | null; processGeneration: number } | null,
): Promise<void> {
  // The Anchor a shutdown advances is the one belonging to the harness this Workstream is actually
  // running (CONT-007): capturing on codex must never publish over claude-code's Anchor.
  const intent = await loadLatestIntentEvent(options.productPool, context.workstreamId)
  const intentHarness = (intent?.intent as { harness?: unknown } | undefined)?.harness
  const harnessId = typeof intentHarness === 'string' ? intentHarness : (options.harnessId ?? 'claude-code')
  const key = { workstreamId: shutdown.workstreamId, incarnation: shutdown.incarnation }
  const remainingMs = shutdown.deadlineAt.getTime() - now().getTime()

  if (shutdown.captureOutcome !== 'pending') {
    // OFF-002: a restart discovers the committed result and does not redo it.
    log(`shutdown for ${shutdown.incarnation} already resolved as ${shutdown.captureOutcome}`)
    return
  }
  if (remainingMs <= 0) {
    await recordOutcome(client, key, { captureOutcome: 'expired', captureDetail: 'the preservation budget was already spent when this attempt started' })
    return
  }
  const ineligible = eligibilityRefusal(session)
  if (ineligible !== null) {
    // OFF-008: an unverified restore or an unsynchronized context is not published over a
    // healthy Anchor. Being ineligible is a recorded outcome, not a silent skip.
    await recordOutcome(client, key, { captureOutcome: 'ineligible', captureDetail: ineligible })
    return
  }

  const live = session as { sessionId: string; podUid: string; acpContextId: string; processGeneration: number }
  const attempt = await capture.attemptCapture({
    workstreamId: context.workstreamId,
    incarnation: shutdown.incarnation,
    podUid: live.podUid,
    contextId: live.acpContextId,
    processGeneration: live.processGeneration,
    budgetMs: remainingMs,
  }).catch((error: unknown): CaptureAttempt => ({ kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }))

  if (attempt.kind !== 'captured' || attempt.capture === undefined) {
    await recordOutcome(client, key, {
      captureOutcome: attempt.kind === 'refused' ? 'refused' : 'expired',
      captureDetail: attempt.reason ?? 'the driver returned no capture',
    })
    return
  }

  const captured = attempt.capture
  try {
    // Three commits, in this order, because `save_payloads` references `saves`: the metadata has to
    // be visible to the transport's own connection before the bytes can be written under it, and the
    // Anchor must not name a Save whose bytes are not there yet.
    //
    // Each gap is survivable in exactly one direction. A crash after the first leaves a Save with no
    // payload that no Anchor names — harmless material the retention sweep drops (P14), and a Save
    // RESTORE would treat as an unreachable payload, which is an outage and invalidates nothing
    // (CONT-008). A crash after the second leaves usable bytes the Anchor has not been advanced to:
    // the previous Anchor still stands, which is precisely the conservative outcome.
    // What the CONTEXT provably holds, which the driver alone cannot say.
    //
    // The driver reports a conservative floor (0 for claude-code): from a transcript it can prove
    // delivery of a Handoff digest and nothing else. But the loss exposure the operator reads counts
    // facts newer than that frontier — so every Save anchored at 0 reported the entire journal as
    // possibly lost, for ever, immediately after a clean shutdown that captured all of it. A banner
    // that always cries wolf is worse than no banner.
    //
    // The control plane can prove more, and by provenance rather than by reading anything: a fact
    // journaled FROM this Session's own ACP stream passed through this context. So the frontier is
    // raised to the newest such fact — but only from a base the context is known to hold: the range
    // it restored from, or nothing at all when its opening range was empty (CONT-002 — vacuously
    // incorporated). A Session that opened over an unproven non-empty range keeps the driver's
    // floor, because there the gap below its own stream is exactly what is not established.
    const provenFrontierW = await provenFrontier(options.productPool, context.workstreamId, live.sessionId, captured.frontierW)

    const metadataClient = await options.productPool.connect()
    let saveId: string
    try {
      await metadataClient.query('BEGIN')
      const recorded = await recordSave(
        metadataClient,
        {
          podUid: live.podUid,
          processGeneration: captured.processGeneration,
          contextId: captured.contextId,
          frontierW: provenFrontierW,
          driverRevision: captured.driverRevision,
        },
        {
          workstreamId: context.workstreamId,
          sessionId: live.sessionId,
          harnessId,
          formatId: captured.formatId,
          formatVersion: captured.formatVersion,
          imageDigest: options.imageDigest ?? 'unknown',
          byteLength: captured.byteLength,
          checksum: captured.checksum,
          seedPolicyRevision: options.seedPolicyRevision ?? 'handoff-seed-v1',
          nativeOrigin: captured.nativeOrigin,
          workspaceDeps: captured.workspaceDeps,
        },
      )
      await metadataClient.query('COMMIT')
      saveId = recorded.save.id
    } catch (error) {
      await metadataClient.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      metadataClient.release()
    }

    await capture.commitPayload({ workstreamId: context.workstreamId, incarnation: shutdown.incarnation, stagingId: captured.stagingId, saveId })

    const anchorClient = await options.productPool.connect()
    let publication: PublishOutcome
    try {
      await anchorClient.query('BEGIN')
      const previous = await getAnchor(anchorClient, context.workstreamId, harnessId)
      publication = await publishAnchor(anchorClient, {
        workstreamId: context.workstreamId,
        harnessId,
        saveId,
        frontierW: provenFrontierW,
        expectedPrevious: previous?.saveId ?? null,
      })
      await anchorClient.query('COMMIT')
    } catch (error) {
      await anchorClient.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      anchorClient.release()
    }

    await recordOutcome(client, key, {
      captureOutcome: 'captured',
      saveId,
      anchorOutcome: publication.kind,
      captureDetail: publication.kind === 'published' ? null : `the Save was committed but the Anchor was not advanced (${publication.kind})`,
    })
    log(`shutdown preserved Save ${saveId} for ${shutdown.incarnation}; anchor ${publication.kind}`)
  } catch (error) {
    // A failed commit preserves nothing and invalidates nothing. The old Anchor stands, and the
    // loss is recorded rather than inferred later from an absence.
    await recordOutcome(client, key, { captureOutcome: 'refused', captureDetail: `committing the Save failed: ${error instanceof Error ? error.message : String(error)}` })
  }
}

/**
 * Records that the Pod was actually terminated. It never touches the capture outcome: the two are
 * independent facts, and the shutdown proceeded regardless of the first.
 */
async function markTerminated(client: pg.PoolClient, key: { workstreamId: string; incarnation: string }): Promise<void> {
  await client.query('UPDATE shutdowns SET terminated_at = now() WHERE workstream_id = $1 AND incarnation = $2 AND terminated_at IS NULL', [
    key.workstreamId,
    key.incarnation,
  ])
}

/**
 * Why this Session's native context may not be captured at all. Eligibility is about what can be
 * PROVEN right now, so every branch names something absent rather than something suspected.
 */
function eligibilityRefusal(session: { acpContextId: string | null } | null): string | null {
  if (session === null) return 'there is no current Session, so there is no native context to preserve'
  if (session.acpContextId === null) return 'the Session never bound an ACP context, so nothing was ever synchronized into one (OFF-008)'
  return null
}

/** The incarnation this Workstream's shutdown acts on — the same lookup packages/engine's runner uses. */
async function currentIncarnationOf(enginePool: pg.Pool, workstreamId: string): Promise<string | undefined> {
  const result = await enginePool.query(
    `SELECT target_id FROM owner_attempts
     WHERE workstream_id = $1 AND operation = 'create_pod' AND state IN ('settled', 'dispatched', 'unknown')
     ORDER BY reserved_at DESC LIMIT 1`,
    [workstreamId],
  )
  return (result.rows[0] as { target_id?: string } | undefined)?.target_id
}

/**
 * The journal position this Session's context provably holds, at least. Never guesses: it takes the
 * newest fact that came off this Session's own ACP stream, and only when the base below it is
 * established — an empty opening range (nothing to hold) or a restore (a Save's own proven
 * frontier). Otherwise the driver's floor stands.
 */
async function provenFrontier(pool: pg.Pool, workstreamId: string, sessionId: string, driverFloor: number): Promise<number> {
  const window = await currentOpeningWindow(pool, workstreamId)
  if (window === null) return driverFloor
  const baseEstablished = window.h <= window.w || window.saveId !== null
  if (!baseEstablished) return driverFloor
  const result = await pool.query(
    "SELECT COALESCE(MAX(seq), 0) AS seq FROM workstream_facts WHERE workstream_id = $1 AND session_id = $2 AND kind = 'acp.envelope'",
    [workstreamId, sessionId],
  )
  const ownStream = Number((result.rows[0] as { seq: string | number } | undefined)?.seq ?? 0)
  return Math.max(driverFloor, window.w, ownStream)
}
