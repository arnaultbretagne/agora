import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import * as acp from '@agentclientprotocol/sdk'
import { bootstrapSession, cancelSession as acpCancelSession, promptSession, resumeAcpSession, type PromptSessionHandoffSource } from '@agora/acp'
import { deriveCommandId, nameBasedUuid, type EquipmentRequest } from '@agora/domain'
import {
  bindExecutionGrantRef,
  buildHandoffContent,
  getAnchor,
  getExecutionGrantRef,
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
import type { BrokerGrantClient } from './broker-grant-client.js'
import { connectAcpBridge } from './bridge-client.js'
import type { SessionConnectionRegistry } from './connections.js'

/**
 * docs/specs/03-session-lifecycle.md "New Session" steps 6-11 (materialize, ACP connect/initialize/
 * new, bind) — this plan's real, working implementation of that chain, composing P04's controller
 * client and P03's coordinator over a genuine WebSocket ACP bridge connection (same construction
 * proven live in P04's cluster verification). Steps 1-4 (resolve Agent, create Session, resolve/
 * bind capabilities) already happen in the caller before this runs.
 *
 * Found live, P11: capability policy/grant used to be a fixed fake placeholder (bridge-client.ts)
 * left over from before the Broker (P08) existed — never retrofitted once it shipped. Both
 * `provisionSessionAndPrompt` and `resumeSessionRuntime` now call the real Broker
 * (broker-grant-client.ts) before materializing: a genuinely NEW Session issues a grant, a resumed
 * one renews its existing one (`broker.execution_grants.session_id` is UNIQUE — one grant per
 * Session, ever; see 005-add-session-execution-grant-ref.sql).
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
  readonly brokerGrantClient: BrokerGrantClient
  readonly connections: SessionConnectionRegistry
  readonly workstreamId: string
  readonly sessionId: string
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
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

/**
 * The Broker's own `issueExecutionGrant` is idempotent by (sessionId, requestId) — deriving this
 * deterministically from `sessionId` (never `randomUUID()`) means a `provisionSessionAndPrompt`
 * retry (e.g. `activateSession`'s 'requested'-phase reattach path, after a crash between a
 * successful issue and the ACP bootstrap that follows it) replays onto the SAME grant instead of
 * hitting the Broker's `GrantConflictError` (`execution_grants.session_id` is UNIQUE).
 */
export const EXECUTION_GRANT_REQUEST_NAMESPACE = '3f9d0b0a-6b39-4b62-9c9a-3e8b6b6b1c2f'

interface SessionGrantContext {
  readonly equipment: EquipmentRequest
  readonly workstreamCategory: 'discussion' | 'invocation'
  /** Frozen at Session creation; the harness's own `--agent <name>`. Read here rather than threaded through every caller, same as the equipment above. */
  readonly persona: string | undefined
}

/** Both the issuing (`provisionSessionAndPrompt`) and renewing (`resumeSessionRuntime`) paths need this — read fresh from product schema rather than threaded through every caller's input shape. */
async function loadSessionGrantContext(pool: pg.Pool, sessionId: string): Promise<SessionGrantContext> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ equipment_request: EquipmentRequest; category: 'discussion' | 'invocation'; persona: string | null }>(
      `SELECT s.equipment_request, s.persona, w.category FROM product.sessions s JOIN product.workstreams w ON w.id = s.workstream_id WHERE s.id = $1`,
      [sessionId],
    )
    const row = rows[0]
    if (!row) throw new Error(`session ${sessionId} not found`)
    return { equipment: row.equipment_request, workstreamCategory: row.category, persona: row.persona ?? undefined }
  } finally {
    client.release()
  }
}

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

/**
 * docs/specs/10 "Terminal Session/Workstream cleanup deletes it after revocation": revoking the
 * Session's grant is what makes the Broker delete its dedicated OneCLI Agent (grant-service.ts's
 * `revokeExecutionGrant`). Found live, P11: NOTHING in this codebase ever called that endpoint, so
 * every terminal Session leaked its Agent — 20 had piled up on the real instance.
 *
 * Best-effort by design, and always last: a Session that is already terminal in product truth must
 * not be dragged back out of that state by a Broker hiccup, and the Broker's own revoke is
 * idempotent (revoking an absent/already-revoked grant is a no-op success), so a retry from a later
 * terminal path is safe. A Session that never got a grant simply has nothing to revoke.
 */
