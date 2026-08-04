import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import * as acp from '@agentclientprotocol/sdk'
import { bootstrapSession, cancelSession as acpCancelSession, promptSession, resumeAcpSession } from '@agora/acp'
import { nameBasedUuid } from '@agora/domain'
import { getAnchor, transitionSessionPhase, upsertAnchor } from '@agora/store-pg'
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
  readonly actor: { readonly kind: 'human' | 'service' | 'system'; readonly id: string }
  readonly now?: () => Date
}

/** Exported so tests can replicate the exact derivation to simulate a crash between capture and Anchor commit. */
export const SUSPEND_CAPTURE_NAMESPACE = 'cbf5fa7c-3128-4e7e-b25a-3c4c7dd33084'

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
        purpose: 'user',
        actor: input.actor,
        idempotencyKey: 'initial-prompt',
        now,
      })
    }
  } catch (error) {
    await failClosed(input.pool, input.sessionId, 'provisioning_failed', error)
  }
}

export type ActivateResult = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly detail: string }

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
