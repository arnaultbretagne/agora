import type { DesiredCredentialGrants } from './credential-policy.js'

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

export interface OneCliAgentSummary {
  readonly identifier: string
  /** OneCLI's own `createdAt`, used by the reaper's grace window — never Agora's clock. */
  readonly createdAt: Date
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
   * The upstream OneCLI proxy credential extracted from `env` by the adapter itself — the ONLY
   * place in this codebase that is allowed to see it as plaintext outside
   * `broker.upstream_authority`'s ciphertext. Callers must move it into encrypted storage
   * immediately and never log it.
   *
   * Deliberately NOT called a "bearer" (found live, P11 — that name caused a real, long-lived
   * bug): OneCLI's gateway speaks HTTP **Basic** proxy auth, and this value is the whole
   * `username:password` userinfo pair from the proxy URL OneCLI hands out
   * (`http://x:aoc_…@gateway`). The real `aoc_…` token is the PASSWORD half; the username is a
   * fixed dummy (`x`). Reading only the username, or sending the token as
   * `Proxy-Authorization: Bearer`, both make the gateway fall back to unauthenticated passthrough:
   * it stops intercepting TLS, never injects the provider credential, and the Agent gets a bare
   * 401 from the provider — which is exactly what happened in production. Verified live against
   * the real gateway: `Bearer <token>` -> passthrough (real provider cert); `Basic base64(x:token)`
   * -> intercepted (cert issued by "OneCLI Local Gateway CA", the operator-pinned CA).
   */
  readonly upstreamProxyCredential: string
  readonly gatewayUrl: string
}

/**
 * What `syncCredentialGrants` actually attached, as OneCLI instance ids — the intended set, to be
 * compared against `getEffectiveCredentials` before a grant is trusted. Ids, never names or
 * values: nothing here may become a credential hint in an audit row.
 */
export interface AttachedCredentials {
  readonly secretIds: readonly string[]
  readonly connectionIds: readonly string[]
}

/**
 * OneCLI's own ground truth for "can this Agent inject this credential"
 * (`GET /v1/agents/{id}/effective-credentials`). `status` is OneCLI's:
 * `usable` | `limited` | `blocked` | `none` | `unknown`. An Agent with no matching grant simply
 * lists nothing (verified live on 1.45.0) — absence IS denial.
 */
export interface EffectiveCredentialSet {
  readonly mode: string
  readonly secrets: readonly { readonly id: string; readonly status: string }[]
  readonly connections: readonly { readonly id: string; readonly status: string }[]
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
   * A freshly created (non-default) OneCLI Agent is selective and, on ≥1.44, holds ZERO credentials
   * until grants are attached — verified live on 1.45.0, `effective-credentials` reads
   * `{mode:"selective",secrets:[],connections:[]}`. There is no "set mode" call to make:
   * `PATCH /v1/agents/{id}/secret-mode` answers `410 Gone` ("agents are always selective now"). */
  ensureSelectiveAgent(identifier: string, name: string): Promise<OneCliAgentHandle>
  /**
   * ADR 0015: converges this Agent's OneCLI credential grants onto exactly `desired` — attaching
   * what is missing and DETACHING anything else the Agent holds, so a re-issue can never leave a
   * stale credential behind. Resolves OneCLI's per-instance `secretId`/`connectionId` from the
   * type/provider names in `desired` at call time (never hardcoded ids). Idempotent.
   */
  syncCredentialGrants(identifier: string, desired: DesiredCredentialGrants): Promise<AttachedCredentials>
  /** OneCLI's own effective-credentials oracle, for the grants-effect verification that replaced
   * the retired publish-then-verify step (docs/specs/10 "verify ... effective state"). */
  getEffectiveCredentials(identifier: string): Promise<EffectiveCredentialSet>
  getContainerConfig(identifier: string): Promise<OneCliContainerConfig>
  /** Immediately invalidates the Agent's current upstream bearer and issues a new one — the SAME Agent identity, a NEW token. */
  rotateAgentAuthority(identifier: string): Promise<void>
  /** Terminal — the identifier is never reused for a later Session (docs/specs/10 "One Session, one OneCLI Agent"). */
  deleteAgent(identifier: string): Promise<void>
  /** Every Agent OneCLI currently holds — the reaper's reconciliation input
   * (`onecli-agent-reaper.ts`). Identifier and creation time only: `GET /v1/agents` rows also
   * carry each Agent's `accessToken` in cleartext, which never leaves the adapter. */
  listAgents(): Promise<readonly OneCliAgentSummary[]>
}
