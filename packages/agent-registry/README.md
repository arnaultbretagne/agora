# `@agora/agent-registry`

Trusted mapping from `agent_id` to immutable runtime image, ACP command, compatible custody formats
and rollout metadata. Images already contain pinned harness/ACP binaries; the exact definition
version selects a reviewed OneCLI route set. Definitions are operator-controlled and validated by
contract.

Implementation is governed by `plans/04-loge-controller.md`.
