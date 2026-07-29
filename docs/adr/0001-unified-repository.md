# ADR 0001 — One repository, separate deployables

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

The former split between Agora and `agent-runtime` put one Session lifecycle across two repositories,
two vocabularies and two ADR series. Product changes repeatedly required coordinated changes to Hub,
Manager, Supervisor, channel plugin, equipment projection and Broker.

Moving the Manager into Agora could remove that drift, but merging all processes into one service
would collapse security boundaries.

## Decision

Agora is one TypeScript monorepo containing Web, control plane, Loge controller, Broker, shared
packages and Agent definitions.

These remain separate deployables with:

- independent images;
- independent workload identities;
- least-privilege RBAC/database roles;
- explicit machine-readable contracts.

Repository colocation is a delivery decision, not a runtime trust decision.

Self-hosted OneCLI is an adopted infrastructure dependency, not code Agora reimplements. Agora owns
the Broker control adapter, policy mapping and workload-authentication relay in this repository;
OneCLI runs from a pinned upstream image with its own persistence and identity.

## Alternatives rejected

- **Keep separate repositories:** preserves the contract/version skew that caused the redesign.
- **One application process:** gives product code Kubernetes and provider-secret authority.
- **Shared internal library published across repos:** reduces type drift but not lifecycle/ADR drift.

## Consequences

- One change can update model, controller and contracts atomically.
- CI can run end-to-end contract tests.
- Deployment pipelines must still build and release multiple artifacts.
- Package boundaries and import rules must prevent accidental privilege coupling.
- Deployment manifests pin and operate OneCLI independently from Agora-built images.

## Governing specs

- [System architecture](../specs/01-system-architecture.md)
- [Security](../specs/11-security.md)
