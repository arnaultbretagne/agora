import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { probeAgentConfiguration } from '@agora/acp'
import { nameBasedUuid, type EquipmentRequest } from '@agora/domain'
import { getAgentConfigCatalogue, putAgentConfigCatalogue, type AgentConfigCatalogue } from '@agora/store-pg'
import {
  dematerializeSessionRuntime,
  getSessionRuntime,
  materializeSessionRuntime,
  openACPConnection,
  type SessionRuntimeControlTransport,
} from '@agora/session-runtime-control'
import type pg from 'pg'
import type { BrokerGrantClient } from './broker-grant-client.js'
import { connectAcpBridge } from './bridge-client.js'

/**
 * P12 — "what can this Agent be configured with?", answered before any conversation exists.
 *
 * An ACP Agent publishes its config options in the `session/new` response and nowhere else, so the
 * composer of a brand-new conversation has nothing to show and its model button rendered `disabled`
 * (reported live 2026-08-07). Two mechanisms fix that, in this order:
 *
 *  1. the memo — every real `session/new` writes what that Agent advertised into
 *     `product.agent_config_catalogue`, so the second conversation onwards always has a list;
 *  2. the empty run — an Agent with no memo (a harness never launched at this runtime definition
 *     version) is materialized once, asked `initialize` + `session/new`, and torn straight down.
 *
 * The operator chose this over declaring models in the Agent registry: a declared list is a curated
 * product list, which docs/specs/04 refuses and which goes stale the moment a harness ships a new
 * model. Nothing here invents an option — every value shown to a user came out of a real harness.
 */

/** Deterministic, never `randomUUID()`: the controller is addressed by Session id, and a retried probe must land on the SAME Runtime rather than materializing a second one. */
export const CONFIG_PROBE_SESSION_NAMESPACE = 'b4b3b8b1-0f0e-4a9a-9b0e-1a1d4d3a2c77'

/** Same reasoning as `EXECUTION_GRANT_REQUEST_NAMESPACE` in orchestration.ts: the Broker is idempotent by (sessionId, requestId), so a retried probe renews rather than collides. */
export const CONFIG_PROBE_GRANT_NAMESPACE = '2c1c9d5e-7a1e-4c1e-9f83-6a5b0a4f21d2'

/** A probe asks a question; it never runs work. The Session it names has no Workstream, no journal and no custody — it exists only as the controller's key for one throwaway Pod. */
function probeSessionId(agentId: string, runtimeDefinitionVersion: string): string {
  return nameBasedUuid(CONFIG_PROBE_SESSION_NAMESPACE, `${agentId}:${runtimeDefinitionVersion}`)
}

export type CatalogueState = 'known' | 'probing' | 'unknown' | 'unavailable'

export interface CatalogueView {
  readonly state: CatalogueState
  readonly options: readonly unknown[]
  readonly observedAt?: string
  /** Present only for `unavailable`: why the last empty run failed, so the UI can say what happened instead of leaving a dead control with no reason. */
  readonly detail?: string
}

export interface ConfigCatalogueServiceDeps {
  readonly pool: pg.Pool
  readonly transport: SessionRuntimeControlTransport
  readonly brokerGrantClient: BrokerGrantClient
  /** The empty run needs an equipment request to obtain a grant; it is always the empty one — a probe touches no resource. */
  readonly equipmentCatalogueVersion: () => string
  readonly now?: () => Date
  /** Overridable so tests can shorten the wait; the real value matches orchestration's own materialize wait. */
  readonly readyTimeoutMs?: number
}

export class ConfigCatalogueService {
  /**
   * One in-flight empty run per (Agent, runtime definition version).
   *
   * Without it, a composer that asks on every render — or two operators opening the page at once —
   * would each materialize a Pod for the same question, and the run namespace's quota is small
   * enough (4-5 Pods) that this alone could refuse real work. The promise is shared, not just a
   * boolean flag, so callers can await the same answer instead of polling a lock.
   */
  private readonly inFlight = new Map<string, Promise<CatalogueView>>()

  /** The last empty-run failure per key, so a repeated ask reports the reason instead of silently starting another Pod. */
  private readonly lastFailure = new Map<string, string>()

