# ADR 0003 — ACP v1 is the only semantic Agent protocol

> Parked on 2026-08-13 during the ADR remodel. This text is historical and no longer governs the
> active design; its relevant decisions are consolidated in [ADR 0004](../0004-acp-boundary-and-session-facts.md).

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

The previous Channel protocol exposed only a small final-message surface and required
harness-specific plugins, custom acknowledgements and lifecycle inference. ACP already standardizes
Sessions, prompts, updates, tools, plans, permissions, modes and resume across Agents.

ACP remote transports and v2 continue to evolve.

## Decision

Agora is an ACP Client using the official stable v1 TypeScript SDK. Agent interaction uses unmodified
ACP methods and types.

A temporary authenticated cluster bridge may carry ACP between a remote Session Runtime and control
plane. It may add transport behavior only and cannot create another semantic protocol.

OneCLI is orthogonal to ACP. It supplies network credential injection below the harness, while the
Agent image supplies the ACP adapter and harness. OneCLI configuration MUST NOT alter, wrap or
normalize ACP envelopes.

ACP v2 requires a future ADR.

## Alternatives rejected

- **Adapt the old Channel frames to more Agents:** continues owning a partial protocol.
- **Normalize ACP into a local Agent protocol:** creates semantic drift and loses unknown updates.
- **Adopt ACP v2 draft immediately:** accepts uncontrolled breaking changes in the storage contract.
- **Drive TUIs through PTY scraping:** loses structured thoughts, tools, plans and permissions.
- **Treat `onecli run` as the production Agent protocol:** confuses a local process wrapper with ACP
  Session semantics and risks passing OneCLI control credentials to the harness.

## Consequences

- Agent adapters can be changed without changing product semantics.
- The SDK is a pinned architectural dependency.
- Complete ACP envelopes must be preserved.
- Bridge implementation must be tested for transparent ordering/backpressure.
- P09/P10 test ACP semantics and the already-selected OneCLI credential path as independent axes.

## Governing specs

- [ACP integration](../../specs/04-acp-integration.md)
