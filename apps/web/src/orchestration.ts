import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import * as acp from '@agentclientprotocol/sdk'
import { bootstrapSession, cancelSession as acpCancelSession, promptSession, resumeAcpSession, type PromptSessionHandoffSource } from '@agora/acp'
import { deriveCommandId, nameBasedUuid } from '@agora/domain'
import {
  buildHandoffContent,
  getAnchor,
  HANDOFF_SEED_POLICY_VERSION,
  openAdditionalSession,
  setCurrentSession,
  transitionSessionPhase,
  upsertAnchor,
} from '@agora/store-pg'
import {
  captureCustody,
  dematerializeSessionRuntime,
  materializeSessionRuntime,
  openACPConnection,
  getSessionRuntime,
  type SessionRuntimeControlTransport,
} from '@agora/session-runtime-control'
import type pg from 'pg'
import { connectAcpBridge, FAKE_CAPABILITY_POLICY_VERSION, FAKE_EXECUTION_GRANT_REF, fakeCapabilityDigest } from './bridge-client.js'
import type { SessionConnectionRegistry } from './connections.js'

/**
 * docs/specs/03-session-lifecycle.md "New Session" steps 6-11 (materialize, ACP connect/initialize/
 * new, bind) — this plan's real, working implementation of that chain, composing P04's controller
 * client and P03's coordinator over a genuine WebSocket ACP bridge connection (same construction
 * proven live in P04's cluster verification). Steps 1-4 (resolve Agent, create Session, resolve/
 * bind capabilities) already happen in the caller before this runs; there is no real Broker (P08)
 * to resolve capability intent, so a fixed fake policy/grant stands in — see bridge-client.ts.
 *
 * `bootstrapSession` (P03, already shipped and tested) transitions `requested` -> `provisioning`
 * itself, right after ACP `initialize` succeeds — NOT before Runtime materialization as the spec's
 * prose ordering literally reads. This plan does not re-open P03 to change that; the durable phase
 * stays `requested` for the seconds materialize/ACP-connect take, which is honestly narrower than
 * the spec's numbered list but consistent with what P03 actually built and tested.
 */
export interface ProvisionSessionInput {
  readonly pool: pg.Pool
  readonly transport: SessionRuntimeControlTransport
  readonly connections: SessionConnectionRegistry
  readonly workstreamId: string
  readonly sessionId: string
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  readonly workspaceMountRef: string
  readonly initialPrompt: readonly acp.ContentBlock[]
  /** docs/specs/06: a brand-new Agent joining a Workstream with prior history gets its first prompt as a Handoff, not a plain user prompt. Defaults to 'user' (P05's original behavior). */
  readonly initialPromptPurpose?: 'user' | 'handoff'
  readonly handoffSource?: PromptSessionHandoffSource
  /** Defaults to the fixed `'initial-prompt'` key P05 always used; a Handoff needs its OWN deterministic key (docs/specs/06 "Dispatch exactly one Handoff command per idempotency key"). */
  readonly promptIdempotencyKey?: string
  readonly actor: { readonly kind: 'human' | 'service' | 'system'; readonly id: string }
  readonly now?: () => Date
}

/** Exported so tests can replicate the exact derivation to simulate a crash between capture and Anchor commit. */
export const SUSPEND_CAPTURE_NAMESPACE = 'cbf5fa7c-3128-4e7e-b25a-3c4c7dd33084'

/** `switchAgent`'s deterministic new-Session id, derived from (workstream, agent, Idempotency-Key) — never `randomUUID()`, so a retry before any Anchor exists resolves to the SAME Session. */
export const SWITCH_AGENT_SESSION_NAMESPACE = 'c4f553e5-2238-4b7a-8bb7-f3d9ca2b4cfc'

