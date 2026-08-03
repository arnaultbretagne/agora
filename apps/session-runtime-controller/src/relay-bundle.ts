/**
 * docs/specs/08 "The resulting Pod receives only a fixed credential-free Broker relay endpoint,
 * operator-managed OneCLI CA trust and non-secret harness auth stubs. The controller MUST NOT
 * receive or mount the OneCLI control key, dedicated Agent upstream bearer or provider credential."
 *
 * ADR 0014/P08 own the real Broker access relay and OneCLI CA. This plan's non-goal is explicit:
 * "No live OneCLI or capability-policy implementation; use a fake activation/relay contract for
 * P08" — this is that fixed, non-secret, fake-but-shape-correct bundle. P08 replaces the VALUES
 * (real CA, real relay DNS name) without changing where they are mounted or how the Pod refers to
 * them — that is the seam this plan promises the exit criteria ("P08 can replace the fake
 * activation/relay without changing Session Runtime lifecycle or accepting secret environment
 * values").
 */
export interface RelayBundle {
  /** Non-secret: the Broker access relay's fixed internal DNS name. Never a per-Session value. */
  readonly relayEndpoint: string
  /** Non-secret: operator-managed OneCLI CA trust bundle (PEM), fixed across all Sessions. */
  readonly oneCliCaPem: string
  /** Non-secret: `onecli-managed`/placeholder auth stubs (docs/specs/11 "cannot be used to recover upstream authority"). */
  readonly authStubs: Readonly<Record<string, string>>
}

const FAKE_CA_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
  'This is a placeholder, non-functional CA for P04 development only.',
  'P08 replaces this bundle with the real operator-managed OneCLI CA.',
  '-----END CERTIFICATE-----',
].join('\n')

/** The one fixed bundle every Session Runtime Pod receives — never Session-specific, never secret. */
export function fakeRelayBundle(): RelayBundle {
  return {
    relayEndpoint: 'https://broker-relay.agent.svc.cluster.local:8443',
    oneCliCaPem: FAKE_CA_PEM,
    authStubs: { 'onecli-managed': 'placeholder' },
  }
}
