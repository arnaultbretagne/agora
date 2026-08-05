/**
 * docs/specs/10-equipment-and-broker.md "Bind grant + session_id + agent_id + workload_identity
 * exactly once": the controller's own seam to the Broker's `POST /v1/execution-grant-activations`
 * (apps/broker/src/server.ts). Deployables never import each other, even in test code (see
 * test/support.ts) — this is the controller's OWN narrow HTTP client for that one Broker endpoint,
 * not a shared library. A materialize that cannot bind its grant MUST NOT create a Pod (fail
 * closed) — see server.ts's `handleMaterialize`.
 */
export interface ActivationRequest {
  readonly grantRef: string
  readonly sessionId: string
  readonly agentId: string
  readonly workloadIdentity: string
  readonly requestId: string
}

export interface ActivationResult {
  readonly activationId: string
  readonly grantId: string
  readonly expiresAt: string
}

export class BrokerActivationDeniedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BrokerActivationDeniedError'
  }
}

export interface BrokerActivationClient {
  activate(request: ActivationRequest): Promise<ActivationResult>
}

export function createHttpBrokerActivationClient(baseUrl: string): BrokerActivationClient {
  return {
    async activate(request: ActivationRequest): Promise<ActivationResult> {
      let response: Response
      try {
        response = await fetch(new URL('/v1/execution-grant-activations', baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-request-id': request.requestId },
          body: JSON.stringify({
            grantRef: request.grantRef,
            sessionId: request.sessionId,
            agentId: request.agentId,
            workloadIdentity: request.workloadIdentity,
          }),
        })
      } catch (error) {
        throw new BrokerActivationDeniedError(503, 'broker_unavailable', `could not reach Broker control API: ${String(error)}`)
      }
      if (!response.ok) {
        const problem = (await response.json().catch(() => undefined)) as { code?: string; title?: string } | undefined
        throw new BrokerActivationDeniedError(response.status, problem?.code ?? 'broker_activation_failed', problem?.title ?? `broker activation failed: HTTP ${response.status}`)
      }
      return (await response.json()) as ActivationResult
    },
  }
}