async function waitForRuntimeReady(transport: SessionRuntimeControlTransport, sessionId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await getSessionRuntime(transport, sessionId as never)
    if (status.state === 'ready') return
    if (status.state === 'failed') throw new Error(`Session Runtime failed to become ready: ${JSON.stringify(status.failure)}`)
    if (Date.now() > deadline) throw new Error(`timed out waiting for Session Runtime '${sessionId}' to become ready`)
    await sleep(500)
  }
}

async function failClosed(pool: pg.Pool, sessionId: string, code: string, error: unknown): Promise<void> {
  const client = await pool.connect()
  try {
    await transitionSessionPhase(client, sessionId, 'failed', {
      failureCode: code,
      failureDetail: error instanceof Error ? error.message : String(error),
    })
  } catch {
    // Already terminal — e.g. bootstrapSession's own fail-closed path already transitioned it.
    // The original error is what matters; this is just belt-and-suspenders bookkeeping.
  } finally {
    client.release()
  }
}

/** Fire-and-forget from the HTTP layer (docs/specs/14 "Provisioning continues asynchronously"). */
export async function provisionSessionAndPrompt(input: ProvisionSessionInput): Promise<void> {
  const now = input.now ?? (() => new Date())
  try {
    await materializeSessionRuntime(input.transport, input.sessionId as never, randomUUID(), {
      agentId: input.agentId,
      runtimeDefinitionVersion: input.runtimeDefinitionVersion,
      workspaceMountRef: input.workspaceMountRef,
      executionGrantRef: FAKE_EXECUTION_GRANT_REF,
    })
    await waitForRuntimeReady(input.transport, input.sessionId)

    const endpoint = await openACPConnection(input.transport, input.sessionId as never, randomUUID())
    const stream = await connectAcpBridge(endpoint.url, endpoint.credential)

    const bootstrapped = await bootstrapSession({
      pool: input.pool,
      workstreamId: input.workstreamId,
      sessionId: input.sessionId,
      stream,
      cwd: '/home/node/work',
      capabilityPolicyVersion: FAKE_CAPABILITY_POLICY_VERSION,
      capabilityDigest: fakeCapabilityDigest(),
      now,
    })
    input.connections.set(input.sessionId, {
      connection: bootstrapped.connection,
      acpSessionId: bootstrapped.acpSessionId,
      storePersist: bootstrapped.storePersist,
    })

    if (input.initialPrompt.length > 0) {
      await promptSession({
        pool: input.pool,
        workstreamId: input.workstreamId,
        sessionId: input.sessionId,
        connection: bootstrapped.connection,
        storePersist: bootstrapped.storePersist,
        acpSessionId: bootstrapped.acpSessionId,
        prompt: input.initialPrompt,
        purpose: input.initialPromptPurpose ?? 'user',
        actor: input.actor,
        idempotencyKey: input.promptIdempotencyKey ?? 'initial-prompt',
        ...(input.handoffSource ? { handoffSource: input.handoffSource } : {}),
        now,
      })
    }
  } catch (error) {
    await failClosed(input.pool, input.sessionId, 'provisioning_failed', error)
  }
}

export type ActivateResult = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly detail: string }

export interface ResumeSessionHandoffPrompt {
  readonly content: readonly acp.ContentBlock[]
  readonly handoffSource: PromptSessionHandoffSource
  readonly idempotencyKey: string
}

export interface ResumeSessionRuntimeInput {
  readonly pool: pg.Pool
  readonly transport: SessionRuntimeControlTransport
  readonly connections: SessionConnectionRegistry
  readonly workstreamId: string
  readonly sessionId: string
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  readonly acpSessionId: string
  readonly workspaceMountRef: string
  /** docs/specs/06 "Choosing a target Session": resuming an anchored Agent still needs the missing `(watermark, head]` range delivered as a Handoff, same as a brand-new Session would. */
  readonly handoffPrompt?: ResumeSessionHandoffPrompt
  readonly now?: () => Date
}

