# Codex Agent definition

Trusted runtime definition and opaque custody driver for Codex through an ACP adapter.

The image bakes pinned Codex and ACP-adapter binaries. ChatGPT authentication uses the fixed
Broker-relay/OneCLI path; ACP adapter selection, resume fidelity and custody content are validated in
`plans/10-codex-agent.md`.
