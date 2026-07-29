# P09 — Claude Code ACP Agent and custody validation

- **Status:** pending
- **Dependencies:** P04, P06, P08
- **Primary paths:** `agents/claude-code`, registry definitions, Loge image

## Required reading

- `docs/specs/04-acp-integration.md`
- `docs/specs/07-custody.md`
- `docs/specs/09-agent-registry.md`
- `docs/specs/11-security.md`

## Mandatory spike before implementation

Evaluate two independent selections:

- ACP semantics: test `@agentclientprotocol/claude-agent-acp` first; consider a minimal adapter only
  for an evidenced contract failure.
- authentication: integrate the P08-selected gateway path (OneCLI if its spike passed) without
  treating that gateway as the ACP adapter.

Do not choose from feature lists alone. Re-run the gates below on the actual Claude Max subscription
authentication available to the operator and the production ACP topology.

## Spike gates

- [ ] Long-lived Max/subscription credential works in a fresh isolated Loge.
- [ ] Authentication survives Pod replacement without placing a refresh/provider secret in custody.
- [ ] ACP `session/new`, prompt, cancel, close and `session/resume` work.
- [ ] Resume continues the same native context and emits no replay under `session/resume`.
- [ ] Messages, thoughts, plans, tools, permissions and usage map to stable ACP v1.
- [ ] MCP servers supplied by the Client work through Broker descriptors.
- [ ] Native state required for resume is identified without relying on product parsing.
- [ ] Capture while quiescent is consistent and restore is collision-safe.
- [ ] Credential paths are excluded from custody.
- [ ] Model/config choices are exposed as ACP config options/modes rather than CLI columns.

Write a spike report under `agents/claude-code/SPIKE.md` with commands, versions, observed files,
redacted evidence, failure cases and recommendation. If the chosen path violates an accepted ADR,
stop and propose a replacement ADR.

## Implementation after gate

- [ ] Pin adapter/package/image versions and digest.
- [ ] Add registry definition validated by JSON Schema.
- [ ] Implement custody driver with format/version and compatibility fixtures.
- [ ] Add Loge health/readiness integration.
- [ ] Wire Broker-backed inference/tool access as validated.
- [ ] Add full Session lifecycle and cross-Agent tests.
- [ ] Document upgrade/rollback and credential renewal.

## Non-goals

- No PTY title/model scraping.
- No Claude transcript endpoint in the controller.
- No Channel plugin.
- No assumption that Claude-specific IDs are Agora IDs.

## Exit criteria

- All spike gates and baseline acceptance scenarios pass in a production-like Loge.
- A Pod can be deleted and the same ACP Session resumed from opaque custody.
- No real credential appears in Pod files outside the explicitly approved auth mechanism, custody,
  product journal or logs.

## Evidence

To be completed by the implementing agent.