/**
 * docs/specs/03 "Resume" / docs/specs/07 "Restore contract": rematerializes from the Workstream's
 * durable Anchor (never a caller-supplied snapshot id — resume always restores the ONE snapshot
 * product history actually points at), then `session/resume` over a fresh ACP connection to the
 * SAME Agora-known ACP Session id (ADR 0005: a new Pod UID, not a new Session identity).
 * Fire-and-forget from the HTTP layer, matching `provisionSessionAndPrompt` (docs/specs/14).
 */
export async function resumeSessionRuntime(input: ResumeSessionRuntimeInput): Promise<void> {
  try {
    const anchorClient = await input.pool.connect()
    let anchor
    try {
      anchor = await getAnchor(anchorClient, input.workstreamId, input.agentId)
    } finally {
      anchorClient.release()
    }
    if (!anchor || anchor.sessionId !== input.sessionId) {
      throw new Error(`no custody Anchor found for Session '${input.sessionId}' (workstream '${input.workstreamId}', agent '${input.agentId}')`)
    }

    await materializeSessionRuntime(input.transport, input.sessionId as never, randomUUID(), {
      agentId: input.agentId,
      runtimeDefinitionVersion: input.runtimeDefinitionVersion,
      workspaceMountRef: input.workspaceMountRef,
      executionGrantRef: FAKE_EXECUTION_GRANT_REF,
      restoreFrom: anchor.custodySnapshotId,
    })
    await waitForRuntimeReady(input.transport, input.sessionId)

    const endpoint = await openACPConnection(input.transport, input.sessionId as never, randomUUID())
    const stream = await connectAcpBridge(endpoint.url, endpoint.credential)

    const resumed = await resumeAcpSession({
      pool: input.pool,
      workstreamId: input.workstreamId,
      sessionId: input.sessionId,
      stream,
      cwd: '/home/node/work',
      acpSessionId: input.acpSessionId,
    })
    input.connections.set(input.sessionId, {
      connection: resumed.connection,
      acpSessionId: resumed.acpSessionId,
      storePersist: resumed.storePersist,
    })

    if (input.handoffPrompt) {
      await promptSession({
        pool: input.pool,
        workstreamId: input.workstreamId,
        sessionId: input.sessionId,
        connection: resumed.connection,
        storePersist: resumed.storePersist,
        acpSessionId: resumed.acpSessionId,
        prompt: input.handoffPrompt.content,
        purpose: 'handoff',
        actor: { kind: 'system', id: 'agora' },
        idempotencyKey: input.handoffPrompt.idempotencyKey,
        handoffSource: input.handoffPrompt.handoffSource,
        now: input.now ?? (() => new Date()),
      })
    }
  } catch (error) {
    await failClosed(input.pool, input.sessionId, 'resume_failed', error)
  }
}

/**
 * A `requested` Session runs the real provisioning chain; an already-live Session is a no-op; a
 * `suspended` Session resumes from its durable custody Anchor (plans/06-custody-and-resume.md).
 */
export async function activateSession(
  input: Omit<ProvisionSessionInput, 'initialPrompt'>,
): Promise<ActivateResult> {
  interface SessionActivationRow {
    readonly phase: string
    readonly workstream_id: string
    readonly agent_id: string
    readonly runtime_definition_version: string
    readonly acp_session_id: string | null
  }
  const client = await input.pool.connect()
  let row: SessionActivationRow | undefined
  try {
    const { rows } = await client.query<SessionActivationRow>(
      'SELECT phase, workstream_id, agent_id, runtime_definition_version, acp_session_id FROM product.sessions WHERE id = $1',
      [input.sessionId],
    )
    row = rows[0]
  } finally {
    client.release()
  }
  const phase = row?.phase

  if (phase === 'ready' || phase === 'busy') return { ok: true }
  if (phase === 'requested') {
    void provisionSessionAndPrompt({ ...input, initialPrompt: [] })
    return { ok: true }
  }
  if (phase === 'suspended') {
    if (!row?.acp_session_id) return { ok: false, code: 'resume_failed', detail: 'Suspended Session has no bound ACP Session id to resume' }
    void resumeSessionRuntime({
      pool: input.pool,
      transport: input.transport,
      connections: input.connections,
      workstreamId: row.workstream_id,
      sessionId: input.sessionId,
      agentId: row.agent_id,
      runtimeDefinitionVersion: row.runtime_definition_version,
      acpSessionId: row.acp_session_id,
      workspaceMountRef: input.workspaceMountRef,
    })
    return { ok: true }
  }
  return { ok: false, code: 'conflict', detail: `Session phase '${phase ?? 'unknown'}' cannot be activated` }
}

