import { createHash, randomBytes } from 'node:crypto'
import type {
  OneCliAgentHandle,
  OneCliContainerConfig,
  OneCliControlAdapter,
  PublishedRoute,
  RoutePolicyPublishResult,
} from './onecli-adapter.js'
import { OneCliUnavailableError } from './onecli-adapter.js'

/**
 * A faithful double of OneCLI's control plane behavior, used by every automated Broker test in
 * this plan (per the standing "real infra we own, faithful double for what we don't" pattern).
 * Deliberately reproduces the invariants `ONECLI-SPIKE.md` proved against the real product:
 * Agent creation is idempotent by identifier, `getContainerConfig` fails until an Agent exists,
 * route publication is atomic and versioned, deleted Agents can never be materialized again.
 */
export class FakeOneCliControlAdapter implements OneCliControlAdapter {
  private readonly agents = new Map<string, { deleted: boolean; bearer: string }>()
  private routeGeneration: number | undefined
  private publishedRoutes: readonly PublishedRoute[] = []
  unavailable = false
  /** Overridable so relay E2E tests can point it at a real, locally listening `FakeOnecliGateway` instance. */
  gatewayUrl = 'https://fake-onecli-gateway.internal:8443'
  /** Test-only: makes the NEXT `getPublishedGeneration()` call return a stale value once, simulating
   * OneCLI-side publish/cache-invalidation ambiguity (docs/specs/10's own "verify post-publication
   * ordering/effective state"), then reverts to reporting the true generation. */
  simulateStaleGenerationOnce = false

  async ensureSelectiveAgent(identifier: string, _name: string): Promise<OneCliAgentHandle> {
    this.checkAvailable()
    const existing = this.agents.get(identifier)
    if (existing?.deleted) {
      throw new OneCliUnavailableError(`onecli agent ${identifier} was deleted and cannot be reused`)
    }
    if (!existing) {
      this.agents.set(identifier, { deleted: false, bearer: freshBearer(identifier) })
    }
    return { identifier }
  }

  async publishRoutePolicy(routes: readonly PublishedRoute[]): Promise<RoutePolicyPublishResult> {
    this.checkAvailable()
    const last = routes[routes.length - 1]
    if (!last || last.host !== '*' || last.action !== 'block') {
      throw new Error('route policy must end with an explicit terminal block *')
    }
    this.routeGeneration = (this.routeGeneration ?? 0) + 1
    this.publishedRoutes = routes
    return { generation: this.routeGeneration }
  }

  async getPublishedGeneration(): Promise<number | undefined> {
    this.checkAvailable()
    if (this.simulateStaleGenerationOnce) {
      this.simulateStaleGenerationOnce = false
      return (this.routeGeneration ?? 1) - 1
    }
    return this.routeGeneration
  }

  /** Exposed for tests asserting on what was actually published, not just that publish succeeded. */
  getPublishedRoutesForTest(): readonly PublishedRoute[] {
    return this.publishedRoutes
  }

  async getContainerConfig(identifier: string): Promise<OneCliContainerConfig> {
    this.checkAvailable()
    const agent = this.agents.get(identifier)
    if (!agent || agent.deleted) {
      throw new OneCliUnavailableError(`onecli agent ${identifier} does not exist`)
    }
    return {
      env: { ONECLI_AGENT_TOKEN: agent.bearer, ONECLI_GATEWAY_URL: this.gatewayUrl },
      caCertificate: FAKE_CA_CERTIFICATE,
      caCertificateContainerPath: '/etc/onecli/ca.pem',
      credentialStubs: [],
      upstreamBearer: agent.bearer,
      gatewayUrl: this.gatewayUrl,
    }
  }

  /** Used only by `FakeOnecliGateway` (apps/broker/src/onecli-fake-gateway.ts) to authenticate an
   * incoming CONNECT's bearer — mirrors what OneCLI's real gateway does internally, which Agora's
   * own code never has visibility into. */
  findIdentifierForBearerForTest(bearer: string): string | undefined {
    for (const [identifier, agent] of this.agents) {
      if (!agent.deleted && agent.bearer === bearer) return identifier
    }
    return undefined
  }

  async rotateAgentAuthority(identifier: string): Promise<void> {
    this.checkAvailable()
    const agent = this.agents.get(identifier)
    if (!agent || agent.deleted) {
      throw new OneCliUnavailableError(`onecli agent ${identifier} does not exist`)
    }
    agent.bearer = freshBearer(identifier)
  }

  async deleteAgent(identifier: string): Promise<void> {
    this.checkAvailable()
    const agent = this.agents.get(identifier)
    if (!agent) return
    agent.deleted = true
    agent.bearer = ''
  }

  private checkAvailable(): void {
    if (this.unavailable) throw new OneCliUnavailableError('fake onecli control plane is set unavailable for this test')
  }
}

function freshBearer(identifier: string): string {
  return `aoc_fake_${createHash('sha256').update(identifier).update(randomBytes(16)).digest('hex')}`
}

/** Exported for tests to build a matching `ExpectedRuntimeBundle` (grant-service.ts) — this fake's
 * own `getContainerConfig` always returns exactly this CA and an empty stub list. */
export const FAKE_CA_CERTIFICATE = '-----BEGIN CERTIFICATE-----\nFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n-----END CERTIFICATE-----\n'
