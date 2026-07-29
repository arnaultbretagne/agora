# `@agora/runtime-control`

Typed client and server bindings for `contracts/openapi/loge-control.yaml`. The contract speaks in
Session IDs and Loges and accepts no arbitrary process specification.

Materialization consumes an opaque execution-grant reference but never accepts or returns OneCLI
control/upstream or provider credentials.

Implementation is governed by `plans/04-loge-controller.md`.