export interface SwitchAgentInput {
  readonly pool: pg.Pool
  readonly transport: SessionRuntimeControlTransport
  readonly connections: SessionConnectionRegistry
  readonly workstreamId: string
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  readonly workspaceMountRef: string
  readonly equipmentRequest: Record<string, unknown>
  readonly actor: { readonly kind: 'human' | 'service' | 'system'; readonly id: string }
  /** The caller's own Idempotency-Key (from `POST .../sessions`) — the Handoff's own idempotency key is deterministically derived from it, never a fresh random one, so a retry never duplicates the Handoff. */
  readonly idempotencyKey: string
  readonly now?: () => Date
}

export type SwitchAgentResult = { readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly code: string; readonly detail: string }

/**
 * docs/specs/06-anchors-and-handoffs.md "Choosing a target Session" + "Handoff representation":
 * the single entrypoint for "make Agent X active in this Workstream" — resolves whether that means
 * resuming an existing Anchor or opening a brand-new Session, computes the missing
 * `(watermark, head]` range, and (if non-empty) builds and dispatches it as a Handoff prompt.
 * Fire-and-forget from the HTTP layer past the synchronous Session-identity resolution, matching
 * `provisionSessionAndPrompt`/`resumeSessionRuntime` (docs/specs/14).
 */
