# HTTP contracts

- `product-api.yaml`: authenticated Browser/product surface.
- `session-runtime-control.yaml`: internal Session Runtime lifecycle surface.
- `broker-control.yaml`: internal policy and execution-grant surface.

ACP is not repeated here. The control plane and Agents use stable ACP v1 from the pinned official
SDK.

Generated clients/servers MUST preserve the separation between public bearer authentication and
internal workload/mTLS authentication. `writeOnly` grant/tunnel fields must be redacted from logs and
serialization outside their immediate consumer.

OneCLI control keys, dedicated Agent upstream bearers and provider credentials are private
implementation state behind `broker-control.yaml` and MUST NOT be added to these contracts.
