# ADR 0002 — Workstream and ACP Session are the domain model

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

`Conversation`, `Run`, native Session, runtime process and Loge described overlapping grains. A
single native Agent context could span several Runs while a Loge could serve several Runs, making
identity, resume and audit indirect.

Not every Agent invocation is conversational, while every product operation still requires a durable
business home.

## Decision

- `Workstream` is the non-null aggregate shown by the product.
- Its category is exactly `discussion` or `invocation`.
- `Session` is one ACP execution context belonging to one Workstream and one Agent.
- There is no Run entity.
- A Session has an Agora ID and an Agent-assigned ACP Session ID because ACP assigns the latter after
  provisioning.
- A Session receives one dedicated OneCLI Agent authorization principal. That principal is
  operational Broker state, is never shared with another Session and is not another Agora entity.
- ACP prompt turn is used as the protocol's own interaction term.

An invocation has one user-purpose prompt turn in v1. A discussion may have many.

## Alternatives rejected

- **Keep Conversation and add invocation records:** duplicates a shared aggregate.
- **Keep Run as an attempt:** creates multiple identities for one resumable context.
- **Call the Workstream an ACP thread:** ACP has no such core aggregate and a Workstream spans
  Sessions.
- **Use only the ACP Session ID:** it is unavailable until after the Loge and ACP connection exist.
- **Persist OneCLI Agent as another Session identity:** duplicates a one-to-one operational mapping
  and leaks an adopted component's data model into the product domain.

## Consequences

- Workstream continuity survives Agent switches.
- Failed provisioning remains an auditable Session fact.
- Fresh fallback always creates a new Session.
- Product and runtime APIs use the same Agora Session ID.
- OneCLI identifiers remain behind the Broker boundary and never replace `session_id` or
  `agent_id`.

## Governing specs

- [Glossary](../specs/00-glossary.md)
- [Domain model](../specs/02-domain-model.md)