export async function switchAgent(input: SwitchAgentInput): Promise<SwitchAgentResult> {
  const now = input.now ?? (() => new Date())

  const infoClient = await input.pool.connect()
  let anchor: Awaited<ReturnType<typeof getAnchor>>
  let head: number
  try {
    anchor = await getAnchor(infoClient, input.workstreamId, input.agentId)
    const { rows } = await infoClient.query<{ last_event_seq: number }>('SELECT last_event_seq FROM product.workstreams WHERE id = $1', [
      input.workstreamId,
    ])
    head = rows[0]?.last_event_seq ?? 0
  } finally {
    infoClient.release()
  }

  // A retry of the SAME switch must rebuild the SAME range (hence byte-identical content) —
  // never a wider one computed from a since-advanced head (docs/specs/06 "Repeating after crash
  // regenerates byte-identical Handoff content/digest").
  const promptIdempotencyKey = `handoff:${input.idempotencyKey}`
  const rangeClient = await input.pool.connect()
  let fromSeq: number
  let throughSeq: number
  try {
    const { rows } = await rangeClient.query<{ source_from_seq: number; source_through_seq: number }>(
      `SELECT source_from_seq, source_through_seq FROM product.commands
       WHERE workstream_id = $1 AND idempotency_scope = 'prompt' AND idempotency_key = $2`,
      [input.workstreamId, promptIdempotencyKey],
    )
    const existing = rows[0]
    fromSeq = existing ? existing.source_from_seq : (anchor?.syncedThroughSeq ?? 0)
    throughSeq = existing ? existing.source_through_seq : head
  } finally {
    rangeClient.release()
  }

  let sessionId: string
  /** 'new': freshly created this call, safe to provision+handoff. 'anchored': resume from custody.
   * 'reattach': a prior identical attempt already created this Session (no Anchor yet) — only
   * safe to re-run through `activateSession`'s own phase-aware, idempotent logic; a Handoff still
   * pending from that interrupted attempt is not re-dispatched here (see comment below). */
  let sessionMode: 'new' | 'anchored' | 'reattach'
  if (anchor) {
    sessionId = anchor.sessionId
    sessionMode = 'anchored'
    const c = await input.pool.connect()
    try {
      await setCurrentSession(c, input.workstreamId, sessionId)
    } finally {
      c.release()
    }
  } else {
    // Deterministic, not `randomUUID()`: a retry of the SAME Idempotency-Key before any Anchor
    // exists yet (e.g. crash right after this Session was created) must resolve to the SAME
    // Session id, never open a second, duplicate one for the same Agent.
    sessionId = nameBasedUuid(SWITCH_AGENT_SESSION_NAMESPACE, `${input.workstreamId}:${input.agentId}:${input.idempotencyKey}`)
    const existsClient = await input.pool.connect()
    let alreadyCreated: boolean
    try {
      const { rows } = await existsClient.query('SELECT 1 FROM product.sessions WHERE id = $1', [sessionId])
      alreadyCreated = rows.length > 0
    } finally {
      existsClient.release()
    }
    sessionMode = alreadyCreated ? 'reattach' : 'new'

    const c = await input.pool.connect()
    try {
      if (!alreadyCreated) {
        await openAdditionalSession(c, {
          id: sessionId,
          workstreamId: input.workstreamId,
          launchEnvelope: {
            agentId: input.agentId,
            workspaceSpec: { workspaceRef: input.workspaceMountRef },
            equipmentRequest: input.equipmentRequest as never,
            runtimeDefinitionVersion: input.runtimeDefinitionVersion,
          },
          runtimeDefinitionVersion: input.runtimeDefinitionVersion,
          createdAt: now(),
          activate: true,
        })
      } else {
        // A prior identical attempt already created this Session (no Anchor exists yet, so this
        // cannot be a resume). `activateSession`'s own phase-aware logic is what safely re-runs
        // provisioning below — a Handoff still pending from that interrupted attempt is not
        // re-dispatched here (same pre-existing limitation as `activateSession`'s no-op 'ready'
        // branch after a process restart with no in-memory live connection; a dedicated
        // reconciliation sweep is future work, not this plan's scope).
        await setCurrentSession(c, input.workstreamId, sessionId)
      }
    } finally {
      c.release()
    }
  }

  if (sessionMode === 'reattach') {
    const result = await activateSession({
      pool: input.pool,
      transport: input.transport,
      connections: input.connections,
      workstreamId: input.workstreamId,
      sessionId,
      agentId: input.agentId,
      runtimeDefinitionVersion: input.runtimeDefinitionVersion,
      workspaceMountRef: input.workspaceMountRef,
      actor: input.actor,
      now,
    })
    return result.ok ? { ok: true, sessionId } : result
  }

  if (fromSeq >= throughSeq) {
    // Nothing missing (e.g. a brand-new Workstream's very first Agent) — no Handoff needed.
    if (sessionMode === 'new') {
      void provisionSessionAndPrompt({
        pool: input.pool,
        transport: input.transport,
        connections: input.connections,
        workstreamId: input.workstreamId,
        sessionId,
        agentId: input.agentId,
        runtimeDefinitionVersion: input.runtimeDefinitionVersion,
        workspaceMountRef: input.workspaceMountRef,
        initialPrompt: [],
        actor: input.actor,
        now,
      })
    } else {
      const result = await activateSession({
        pool: input.pool,
        transport: input.transport,
        connections: input.connections,
        workstreamId: input.workstreamId,
        sessionId,
        agentId: input.agentId,
        runtimeDefinitionVersion: input.runtimeDefinitionVersion,
        workspaceMountRef: input.workspaceMountRef,
        actor: input.actor,
        now,
      })
      if (!result.ok) return result
    }
    return { ok: true, sessionId }
  }

  // docs/specs/06 "The builder ... MUST NOT build from a stale Web cache" — this throws
  // HandoffNotReadyError if the projector hasn't caught up to `throughSeq` yet; the caller
  // (server.ts) surfaces that as a typed, retryable 409 rather than silently under-seeding.
  const commandId = deriveCommandId(input.workstreamId as never, 'prompt', promptIdempotencyKey)
  const buildClient = await input.pool.connect()
  let built
  try {
    built = await buildHandoffContent(buildClient, {
      workstreamId: input.workstreamId,
      commandId,
      sourceFromSeq: fromSeq,
      sourceThroughSeq: throughSeq,
    })
  } finally {
    buildClient.release()
  }

  const handoffSource: PromptSessionHandoffSource = {
    sourceFromSeq: fromSeq,
    sourceThroughSeq: throughSeq,
    seedPolicyVersion: HANDOFF_SEED_POLICY_VERSION,
    contentSha256: built.sha256,
    fidelity: built.fidelity,
  }
  const content: readonly acp.ContentBlock[] = [
    { type: 'resource', resource: { uri: built.uri, text: built.text, mimeType: 'text/plain' } },
  ]

  if (sessionMode === 'new') {
    void provisionSessionAndPrompt({
      pool: input.pool,
      transport: input.transport,
      connections: input.connections,
      workstreamId: input.workstreamId,
      sessionId,
      agentId: input.agentId,
      runtimeDefinitionVersion: input.runtimeDefinitionVersion,
      workspaceMountRef: input.workspaceMountRef,
      initialPrompt: content,
      initialPromptPurpose: 'handoff',
      handoffSource,
      promptIdempotencyKey,
      actor: input.actor,
      now,
    })
    return { ok: true, sessionId }
  }

  const sessClient = await input.pool.connect()
  let acpSessionId: string | undefined
  try {
    const { rows } = await sessClient.query<{ acp_session_id: string | null }>('SELECT acp_session_id FROM product.sessions WHERE id = $1', [
      sessionId,
    ])
    acpSessionId = rows[0]?.acp_session_id ?? undefined
  } finally {
    sessClient.release()
  }
  if (!acpSessionId) return { ok: false, code: 'resume_failed', detail: 'Anchored Session has no bound ACP Session id to resume' }

  void resumeSessionRuntime({
    pool: input.pool,
    transport: input.transport,
    connections: input.connections,
    workstreamId: input.workstreamId,
    sessionId,
    agentId: input.agentId,
    runtimeDefinitionVersion: input.runtimeDefinitionVersion,
    acpSessionId,
    workspaceMountRef: input.workspaceMountRef,
    handoffPrompt: { content, handoffSource, idempotencyKey: promptIdempotencyKey },
    now,
  })
  return { ok: true, sessionId }
}