  constructor(private readonly deps: ConfigCatalogueServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  /** Reads the memo only. Never starts anything — a GET is a question about what is known. */
  async read(agentId: string, runtimeDefinitionVersion: string): Promise<CatalogueView> {
    const key = `${agentId}:${runtimeDefinitionVersion}`
    const client = await this.deps.pool.connect()
    let catalogue: AgentConfigCatalogue | undefined
    try {
      catalogue = await getAgentConfigCatalogue(client, agentId, runtimeDefinitionVersion)
    } finally {
      client.release()
    }
    if (catalogue) return { state: 'known', options: catalogue.options, observedAt: catalogue.observedAt.toISOString() }
    if (this.inFlight.has(key)) return { state: 'probing', options: [] }
    const failure = this.lastFailure.get(key)
    if (failure) return { state: 'unavailable', options: [], detail: failure }
    return { state: 'unknown', options: [] }
  }

  /**
   * Records what an Agent advertised on a REAL Session's `session/new` (or on the full set it hands
   * back from a config change). This is the path that keeps the memo current for free — the empty
   * run below only exists for Agents this has never seen.
   *
   * Never throws into its caller: a Session that is genuinely live must not fail because a cache
   * write did.
   */
  async remember(input: {
    readonly agentId: string
    readonly runtimeDefinitionVersion: string
    readonly options: unknown
  }): Promise<void> {
    try {
      const client = await this.deps.pool.connect()
      try {
        const written = await putAgentConfigCatalogue(client, {
          agentId: input.agentId,
          runtimeDefinitionVersion: input.runtimeDefinitionVersion,
          options: input.options,
          observedAt: this.now(),
        })
        if (written) this.lastFailure.delete(`${input.agentId}:${input.runtimeDefinitionVersion}`)
      } finally {
        client.release()
      }
    } catch (error) {
      process.stderr.write(`config-catalogue: could not record options for ${input.agentId}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  /**
   * Starts (or joins) the empty run for an Agent with no memo. Returns as soon as the run is under
   * way — the caller answers 202 and the client re-reads; `awaitProbe` is for tests and for callers
   * that genuinely want the answer.
   */
  probe(agentId: string, runtimeDefinitionVersion: string, principalId: string): Promise<CatalogueView> {
    const key = `${agentId}:${runtimeDefinitionVersion}`
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const run = this.runProbe(agentId, runtimeDefinitionVersion, principalId).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, run)
    // A rejected in-flight promise nobody awaits is an unhandled rejection; the failure is already
    // recorded in `lastFailure` by `runProbe` itself, which is what the next read reports.
    run.catch(() => {})
    return run
  }

  private async runProbe(agentId: string, runtimeDefinitionVersion: string, principalId: string): Promise<CatalogueView> {
    const key = `${agentId}:${runtimeDefinitionVersion}`
    const sessionId = probeSessionId(agentId, runtimeDefinitionVersion)
    // Equipment is empty by construction: a probe answers a question about the harness itself and
    // must never be a way to obtain capabilities without a conversation to attribute them to.
    const equipment: EquipmentRequest = { catalogueVersion: this.deps.equipmentCatalogueVersion(), resources: [] } as unknown as EquipmentRequest
    let grantRef: string | undefined
    try {
      const grant = await this.deps.brokerGrantClient.ensure({
        sessionId,
        agentId,
        principalId,
        workstreamCategory: 'discussion',
        equipment,
        requestId: nameBasedUuid(CONFIG_PROBE_GRANT_NAMESPACE, sessionId),
      })
      grantRef = grant.grantRef

      await materializeSessionRuntime(this.deps.transport, sessionId as never, randomUUID(), {
        agentId,
        runtimeDefinitionVersion,
        executionGrantRef: grant.grantRef,
      })
      await this.waitForReady(sessionId)

      const endpoint = await openACPConnection(this.deps.transport, sessionId as never, randomUUID())
      const stream = await connectAcpBridge(endpoint.url, endpoint.credential)
      const probed = await probeAgentConfiguration({ stream, cwd: '/home/node/work' })

      const client = await this.deps.pool.connect()
      try {
        const written = await putAgentConfigCatalogue(client, {
          agentId,
          runtimeDefinitionVersion,
          options: probed.configOptions,
          observedAt: this.now(),
        })
        if (!written) {
          // A harness that genuinely offers no configuration is a real answer, not a failure — but
          // it is not a memo either (nothing to show), so it is reported as such rather than
          // re-probed on every render.
          this.lastFailure.set(key, `Agent '${agentId}' advertises no configuration options`)
          return { state: 'unavailable', options: [], detail: this.lastFailure.get(key)! }
        }
      } finally {
        client.release()
      }
      this.lastFailure.delete(key)
      return this.read(agentId, runtimeDefinitionVersion)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.lastFailure.set(key, detail)
      return { state: 'unavailable', options: [], detail }
    } finally {
      // The Pod goes back whatever happened — a probe that leaked its Runtime would hold a quota
      // slot for a question that is already answered, which is exactly the failure mode that made
      // the run namespace refuse all new work on 2026-08-07.
      try {
        await dematerializeSessionRuntime(this.deps.transport, sessionId as never, randomUUID())
      } catch (error) {
        process.stderr.write(`config-catalogue: could not dematerialize probe runtime ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`)
      }
      if (grantRef) {
        try {
          await this.deps.brokerGrantClient.revoke(grantRef, randomUUID())
        } catch {
          // Same posture as orchestration's own `revokeSessionGrant`: the grant expires on its own
          // and an operator sweep reclaims the Agent; failing the probe over cleanup would be worse.
        }
      }
    }
  }

  private async waitForReady(sessionId: string): Promise<void> {
    const timeoutMs = this.deps.readyTimeoutMs ?? 60_000
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const status = await getSessionRuntime(this.deps.transport, sessionId as never)
      if (status.state === 'ready') return
      if (status.state === 'failed') throw new Error(`probe Runtime failed to become ready: ${JSON.stringify(status.failure)}`)
      if (Date.now() > deadline) throw new Error(`timed out waiting for the probe Runtime of '${sessionId}' to become ready`)
      await sleep(500)
    }
  }
}
