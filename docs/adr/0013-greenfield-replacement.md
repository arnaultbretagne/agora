# ADR 0013 — Contract-first greenfield replacement

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

The previous codebase encoded the rejected concepts in its central modules and tests: Channel, Hub,
Conversation, Run, shared/reused Loge, native transcript endpoints and combined profiles.

An in-place refactor would require long-lived hybrid states and compatibility abstractions for a
model intentionally discarded.

## Decision

The tracked Agora tree is replaced with a fresh contract-first monorepo while Git history remains
recoverable.

Implementation proceeds through independently testable vertical slices. Security-proven mechanisms
from `agent-runtime` are ported selectively only after adopt-before-build gates; its
Manager/Supervisor architecture is not copied as the new core.

No production code is written before the governing spec, machine-readable contract and plan exist.

## Alternatives rejected

- **Incrementally rename/refactor old modules:** preserves false boundaries and dual models.
- **Big-bang rewrite without contracts:** exchanges architectural debt for undocumented behavior.
- **Fork a second permanent v2 repository:** recreates repository/decision drift.
- **Copy all agent-runtime code first:** imports the group/profile/transcript assumptions being
  removed.

## Consequences

- Old code remains available only through Git history and the independent repository during
  migration.
- Port decisions are made file/behavior by file/behavior.
- Cutover requires an explicit legacy-data policy.
- Plans and acceptance tests become the implementation coordination mechanism.

## Governing specs

- [Acceptance and migration](../specs/15-acceptance-and-migration.md)
- [Implementation program](../../plans/00-program.md)