export interface SessionLifecycleInput {
  readonly pool: pg.Pool
  readonly transport: SessionRuntimeControlTransport
  readonly connections: SessionConnectionRegistry
  readonly sessionId: string
}

/** `session/cancel` is advisory (docs/specs/03) — a no-op if there is no live connection to cancel through. */
export async function cancelSessionCommand(input: Pick<SessionLifecycleInput, 'connections' | 'sessionId'>): Promise<{ readonly ok: boolean }> {
  const live = input.connections.get(input.sessionId)
  if (!live) return { ok: false }
  await acpCancelSession({ connection: live.connection, acpSessionId: live.acpSessionId })
  return { ok: true }
}

export interface SuspendSessionInput extends SessionLifecycleInput {
  /** The HTTP request's own Idempotency-Key: a retry of the SAME suspend must reuse the SAME
   * capture request id (docs/specs/13 "capture retry cannot allocate two generations for one
   * request id"), while a genuinely NEW suspend later must not collide with an old one. */
  readonly idempotencyKey: string
  readonly now?: () => Date
}

/**
 * docs/specs/03 "Suspend" + docs/specs/07 "Capture contract": cancel live work (so capture
 * observes a quiescent harness), capture custody, commit the Anchor, THEN dematerialize — in that
 * order, so a crash between capture and the Anchor leaves a safe unreferenced snapshot (the
 * retention job's own job), and a crash between the Anchor and dematerialize just leaves an
 * already-suspended-in-substance Pod that a retried suspend dematerializes again (idempotent).
 */
