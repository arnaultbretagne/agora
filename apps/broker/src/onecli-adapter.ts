/**
 * `apps/broker/ONECLI-SPIKE.md` + docs/specs/10-equipment-and-broker.md "Control plane": the ONLY
 * seam through which this deployable talks to OneCLI's control API. Deliberately Agora's OWN
 * abstraction (not a 1:1 mirror of `@onecli-sh/sdk`) so `FakeOneCliControlAdapter` (used by every
 * automated test in this plan) and a real, SDK-backed implementation can both satisfy it, and so
 * the Broker's own logic never depends on exactly which SDK call backs which operation.
 */

export interface OneCliAgentHandle {
  /** OneCLI's own non-public identifier for this Agent — never the Agora Session ID itself. */
  readonly identifier: string
}

export interface OneCliCredentialStub {
  readonly containerPath: string
  readonly content: string
}

export interface OneCliContainerConfig {
  readonly env: Readonly<Record<string, string>>
  readonly caCertificate: string
  readonly caCertificateContainerPath: string
  readonly credentialStubs: readonly OneCliCredentialStub[]
  /**
   * The upstream OneCLI proxy bearer extracted from `env` by the adapter itself — the ONLY place
   * in this codebase that is allowed to see it as plaintext outside `broker.upstream_authority`'s
   * ciphertext. Callers must move it into encrypted storage immediately and never log it.
   */
  readonly upstreamBearer: string
  readonly gatewayUrl: string
}

export interface PublishedRoute {
  readonly action: 'allow' | 'block'
  /** `'*'` only for the mandatory terminal rule. */
  readonly host: string
}

export interface RoutePolicyPublishResult {
  readonly generation: number
}

export class OneCliUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OneCliUnavailableError'
  }
}

/**
 * docs/specs/10 "Control plane" operations, in the order the Broker actually calls them. Every
 * method throws `OneCliUnavailableError` (never returns a partial/ambiguous success) on any
 * OneCLI-side failure — docs/specs/10 "Failure behavior": "OneCLI control API unavailable: no
 * issue/renew/materialize succeeds."
 */
export interface OneCliControlAdapter {
  /** Idempotent: calling twice with the same identifier returns the same Agent, never a duplicate.
   * A freshly created (non-default) OneCLI Agent is "selective" by construction — there is no
   * separate "set mode" call (ONECLI-SPIKE.md "OneCLI Agent isolation": only the DEFAULT Agent's
   * `all` mode is forbidden; this adapter never uses or returns the default Agent). */
  ensureSelectiveAgent(identifier: string, name: string): Promise<OneCliAgentHandle>
  /** Publishes the COMPLETE ordered route set (explicit allows, then a final explicit `block *`)
   * atomically — never a partial diff a caller must reconcile. */
  publishRoutePolicy(routes: readonly PublishedRoute[]): Promise<RoutePolicyPublishResult>
  /** Reads back the currently effective published generation, for the compiler's own
   * publish-then-verify step (docs/specs/10 "verify post-publication ordering/effective state"). */
  getPublishedGeneration(): Promise<number | undefined>
  getContainerConfig(identifier: string): Promise<OneCliContainerConfig>
  /** Immediately invalidates the Agent's current upstream bearer and issues a new one — the SAME Agent identity, a NEW token. */
  rotateAgentAuthority(identifier: string): Promise<void>
  /** Terminal — the identifier is never reused for a later Session (docs/specs/10 "One Session, one OneCLI Agent"). */
  deleteAgent(identifier: string): Promise<void>
}
