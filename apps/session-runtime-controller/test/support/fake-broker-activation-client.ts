import { BrokerActivationDeniedError, type ActivationRequest, type ActivationResult, type BrokerActivationClient } from '../../src/broker-activation-client.js'

/**
 * In-memory double for the Broker's `/v1/execution-grant-activations` endpoint — deployables never
 * import each other, even in test code (test/support.ts's own doc comment), so this is what stands
 * in for the real Broker here (the real Broker's own HTTP behavior is exercised by
 * apps/broker/test/server.test.ts). Allows every call by default; `denyWithStatus` lets a single
 * test force the fail-closed path without touching any other test's materialize calls.
 */
export class FakeBrokerActivationClient implements BrokerActivationClient {
  readonly calls: ActivationRequest[] = []
  denyWithStatus: number | undefined

  async activate(request: ActivationRequest): Promise<ActivationResult> {
    this.calls.push(request)
    if (this.denyWithStatus !== undefined) {
      throw new BrokerActivationDeniedError(this.denyWithStatus, 'activation_denied', 'fake broker activation client: denied for this test')
    }
    return { activationId: crypto.randomUUID(), grantId: request.grantRef, expiresAt: new Date(Date.now() + 60_000).toISOString() }
  }
}