export async function suspendSession(input: SuspendSessionInput): Promise<void> {
  const now = input.now ?? (() => new Date())
  const openClient = await input.pool.connect()
  try {
    await transitionSessionPhase(openClient, input.sessionId, 'suspending')
  } finally {
    openClient.release()
  }
  try {
    const live = input.connections.get(input.sessionId)
    if (live) await acpCancelSession({ connection: live.connection, acpSessionId: live.acpSessionId })

    const infoClient = await input.pool.connect()
    let workstreamId: string
    let agentId: string
    let syncedThroughSeq: number
    try {
      const { rows } = await infoClient.query<{ workstream_id: string; agent_id: string; last_event_seq: number }>(
        `SELECT s.workstream_id, s.agent_id, w.last_event_seq
         FROM product.sessions s JOIN product.workstreams w ON w.id = s.workstream_id
         WHERE s.id = $1`,
        [input.sessionId],
      )
      const row = rows[0]
      if (!row) throw new Error(`session ${input.sessionId} not found`)
      workstreamId = row.workstream_id
      agentId = row.agent_id
      syncedThroughSeq = row.last_event_seq
    } finally {
      infoClient.release()
    }

    const captureRequestId = nameBasedUuid(SUSPEND_CAPTURE_NAMESPACE, `${input.sessionId}:${input.idempotencyKey}`)
    const ref = await captureCustody(input.transport, input.sessionId as never, captureRequestId, syncedThroughSeq)

    const anchorClient = await input.pool.connect()
    try {
      await upsertAnchor(anchorClient, {
        workstreamId,
        agentId,
        sessionId: input.sessionId,
        custodySnapshotId: ref.snapshotId,
        syncedThroughSeq: ref.syncedThroughSeq,
        updatedAt: now(),
      })
    } finally {
      anchorClient.release()
    }

    await dematerializeSessionRuntime(input.transport, input.sessionId as never, randomUUID())
    input.connections.delete(input.sessionId)
    const closeClient = await input.pool.connect()
    try {
      await transitionSessionPhase(closeClient, input.sessionId, 'suspended')
    } finally {
      closeClient.release()
    }
  } catch (error) {
    await failClosed(input.pool, input.sessionId, 'suspend_failed', error)
  }
}

/**
 * Narrowed close (docs/specs/03 "Close"): cancels active work, dematerializes the real Session
 * Runtime. No grant/relay/OneCLI revocation (P08 doesn't exist yet) — those never existed for
 * this Session in the first place (fixed fake placeholders, see bridge-client.ts).
 */
export async function closeSession(input: SessionLifecycleInput & { readonly now?: () => Date }): Promise<void> {
  const now = input.now ?? (() => new Date())
  const openClient = await input.pool.connect()
  try {
    await transitionSessionPhase(openClient, input.sessionId, 'closing')
  } finally {
    openClient.release()
  }
  try {
    const live = input.connections.get(input.sessionId)
    if (live) await acpCancelSession({ connection: live.connection, acpSessionId: live.acpSessionId })
    await dematerializeSessionRuntime(input.transport, input.sessionId as never, randomUUID())
    input.connections.delete(input.sessionId)
    const closeClient = await input.pool.connect()
    try {
      await transitionSessionPhase(closeClient, input.sessionId, 'closed', { closedAt: now() })
    } finally {
      closeClient.release()
    }
  } catch (error) {
    await failClosed(input.pool, input.sessionId, 'close_failed', error)
  }
}
