import { createHash, randomBytes } from 'node:crypto'
import type { DesiredCredentialGrants } from './credential-policy.js'
import type {
  AttachedCredentials,
  EffectiveCredentialSet,
  OneCliAgentHandle,
  OneCliAgentSummary,
  OneCliContainerConfig,
  OneCliControlAdapter,
} from './onecli-adapter.js'
import { OneCliUnavailableError } from './onecli-adapter.js'

/**
 * A faithful double of OneCLI's control plane behavior, used by every automated Broker test in
 * this plan (per the standing "real infra we own, faithful double for what we don't" pattern).
 * Deliberately reproduces the invariants proved against the real product — `ONECLI-SPIKE.md` for
 * the 1.43.3 era, plus a staging **1.45.0** instance probed live on 2026-08-09 for everything
 * P13 changed:
 *
 * - Agent creation is idempotent by identifier; deleted Agents can never be materialized again.
 * - A freshly created Agent holds ZERO credentials (`{mode:"selective",secrets:[],connections:[]}`)
 *   — grants are the only way in, so isolation is correct by construction and fail-closed.
 * - Grants take effect immediately: no publish, no generation, no ordering.
 * - Detaching a grant returns the Agent to the empty set, and touching one Agent's grants changes
 *   nothing for another Agent (there is no shared/global policy left to republish).
 * - `getContainerConfig`'s credential stubs depend on WHICH credentials the Agent has been granted
 *   — read from the real 1.45.0 server bundle, which resolves the Agent's accessible credentials
 *   first and only then emits the Codex `auth.json` stub. This is why `grant-service.ts` attaches
 *   grants BEFORE it pulls the container config, and why the operator-pinned stub expectation is a
 *   reviewed SUPERSET rather than an exact set.
 */

/** The project-level credential catalogue this double stands in for. Ids are stable and fake;
 * `type`/`provider` match the real ones the operator's instance holds (verified live). */
export const FAKE_SECRETS: readonly { readonly id: string; readonly type: string }[] = [
  { id: 'fake-secret-anthropic', type: 'anthropic' },
  { id: 'fake-secret-openai', type: 'openai' },
]

export const FAKE_CONNECTIONS: readonly { readonly id: string; readonly provider: string }[] = [
  { id: 'fake-connection-github-app', provider: 'github-app' },
]

interface FakeAgent {
  deleted: boolean
  bearer: string
  createdAt: Date
  secretIds: Set<string>
  connections: Map<string, readonly string[]>
}

export class FakeOneCliControlAdapter implements OneCliControlAdapter {
  private readonly agents = new Map<string, FakeAgent>()
  unavailable = false
  /** Overridable so relay E2E tests can point it at a real, locally listening `FakeOnecliGateway` instance. */
  gatewayUrl = 'https://fake-onecli-gateway.internal:8443'
  /** Test-only: makes the NEXT `getEffectiveCredentials()` call report the Agent as holding
   * nothing, simulating OneCLI accepting a grant write that did not actually take effect
   * (docs/specs/10's own "verify ... effective state"), then reverts to the truth. */
  simulateIneffectiveGrantsOnce = false
  /** Test-only: makes the NEXT `getEffectiveCredentials()` call report an EXTRA credential the
   * Broker never asked for — the "materialized the whole pool instead of the intended grants"
   * failure the ≥1.44 boot converter could produce on an upgraded instance. */
  simulateExtraCredentialOnce = false

  /**
   * Re-creating a previously deleted identifier SUCCEEDS, and returns a fresh Agent.
   *
   * This double used to refuse it, on the strength of `deleteAgent`'s "terminal — the identifier is
   * never reused for a later Session" contract. That contract is about not handing one Session's
   * identifier to a DIFFERENT Session; it says nothing about the same Session getting its own
   * identifier back, which is what a resume does (the identifier is derived from the Session id).
   *
   * The difference matters enough that it was measured rather than reasoned about: against the real
   * OneCLI on 2026-08-11, creating `sagt-…`, deleting it, and creating it again returned 201 with
   * the same identifier and a NEW internal id. A double that is stricter than the system it stands
   * in for does not make tests safer — it makes correct designs look impossible.
   */
  async ensureSelectiveAgent(identifier: string, _name: string): Promise<OneCliAgentHandle> {
    this.checkAvailable()
    const existing = this.agents.get(identifier)
    if (!existing || existing.deleted) {
      // A fresh bearer and a fresh createdAt, exactly as the real one returns a new internal id:
      // nothing of the deleted Agent's authority survives its re-creation.
      this.agents.set(identifier, { deleted: false, bearer: freshBearer(identifier), createdAt: new Date(), secretIds: new Set(), connections: new Map() })
    }
    return { identifier }
  }

