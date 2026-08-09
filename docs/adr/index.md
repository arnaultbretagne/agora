# Architecture Decision Record index

This is the only ADR index for Agora. The series was rewritten as a coherent baseline on
2026-07-29 after retiring the former Agora/agent-runtime architecture, then consolidated with the
accepted OneCLI spike result the same day.

ADRs record decisions and rationale. Current behavior is specified under `docs/specs/`.

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-unified-repository.md) | Accepted | One Agora monorepo, separate trust-zone deployables |
| [0002](0002-workstream-session-model.md) | Accepted | Workstream is the product aggregate; ACP Session is the execution unit |
| [0003](0003-acp-only-agent-protocol.md) | Accepted | Stable ACP v1 is the only semantic Agent protocol |
| [0004](0004-canonical-journal-and-projections.md) | Accepted | Full ACP envelopes form one canonical Workstream journal; UI models are projections |
| [0005](0005-session-runtime-identity.md) | Accepted | Session Runtime is the Session's infrastructure aspect, with at most one active Pod |
| [0006](0006-trusted-agent-registry.md) | Accepted | Trusted Agent registry pins harness-complete images and adapters |
| [0007](0007-opaque-custody.md) | Accepted | Versioned, opaque custody snapshots are stored separately from product meaning |
| [0008](0008-anchor-delta-handoffs.md) | Accepted | Per-Agent durable anchors drive delta handoffs across Sessions |
| [0009](0009-postgres-storage-boundaries.md) | Accepted | Postgres stores product facts, projections and opaque custody, not infrastructure logs |
| [0010](0010-capability-grants.md) | Accepted | Independent grants map one Session to one selective OneCLI Agent and bound relay (egress clause amended by 0015) |
| [0011](0011-security-trust-zones.md) | Accepted | Session Runtimes are untrusted; controller, Broker and product use separate identities (egress clause amended by 0015) |
| [0012](0012-state-authority-and-observability.md) | Accepted | Product, runtime and telemetry state keep distinct owners |
| [0013](0013-greenfield-replacement.md) | Accepted | Replace the old implementation with contract-first greenfield vertical slices |
| [0014](0014-adopt-credential-gateway.md) | Accepted | OneCLI is the only MITM, provider-secret store and credential-injection gateway (route-policy clause amended by 0015) |
| [0015](0015-onecli-credential-firewall-egress-at-relay.md) | Accepted | OneCLI is a credential firewall (per-Agent grants); Agora enforces network egress at the relay |

## Retired vocabulary

The new baseline deliberately removes `Conversation`, `Run`, `Loge`, harness `Thread` as a product
object, `native_session_id`, runtime `kind`, reusable runtime `group`, fixed `profile`, Channel and
Pipe. Git history before the baseline remains the historical source for those discarded decisions.

## Status policy

- `Proposed`: requires operator review before dependent implementation begins.
- `Accepted`: binding for implementation.
- `Superseded`: retained only if a later ADR replaces it.

Coding agents MUST NOT implement a plan depending on a Proposed ADR until it is accepted or the plan
explicitly limits itself to a reversible spike.
