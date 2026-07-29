# P10 — Codex ACP Agent and custody validation

- **Status:** pending
- **Dependencies:** P04, P06, P08
- **Primary paths:** `agents/codex`, registry definitions, Loge image

## Required reading

- `docs/specs/04-acp-integration.md`
- `docs/specs/07-custody.md`
- `docs/specs/09-agent-registry.md`
- `docs/specs/11-security.md`

## Mandatory spike before implementation

Evaluate the official `@agentclientprotocol/codex-acp` distribution first. Separately integrate the
P08-selected credential gateway (OneCLI if its spike passed); it is not an ACP replacement. Record
exact versions, bundled Codex version and authentication paths. Replacing the official adapter
requires evidence of a contract failure; choosing it still requires the same empirical gates rather
than package provenance alone.

## Spike gates

- [ ] ChatGPT subscription authentication works non-interactively in an isolated Loge, or a safe
  operator bootstrap/renewal mechanism is specified.
- [ ] Credential-bearing authentication state is separated from resumable Session custody; any
  retained non-secret harness marker is identified and justified.
- [ ] ACP new/prompt/cancel/close/resume behavior is measured.
- [ ] Codex thread identity maps to one ACP Session without becoming a new Agora entity.
- [ ] Reasoning, plans, tools, permissions, web/image/subagent updates survive ACP v1 journaling.
- [ ] Client-provided MCP servers work through approved Broker descriptors.
- [ ] Required native resume files/state are identified and bounded.
- [ ] Custody capture/restore excludes credentials and survives Pod replacement.
- [ ] Model, reasoning, approval and sandbox controls are ACP modes/config options.

Write `agents/codex/SPIKE.md` with commands, versions, redacted evidence and recommendation.

## Implementation after gate

- [ ] Pin adapter/package/image versions and digest.
- [ ] Add validated registry definition.
- [ ] Implement versioned custody driver and fixtures.
- [ ] Add health/readiness integration.
- [ ] Wire approved Broker/tool access.
- [ ] Map namespaced Codex `_meta` without making it core schema.
- [ ] Add lifecycle, projection and A↔B handoff tests.
- [ ] Document upgrade/rollback and auth renewal.

## Non-goals

- No separate Thread aggregate.
- No Codex app-server protocol in the Agora core.
- No parsing of custody by product code.
- No automatic ACP v2 adoption.

## Exit criteria

- Full baseline acceptance passes in a production-like Loge.
- Same ACP Session resumes after Pod replacement.
- Codex-specific metadata remains inspectable without coupling generic projections to it.

## Evidence

To be completed by the implementing agent.
