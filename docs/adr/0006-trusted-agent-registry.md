# ADR 0006 — Trusted Agent registry and harness adapters

- **Status:** Proposed
- **Date:** 2026-07-29

## Context

The Loge controller must launch Claude Code, Codex and future Agents without accepting arbitrary
commands from the product. It also needs harness-specific custody behavior without teaching the
product core native file formats.

## Decision

A trusted, versioned Agent registry maps `agent_id` to an immutable image digest, static ACP command,
custody driver, supported formats and rollout metadata.

Agent packages own ACP adapter selection and custody interpretation. Runtime ACP capability
negotiation remains authoritative over dynamic features.

Sessions pin the resolved registry-definition version.

## Alternatives rejected

- **Arbitrary command/image in materialize requests:** creates remote code execution through the
  product plane.
- **One generic adapter descriptor with scripts from configuration:** moves arbitrary execution into
  configuration.
- **Hard-code Claude/Codex branches in the controller:** couples lifecycle code to harness details.
- **Let the Browser install Agents:** violates the trust boundary.

## Consequences

- Adding/upgrading an Agent is an operator-reviewed registry change.
- Public UI receives only a safe registry projection.
- Custody compatibility is explicit and testable.
- Retirement must account for retained Sessions.

## Governing specs

- [Agent registry](../specs/09-agent-registry.md)
