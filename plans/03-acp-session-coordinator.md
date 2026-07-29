# P03 — ACP Session coordinator vertical slice

- **Status:** pending
- **Dependencies:** P01, P02
- **Primary paths:** `packages/acp`, `apps/control-plane`

## Required reading

- `docs/specs/03-session-lifecycle.md`
- `docs/specs/04-acp-integration.md`
- `docs/specs/13-failure-and-idempotency.md`
- ADR 0002, 0003, 0004

## Deliverables

- ACP Client host around the official stable SDK.
- Deterministic in-process fake ACP Agent.
- New Session bootstrap/binding.
- Single prompt turn with complete envelope journaling.
- Permission, filesystem, terminal and update handlers.
- Durable command dispatcher with explicit unknown-delivery behavior.
- Minimal internal API used later by the public HTTP layer.

## Tasks

- [ ] Establish initialize/new using a supplied duplex stream.
- [ ] Persist negotiated capabilities and bind Agent `sessionId` once.
- [ ] Journal every outbound/inbound envelope including `_meta`.
- [ ] Deduplicate replayed bridge frames by opaque transport observation ID without deduplicating
  legitimate identical ACP chunks.
- [ ] Correlate updates to one in-flight prompt command.
- [ ] Preserve thoughts, plans, tool calls and permission requests.
- [ ] Support cancel/close capability checks.
- [ ] Implement load-replay ingest tagging but do not use load for normal resume.
- [ ] Implement ACP mode/config methods without model-specific columns.
- [ ] Handle missing v1 message IDs in projection input metadata.
- [ ] Implement delivery-unknown terminal state without blind prompt retry.
- [ ] Reject credential-bearing MCP descriptors and prove OneCLI/relay configuration never enters an
  ACP envelope.

## Required tests

- Golden transcript for initialize/new/prompt/update/response.
- Unknown ACP `_meta` survives database and readback.
- Multiple message/tool chunks preserve order and IDs.
- Cancel still accepts final racing updates.
- Duplicate dispatcher wakeup does not send acknowledged prompt twice.
- Lost response to `session/new` fails closed without rebinding another ID.
- Invocation cardinality remains enforced at command acceptance.
- Complete `session/new`/`session/resume` envelopes journal safely without OneCLI bearer, control key
  or provider auth state.

## Non-goals

- No Kubernetes runtime; use supplied streams/fakes.
- No native custody.
- No cross-Agent handoff.
- No Browser UI.
- No OneCLI process launch; supplied streams and credential-free MCP descriptors only.

## Exit criteria

- One invocation runs end-to-end against the fake Agent and rebuilds the same projection.
- Protocol tests use official SDK types only.
- P05 and P06 have stable application interfaces.

## Evidence

To be completed by the implementing agent.