  async syncCredentialGrants(identifier: string, desired: DesiredCredentialGrants): Promise<AttachedCredentials> {
    this.checkAvailable()
    const agent = this.requireAgent(identifier)

    const secretIds = desired.secretTypes.map((type) => {
      const match = FAKE_SECRETS.find((secret) => secret.type === type)
      if (!match) throw new OneCliUnavailableError(`onecli holds no secret of type '${type}'`)
      return match.id
    })
    const connections = desired.connections.map((wanted) => {
      const match = FAKE_CONNECTIONS.find((connection) => connection.provider === wanted.provider)
      if (!match) throw new OneCliUnavailableError(`onecli holds no connection for provider '${wanted.provider}'`)
      return { id: match.id, allowedToolIds: wanted.allowedToolIds }
    })

    // Converge, exactly like the real adapter: anything not wanted is detached, never left behind.
    agent.secretIds = new Set(secretIds)
    agent.connections = new Map(connections.map((connection) => [connection.id, connection.allowedToolIds]))

    return { secretIds, connectionIds: connections.map((connection) => connection.id) }
  }

  async getEffectiveCredentials(identifier: string): Promise<EffectiveCredentialSet> {
    this.checkAvailable()
    const agent = this.requireAgent(identifier)
    if (this.simulateIneffectiveGrantsOnce) {
      this.simulateIneffectiveGrantsOnce = false
      return { mode: 'selective', secrets: [], connections: [] }
    }
    const secrets = [...agent.secretIds].map((id) => ({ id, status: 'usable' }))
    if (this.simulateExtraCredentialOnce) {
      this.simulateExtraCredentialOnce = false
      const extra = FAKE_SECRETS.find((secret) => !agent.secretIds.has(secret.id))
      if (extra) secrets.push({ id: extra.id, status: 'usable' })
    }
    return {
      mode: 'selective',
      secrets,
      connections: [...agent.connections.keys()].map((id) => ({ id, status: 'usable' })),
    }
  }

  /** Exposed for tests asserting on what an Agent actually ended up holding, not just that the
   * sync call returned. */
  getGrantedToolIdsForTest(identifier: string, connectionId: string): readonly string[] | undefined {
    return this.agents.get(identifier)?.connections.get(connectionId)
  }

