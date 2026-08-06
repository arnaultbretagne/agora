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
      credentialStubs: fakeCredentialStubs(identifier),
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
 * own `getContainerConfig` always returns exactly this CA and `fakeCredentialStubs`' own stub. */
export const FAKE_CA_CERTIFICATE = '-----BEGIN CERTIFICATE-----\nFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n-----END CERTIFICATE-----\n'

// Fixed across every Agent — only the signature (3rd segment) varies below, reproducing what
// OneCLI's own real id_token does (verified live, P11): identical header+payload, re-signed per
// Agent. Never a real credential — the claims are fake, the "signature" is just a hash.
const FAKE_ID_TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
const FAKE_ID_TOKEN_PAYLOAD = Buffer.from(
  JSON.stringify({ sub: 'fake-account', email: 'fake@example.test', exp: 4102444800, iat: 1735689600 }),
).toString('base64url')

/**
 * A faithful double of OneCLI's real per-Agent credential-stub behavior (this file's own module
 * doc): the SAME underlying account identity (fixed header+payload), a DIFFERENT signature per
 * Agent identifier — grant-service.ts's own drift check must treat two different Agents' stubs as
 * matching despite the raw bytes differing, exactly as the real product requires.
 */
export function fakeCredentialStubs(identifier: string): { readonly containerPath: string; readonly content: string }[] {
  const signature = createHash('sha256').update(identifier).digest('base64url')
  const idToken = `${FAKE_ID_TOKEN_HEADER}.${FAKE_ID_TOKEN_PAYLOAD}.${signature}`
  return [
    {
      containerPath: '/home/node/.codex/auth.json',
      content: JSON.stringify({ tokens: { id_token: idToken, access_token: 'onecli-managed', refresh_token: 'onecli-managed' } }),
    },
  ]
}
