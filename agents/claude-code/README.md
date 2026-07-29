# Claude Code Agent definition

Trusted runtime definition and opaque custody driver for the selected Claude Code ACP adapter.

The image bakes pinned Claude Code and ACP-adapter binaries. Max-subscription authentication uses the
fixed Broker-relay/OneCLI path; ACP and custody fidelity remain behind the validation gates in
`plans/09-claude-agent.md`.
