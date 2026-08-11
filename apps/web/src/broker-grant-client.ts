import type { EquipmentRequest } from '@agora/domain'

/**
 * docs/specs/10-equipment-and-broker.md "Execution grant" — apps/web's own seam to the Broker's
 * `POST /v1/execution-grants` (issue) and `POST /v1/execution-grants/{id}/renew` (docs/specs/10
 * "Renew: preserve capability digest and rotate/extend private authority"). Deployables never
 * import each other, even in test code (see test/support/fake-broker.ts) — same convention as
 * apps/session-runtime-controller/src/broker-activation-client.ts's own narrow HTTP client for
 * ITS one Broker endpoint. `security: mutualTLS` (contracts/openapi/broker-control.yaml) is a
 * deployment-level policy — "trust the transport," same convention documented in server.ts's own
 * module doc for `X-Forwarded-Email`.
 *
 * Found live, P11: this seam did not exist until now — `orchestration.ts` used a fixed
 * `FAKE_EXECUTION_GRANT_REF`/`FAKE_CAPABILITY_POLICY_VERSION` placeholder (bridge-client.ts) left
 * over from before the Broker (P08) existed, never retrofitted once it shipped. A materialize
 * built on a grant reference the Broker never issued always fails at activation time (the Broker
 * has no record of it) — this is the real fix for that gap, not a quick patch.
 */
export interface IssueGrantRequest {
  readonly sessionId: string
  readonly agentId: string
  readonly principalId: string
  readonly workstreamCategory: 'discussion' | 'invocation'
  readonly equipment: EquipmentRequest
  readonly requestId: string
}

/** Same wire shape for issue and renew responses (apps/broker/src/server.ts's own `wireGrant`). */
export interface IssuedGrant {
  readonly grantId: string
  readonly grantRef: string
  readonly sessionId: string
  readonly agentId: string
  readonly policyVersion: string
  /** Hex-encoded SHA-256 (32 bytes) — the wire shape `apps/broker/src/grants-repository.ts` serializes. */
  readonly capabilityDigest: string
  readonly capabilities: readonly unknown[]
  readonly mcpServers: readonly unknown[]
  readonly expiresAt: string
}

export class BrokerGrantDeniedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BrokerGrantDeniedError'
  }
}

export interface BrokerGrantClient {
  issue(request: IssueGrantRequest): Promise<IssuedGrant>
  renew(grantId: string, requestId: string): Promise<IssuedGrant>
  /**
   * docs/specs/10 "Terminal Session/Workstream cleanup deletes it after revocation". Idempotent on
   * the Broker side (revoking an already-revoked or absent grant is a no-op success), so callers on
   * a terminal path may fire it without first checking whether a grant was ever issued.
   *
   * Found live, P11: nothing in this codebase ever called it, so every terminal Session left its
   * OneCLI Agent behind — 20 had accumulated on the real instance, one per Session, none reclaimed.
   */
  revoke(grantId: string, requestId: string): Promise<void>
  /**
   * Suspend's counterpart to `revoke`: gives the Session's OneCLI Agent up while leaving the grant
   * renewable, so `renew` can provision a new one under the same identifier when the Session comes
   * back. A dematerialised Runtime must not leave a standing Agent access token behind it.
   *
   * Idempotent on the Broker side (releasing an already-released or absent grant is a no-op
   * success), so a suspend may fire it without first checking anything.
   */
  release(grantId: string, requestId: string): Promise<void>
}

async function toDeniedError(response: Response, fallbackCode: string): Promise<BrokerGrantDeniedError> {
  const problem = (await response.json().catch(() => undefined)) as { code?: string; title?: string; detail?: string } | undefined
  const message = problem?.title ?? `broker request failed: HTTP ${response.status}`
  return new BrokerGrantDeniedError(response.status, problem?.code ?? fallbackCode, problem?.detail ? `${message}: ${problem.detail}` : message)
}

export function createHttpBrokerGrantClient(baseUrl: string): BrokerGrantClient {
  return {
    async issue(request: IssueGrantRequest): Promise<IssuedGrant> {
      let response: Response
      try {
        response = await fetch(new URL('/v1/execution-grants', baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-request-id': request.requestId },
          body: JSON.stringify({
            sessionId: request.sessionId,
            agentId: request.agentId,
            principalId: request.principalId,
            workstreamCategory: request.workstreamCategory,
            equipment: request.equipment,
          }),
        })
      } catch (error) {
        throw new BrokerGrantDeniedError(503, 'broker_unavailable', `could not reach Broker control API: ${String(error)}`)
      }
      if (!response.ok) throw await toDeniedError(response, 'broker_grant_issue_failed')
      return (await response.json()) as IssuedGrant
    },

    async renew(grantId: string, requestId: string): Promise<IssuedGrant> {
      let response: Response
      try {
        response = await fetch(new URL(`/v1/execution-grants/${encodeURIComponent(grantId)}/renew`, baseUrl), {
          method: 'POST',
          headers: { 'x-request-id': requestId },
        })
      } catch (error) {
        throw new BrokerGrantDeniedError(503, 'broker_unavailable', `could not reach Broker control API: ${String(error)}`)
      }
      if (!response.ok) throw await toDeniedError(response, 'broker_grant_renew_failed')
      return (await response.json()) as IssuedGrant
    },

    async revoke(grantId: string, requestId: string): Promise<void> {
      let response: Response
      try {
        response = await fetch(new URL(`/v1/execution-grants/${encodeURIComponent(grantId)}`, baseUrl), {
          method: 'DELETE',
          headers: { 'x-request-id': requestId },
        })
      } catch (error) {
        throw new BrokerGrantDeniedError(503, 'broker_unavailable', `could not reach Broker control API: ${String(error)}`)
      }
      if (!response.ok) throw await toDeniedError(response, 'broker_grant_revoke_failed')
    },

    async release(grantId: string, requestId: string): Promise<void> {
      let response: Response
      try {
        response = await fetch(new URL(`/v1/execution-grants/${encodeURIComponent(grantId)}/release`, baseUrl), {
          method: 'POST',
          headers: { 'x-request-id': requestId },
        })
      } catch (error) {
        throw new BrokerGrantDeniedError(503, 'broker_unavailable', `could not reach Broker control API: ${String(error)}`)
      }
      if (!response.ok) throw await toDeniedError(response, 'broker_grant_release_failed')
    },
  }
}