  async getContainerConfig(identifier: string): Promise<OneCliContainerConfig> {
    this.checkAvailable()
    const agent = this.agents.get(identifier)
    if (!agent || agent.deleted) {
      throw new OneCliUnavailableError(`onecli agent ${identifier} does not exist`)
    }
    // `x:<token>` — the real OneCLI hands out `http://x:aoc_…@gateway` and its gateway authenticates
    // the whole userinfo pair via HTTP Basic (verified live, P11). This double previously exposed a
    // bare token, which let the real adapter's own username-vs-password extraction bug pass tests.
    const proxyCredential = `${FAKE_PROXY_USERNAME}:${agent.bearer}`
    // Grants-dependent, exactly like the real 1.45.0 product: the Codex `auth.json` stub exists
    // only for an Agent that has actually been granted the OpenAI credential.
    const openaiSecretId = FAKE_SECRETS.find((secret) => secret.type === 'openai')?.id
    const credentialStubs = openaiSecretId && agent.secretIds.has(openaiSecretId) ? fakeCredentialStubs(identifier) : []
    return {
      env: { HTTPS_PROXY: `${this.gatewayUrl.replace('://', `://${FAKE_PROXY_USERNAME}:${encodeURIComponent(agent.bearer)}@`)}` },
      caCertificate: FAKE_CA_CERTIFICATE,
      caCertificateContainerPath: '/etc/onecli/ca.pem',
      credentialStubs,
      upstreamProxyCredential: proxyCredential,
      gatewayUrl: this.gatewayUrl,
    }
  }

  /** Used only by `FakeOnecliGateway` (apps/broker/src/onecli-fake-gateway.ts) to authenticate an
   * incoming CONNECT's Basic credential — mirrors what OneCLI's real gateway does internally, which
   * Agora's own code never has visibility into. Takes the decoded `username:token` pair. */
  findIdentifierForProxyCredentialForTest(credential: string): string | undefined {
    for (const [identifier, agent] of this.agents) {
      if (!agent.deleted && `${FAKE_PROXY_USERNAME}:${agent.bearer}` === credential) return identifier
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
    // Deleting the Agent deletes its grants with it — the credential authority is gone, not orphaned.
    agent.secretIds.clear()
    agent.connections.clear()
  }

  async listAgents(): Promise<readonly OneCliAgentSummary[]> {
    this.checkAvailable()
    return [...this.agents.entries()]
      .filter(([, agent]) => !agent.deleted)
      .map(([identifier, agent]) => ({ identifier, createdAt: agent.createdAt }))
  }

  /** Test-only: back-date an Agent's OneCLI-side creation time so a reaper grace-window test does
   * not have to sleep. */
  setAgentCreatedAtForTest(identifier: string, createdAt: Date): void {
    const agent = this.agents.get(identifier)
    if (agent) agent.createdAt = createdAt
  }

  private requireAgent(identifier: string): FakeAgent {
    const agent = this.agents.get(identifier)
    if (!agent || agent.deleted) throw new OneCliUnavailableError(`onecli agent ${identifier} does not exist`)
    return agent
  }

  private checkAvailable(): void {
    if (this.unavailable) throw new OneCliUnavailableError('fake onecli control plane is set unavailable for this test')
  }
}

function freshBearer(identifier: string): string {
  return `aoc_fake_${createHash('sha256').update(identifier).update(randomBytes(16)).digest('hex')}`
}

/** Exported for tests to build a matching `ExpectedRuntimeBundle` (grant-service.ts) — this fake's
 * own `getContainerConfig` always returns exactly this CA, and `fakeCredentialStubs`' own stub
 * whenever the Agent holds the OpenAI credential grant. */
export const FAKE_CA_CERTIFICATE = '-----BEGIN CERTIFICATE-----\nFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n-----END CERTIFICATE-----\n'

/** The fixed dummy proxy username OneCLI itself uses in the `http://x:aoc_…@gateway` URL it hands out (verified live, P11). */
const FAKE_PROXY_USERNAME = 'x'

// Fixed across every Agent — only the signature (3rd segment) varies below, reproducing what
// OneCLI's own real id_token does (verified live, P11): identical header+payload, re-signed per
// Agent. Never a real credential — the claims are fake, the "signature" is just a hash.
const FAKE_ID_TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
const FAKE_ID_TOKEN_PAYLOAD = Buffer.from(
  JSON.stringify({ sub: 'fake-account', email: 'fake@example.test', exp: 4102444800, iat: 1735689600 }),
).toString('base64url')

let fakeRefreshCounter = 0

/**
 * A faithful double of OneCLI's real per-Agent credential-stub behavior (this file's own module
 * doc): the SAME underlying account identity (fixed header+payload), a DIFFERENT signature per
 * Agent identifier — grant-service.ts's own drift check must treat two different Agents' stubs as
 * matching (same underlying account, different signature), the exact live P11 finding, rather than
 * accidentally passing only because both sides happen to be the same object. Also reproduces
 * `last_refresh`, verified live to change on EVERY call (even for the same Agent) — a fresh
 * counter value each call, deliberately never equal to a prior call's, same as the real product.
 */
export function fakeCredentialStubs(identifier: string): { readonly containerPath: string; readonly content: string }[] {
  const signature = createHash('sha256').update(identifier).digest('base64url')
  const idToken = `${FAKE_ID_TOKEN_HEADER}.${FAKE_ID_TOKEN_PAYLOAD}.${signature}`
  fakeRefreshCounter += 1
  return [
    {
      containerPath: '/home/node/.codex/auth.json',
      content: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { id_token: idToken, access_token: 'onecli-managed', refresh_token: 'onecli-managed', account_id: 'onecli-managed' },
        last_refresh: `fake-refresh-${fakeRefreshCounter}`,
      }),
    },
  ]
}
