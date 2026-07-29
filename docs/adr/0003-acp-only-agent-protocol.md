# ADR 0003 — ACP v1 is the only semantic Agent protocol

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

A temporary authenticated cluster bridge may carry ACP between a remote Loge and control plane. It
may add transport behavior only and cannot create another semantic protocol.

ACP v2 requires a future ADR.

## Alternatives rejected

- **Adapt the old Channel frames to more Agents:** continues owning a partial protocol.
- **Normalize ACP into a local Agent protocol:** creates semantic drift and loses unknown updates.
- **Adopt ACP v2 draft immediately:** accepts uncontrolled breaking changes in the storage contract.
- **Drive TUIs through PTY scraping:** loses structured thoughts, tools, plans and permissions.

## Consequences

- Agent adapters can be changed without changing product semantics.
- The SDK is a pinned architectural dependency.
- Complete ACP envelopes must be preserved.
- Bridge implementation must be tested for transparent ordering/backpressure.

## Governing specs

- [ACP integration](../specs/04-acp-integration.md)
