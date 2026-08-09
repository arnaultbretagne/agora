# Claude Code Agent definition

Trusted runtime definition and opaque custody driver for the selected Claude Code ACP adapter
(`@agentclientprotocol/claude-agent-acp`, `SPIKE.md`'s recommendation — no local ACP adapter).

`src/bridge-server.ts` is the container entrypoint `packages/agent-registry`'s `claude-code`
runtime definition names: spawns the real ACP adapter once at Pod startup (restore-before-ready),
then bridges the Session Runtime controller's WebSocket connection directly to its stdio.
`src/custody.ts` captures/restores the ONE native-state file that matters for `session/resume`
continuity (`SPIKE.md`'s own finding — never the rest of `$HOME/.claude`, which is global,
non-Session state). Max-subscription authentication uses the fixed Broker-relay/OneCLI path
exclusively (`apps/broker`), proven live in `SPIKE.md`.
