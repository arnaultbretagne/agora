# P10 — Codex ACP Agent and custody validation

- **Status:** pending
- **Dependencies:** P04, P06, P08
- **Primary paths:** `agents/codex`, registry definitions, Agent image

## Required reading

- `docs/specs/04-acp-integration.md`
- `docs/specs/07-custody.md`
- `docs/specs/09-agent-registry.md`
- `docs/specs/11-security.md`
- `apps/broker/ONECLI-SPIKE.md`
- ADR 0006, 0014

## Mandatory ACP/custody spike before implementation

The credential gateway selection is closed: use the P08 OneCLI control/relay path. Direct
`onecli run -- codex` with the operator's ChatGPT OAuth state already passed and is evidence, not the
production launcher.

Evaluate the official `@agentclientprotocol/codex-acp` distribution first and integrate it with that
fixed path. Record exact adapter, bundled/pinned Codex and route-set versions. Replacing the official
adapter requires evidence of a contract failure; choosing it still requires empirical ACP/custody
gates rather than package provenance alone.

## Spike gates

- [ ] ChatGPT subscription authentication works through ACP and the workload relay in an isolated
  Session Runtime, with a safe operator bootstrap/renewal mechanism. Direct harness auth is proven
  by P08.
- [ ] Credential-bearing authentication state is separated from resumable Session custody; any
  retained non-secret harness marker is identified and justified.
- [ ] ACP new/prompt/cancel/close/resume behavior is measured.
- [ ] Codex thread identity maps to one ACP Session without becoming a new Agora entity.
- [ ] Reasoning, plans, tools, permissions, web/image/subagent updates survive ACP v1 journaling.
- [ ] Client-provided MCP servers work through approved Broker descriptors.
- [ ] Required native resume files/state are identified and bounded.
- [ ] Custody capture/restore excludes credentials and survives Pod replacement.
- [ ] Model, reasoning, approval and sandbox controls are ACP modes/config options.
- [ ] The image already contains pinned Codex and ACP-adapter executables; startup performs no
  package install.
- [ ] The Agent Pod contains only relay endpoint, OneCLI CA and read-only `onecli-managed` auth
  stub—not OneCLI control/upstream or OpenAI credentials.
- [ ] Required ChatGPT/OpenAI hosts are captured as a reviewed route-set fixture that excludes
  unnecessary analytics endpoints.

Write `agents/codex/SPIKE.md` with commands, versions, redacted evidence and recommendation.

## Implementation after gate

- [ ] Pin adapter/package/image versions and digest.
- [ ] Add validated registry definition.
- [ ] Implement versioned custody driver and fixtures.
- [ ] Add health/readiness integration.
- [ ] Wire inference/tool traffic through the Broker relay and OneCLI only.
- [ ] Map namespaced Codex `_meta` without making it core schema.
- [ ] Add lifecycle, projection and A↔B handoff tests.
- [ ] Document image/adapter/route-set upgrade, rollback and ChatGPT auth renewal.

## Non-goals

- No separate Thread aggregate.
- No Codex app-server protocol in the Agora core.
- No parsing of custody by product code.
- No automatic ACP v2 adoption.
- No `onecli run`, SDK control key or runtime package installation in the production Agent
  container.

## Exit criteria

- Full baseline acceptance passes in a production-like Session Runtime.
- Same ACP Session resumes after Pod replacement.
- Codex-specific metadata remains inspectable without coupling generic projections to it.
- No upstream OneCLI bearer or OpenAI credential is readable from the Agent container.

## Evidence

To be completed by the implementing agent.