async function revokeSessionGrant(input: {
  readonly pool: pg.Pool
  readonly brokerGrantClient: BrokerGrantClient
  readonly sessionId: string
}): Promise<void> {
  try {
    const client = await input.pool.connect()
    let grantRef: string | undefined
    try {
      grantRef = await getExecutionGrantRef(client, input.sessionId)
    } finally {
      client.release()
    }
    if (!grantRef) return
    await input.brokerGrantClient.revoke(grantRef, randomUUID())
  } catch {
    // Never let cleanup failure surface as a Session-lifecycle failure. The grant expires on its
    // own (30 min TTL) and the Agent is reclaimable by an operator sweep; losing the Session's
    // terminal transition over it would be strictly worse.
  }
}

async function failClosed(
  pool: pg.Pool,
  sessionId: string,
  code: string,
  error: unknown,
  brokerGrantClient?: BrokerGrantClient,
): Promise<void> {
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
  // A failed Session is terminal: its grant and OneCLI Agent must not outlive it. This is where
  // tonight's 20 orphaned Agents actually came from — provisioning failures, not clean closes.
  if (brokerGrantClient) await revokeSessionGrant({ pool, brokerGrantClient, sessionId })
}

/** Fire-and-forget from the HTTP layer (docs/specs/14 "Provisioning continues asynchronously"). */
export async function provisionSessionAndPrompt(input: ProvisionSessionInput): Promise<void> {
  const now = input.now ?? (() => new Date())
  try {
    const { equipment, workstreamCategory, persona } = await loadSessionGrantContext(input.pool, input.sessionId)
    const grant = await input.brokerGrantClient.issue({
      sessionId: input.sessionId,
      agentId: input.agentId,
      principalId: input.actor.id,
      workstreamCategory,
      equipment,
      requestId: nameBasedUuid(EXECUTION_GRANT_REQUEST_NAMESPACE, input.sessionId),
    })
    const grantClient = await input.pool.connect()
    try {
      await bindExecutionGrantRef(grantClient, input.sessionId, grant.grantRef)
    } finally {
      grantClient.release()
    }

    await materializeSessionRuntime(input.transport, input.sessionId as never, randomUUID(), {
      agentId: input.agentId,
      runtimeDefinitionVersion: input.runtimeDefinitionVersion,
      ...(persona !== undefined ? { persona } : {}),
      executionGrantRef: grant.grantRef,
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
      capabilityPolicyVersion: grant.policyVersion,
      capabilityDigest: Buffer.from(grant.capabilityDigest, 'hex'),
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
    await failClosed(input.pool, input.sessionId, 'provisioning_failed', error, input.brokerGrantClient)
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
  readonly brokerGrantClient: BrokerGrantClient
  readonly connections: SessionConnectionRegistry
  readonly workstreamId: string
  readonly sessionId: string
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  readonly acpSessionId: string
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

    // `broker.execution_grants.session_id` is UNIQUE — a resume renews the Session's ONE grant
    // (rotating its upstream OneCLI bearer, docs/specs/10 "Renew") rather than issuing a new one.
    const grantRefClient = await input.pool.connect()
    let existingGrantRef: string | undefined
    try {
      existingGrantRef = await getExecutionGrantRef(grantRefClient, input.sessionId)
    } finally {
      grantRefClient.release()
    }
    if (!existingGrantRef) {
      throw new Error(`Session '${input.sessionId}' has no recorded execution grant reference to renew`)
    }
    const renewedGrant = await input.brokerGrantClient.renew(existingGrantRef, randomUUID())

    // Same Session, so the SAME persona — it is frozen at creation and re-read here rather than
    // remembered in memory, so a resume after a process restart still relaunches the right harness.
    const { persona } = await loadSessionGrantContext(input.pool, input.sessionId)

    await materializeSessionRuntime(input.transport, input.sessionId as never, randomUUID(), {
      agentId: input.agentId,
      runtimeDefinitionVersion: input.runtimeDefinitionVersion,
      ...(persona !== undefined ? { persona } : {}),
      executionGrantRef: renewedGrant.grantRef,
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
    await failClosed(input.pool, input.sessionId, 'resume_failed', error, input.brokerGrantClient)
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
      brokerGrantClient: input.brokerGrantClient,
      connections: input.connections,
      workstreamId: row.workstream_id,
      sessionId: input.sessionId,
      agentId: row.agent_id,
      runtimeDefinitionVersion: row.runtime_definition_version,
      acpSessionId: row.acp_session_id,
    })
    return { ok: true }
  }
  return { ok: false, code: 'conflict', detail: `Session phase '${phase ?? 'unknown'}' cannot be activated` }
}

export interface SwitchAgentInput {
  readonly pool: pg.Pool
  readonly transport: SessionRuntimeControlTransport
  readonly brokerGrantClient: BrokerGrantClient
  readonly connections: SessionConnectionRegistry
  readonly workstreamId: string
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  /** Product intent recorded on the Session's launch envelope. NOT a volume reference: since P11 the
   * Runtime workspace is always an ephemeral per-Pod emptyDir and nothing is ever mounted from this. */
  readonly workspaceRef: string
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
            workspaceSpec: { workspaceRef: input.workspaceRef },
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
      brokerGrantClient: input.brokerGrantClient,
      connections: input.connections,
      workstreamId: input.workstreamId,
      sessionId,
      agentId: input.agentId,
      runtimeDefinitionVersion: input.runtimeDefinitionVersion,
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
        brokerGrantClient: input.brokerGrantClient,
        connections: input.connections,
        workstreamId: input.workstreamId,
        sessionId,
        agentId: input.agentId,
        runtimeDefinitionVersion: input.runtimeDefinitionVersion,
        initialPrompt: [],
        actor: input.actor,
        now,
      })
    } else {
      const result = await activateSession({
        pool: input.pool,
        transport: input.transport,
        brokerGrantClient: input.brokerGrantClient,
        connections: input.connections,
        workstreamId: input.workstreamId,
        sessionId,
        agentId: input.agentId,
        runtimeDefinitionVersion: input.runtimeDefinitionVersion,
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
      brokerGrantClient: input.brokerGrantClient,
      connections: input.connections,
      workstreamId: input.workstreamId,
      sessionId,
      agentId: input.agentId,
      runtimeDefinitionVersion: input.runtimeDefinitionVersion,
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
    brokerGrantClient: input.brokerGrantClient,
    connections: input.connections,
    workstreamId: input.workstreamId,
    sessionId,
    agentId: input.agentId,
    runtimeDefinitionVersion: input.runtimeDefinitionVersion,
    acpSessionId,
    handoffPrompt: { content, handoffSource, idempotencyKey: promptIdempotencyKey },
    now,
  })
  return { ok: true, sessionId }
}

export interface SessionLifecycleInput {
  readonly pool: pg.Pool
  readonly transport: SessionRuntimeControlTransport
  readonly brokerGrantClient: BrokerGrantClient
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
    await failClosed(input.pool, input.sessionId, 'suspend_failed', error, input.brokerGrantClient)
  }
}

/**
 * Narrowed close (docs/specs/03 "Close"): cancels active work, dematerializes the real Session
 * Runtime. Still no grant/relay/OneCLI revocation (`DELETE /v1/execution-grants/{id}` exists on
 * the Broker, P08, since P11 — but wiring Close to call it is a deliberately separate follow-up,
 * not bundled into this fix). A closed Session's grant and OneCLI Agent are left dangling until
 * that follow-up lands.
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
    // docs/specs/10 "Terminal Session/Workstream cleanup deletes it after revocation" — last, and
    // only once the Session is durably 'closed', so a Broker hiccup can never strand the phase.
    await revokeSessionGrant({ pool: input.pool, brokerGrantClient: input.brokerGrantClient, sessionId: input.sessionId })
  } catch (error) {
    await failClosed(input.pool, input.sessionId, 'close_failed', error, input.brokerGrantClient)
  }
}
