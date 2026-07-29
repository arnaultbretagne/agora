# P09 — Claude Code ACP Agent and custody validation

- **Status:** pending
- **Dependencies:** P04, P06, P08
- **Primary paths:** `agents/claude-code`, registry definitions, Agent image

## Required reading

- `docs/specs/04-acp-integration.md`
- `docs/specs/07-custody.md`
- `docs/specs/09-agent-registry.md`
- `docs/specs/11-security.md`
- `apps/broker/ONECLI-SPIKE.md`
- ADR 0006, 0014

## Mandatory ACP/custody spike before implementation

The credential gateway selection is closed: use the P08 OneCLI control/relay path. The direct
`onecli run -- claude` Max-auth gate already passed and is evidence, not the production launcher.

For ACP semantics, test `@agentclientprotocol/claude-agent-acp` first; consider a minimal adapter only
for an evidenced contract failure. Integrate it with the fixed OneCLI path without treating OneCLI
as the ACP adapter.

Do not choose from feature lists alone. Re-run the gates below on the actual Claude Max subscription
authentication available to the operator and the production ACP topology.

## Spike gates

- [ ] Long-lived Max/subscription credential works through ACP and the workload relay in a fresh
  isolated Session Runtime. Direct harness auth is already proven by P08.
- [ ] Authentication survives Pod replacement without placing a refresh/provider secret in custody.
- [ ] ACP `session/new`, prompt, cancel, close and `session/resume` work.
- [ ] Resume continues the same native context and emits no replay under `session/resume`.
- [ ] Messages, thoughts, plans, tools, permissions and usage map to stable ACP v1.
- [ ] MCP servers supplied by the Client work through Broker descriptors.
- [ ] Native state required for resume is identified without relying on product parsing.
- [ ] Capture while quiescent is consistent and restore is collision-safe.
- [ ] Credential paths are excluded from custody.
- [ ] Model/config choices are exposed as ACP config options/modes rather than CLI columns.
- [ ] The image already contains pinned Claude Code and ACP-adapter executables; startup performs no
  package install.
- [ ] The Agent Pod contains only relay endpoint, OneCLI CA and non-secret Claude auth stub—not
  OneCLI control/upstream or Anthropic credentials.
- [ ] Required Claude/Anthropic hosts are captured as a reviewed OneCLI route-set fixture.

Write a spike report under `agents/claude-code/SPIKE.md` with commands, versions, observed files,
redacted evidence, failure cases and recommendation. If the chosen path violates an accepted ADR,
stop and propose a replacement ADR.

## Implementation after gate

- [ ] Pin adapter/package/image versions and digest.
- [ ] Add registry definition validated by JSON Schema.
- [ ] Implement custody driver with format/version and compatibility fixtures.
- [ ] Add Session Runtime health/readiness integration.
- [ ] Wire inference/tool traffic through the Broker relay and OneCLI only.
- [ ] Add full Session lifecycle and cross-Agent tests.
- [ ] Document image/adapter/route-set upgrade, rollback and Max credential renewal.

## Non-goals

- No PTY title/model scraping.
- No Claude transcript endpoint in the controller.
- No Channel plugin.
- No assumption that Claude-specific IDs are Agora IDs.
- No `onecli run`, SDK control key or runtime package installation in the production Agent
  container.

## Exit criteria

- All spike gates and baseline acceptance scenarios pass in a production-like Session Runtime.
- A Pod can be deleted and the same ACP Session resumed from opaque custody.
- No real credential appears in the Pod environment/filesystem, custody, product journal or logs.
- The approved runtime auth stub is non-secret and contains no upstream OneCLI bearer.

## Evidence

To be completed by the implementing agent.
