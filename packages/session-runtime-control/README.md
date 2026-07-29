# `@agora/session-runtime-control`

Typed client and server bindings for `contracts/openapi/session-runtime-control.yaml`. The contract
exposes one singleton runtime subresource under each Session and accepts no arbitrary process
specification or runtime identity.

Materialization consumes an opaque execution-grant reference but never accepts or returns OneCLI
control/upstream or provider credentials.

Implementation is governed by `plans/04-session-runtime-controller.md`.
