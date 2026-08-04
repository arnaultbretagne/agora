import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import * as acp from '@agentclientprotocol/sdk'
import { bootstrapSession, cancelSession as acpCancelSession, promptSession } from '@agora/acp'
import { transitionSessionPhase } from '@agora/store-pg'
import {
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

/**
 * Narrowed to what real infra supports today: a `requested` Session runs the real provisioning
 * chain; an already-live Session is a no-op; a `suspended` Session needs custody restore (P06,
 * not implemented) so it fails closed with a typed, honest reason rather than hanging or
 * pretending to resume.
 */
export async function activateSession(
  input: Omit<ProvisionSessionInput, 'initialPrompt'>,
): Promise<ActivateResult> {
  const client = await input.pool.connect()
  let phase: string | undefined
  try {
    const { rows } = await client.query<{ phase: string }>('SELECT phase FROM product.sessions WHERE id = $1', [input.sessionId])
    phase = rows[0]?.phase
  } finally {
    client.release()
  }

  if (phase === 'ready' || phase === 'busy') return { ok: true }
  if (phase === 'requested') {
    void provisionSessionAndPrompt({ ...input, initialPrompt: [] })
    return { ok: true }
  }
  if (phase === 'suspended') {
    return { ok: false, code: 'resume_failed', detail: 'Resume requires a custody restore (plans/06-custody-and-resume.md), not implemented yet' }
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

/**
 * Narrowed suspend (docs/specs/03 "Suspend"): dematerializes the real Session Runtime (P04) —
 * no custody snapshot (P06 doesn't exist yet), so a Session suspended today has no resume point;
 * `activateSession` fails closed on it rather than pretending resume is possible.
 */
export async function suspendSession(input: SessionLifecycleInput): Promise<void> {
  const openClient = await input.pool.connect()
  try {
    await transitionSessionPhase(openClient, input.sessionId, 'suspending')
  } finally {
    openClient.release()
  }
  try {
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
