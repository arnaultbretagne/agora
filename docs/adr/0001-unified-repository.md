# ADR 0001 — One repository, separate deployables

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

One Agora behavior may require coordinated changes to domain rules, machine-readable contracts,
shared implementation, deployed services, harness images and tests.

These elements must use the same vocabulary and evolve as one coherent change.

The processes that execute them do not have the same authority, deployment lifecycle or failure
boundary. A public-facing service, a control process and a harness runtime must not share privileges
merely because they implement the same product.

Repository boundaries and runtime boundaries therefore solve two different problems.

## Decision

Agora application code, harness code, reusable packages, machine-readable contracts and architecture
documentation are versioned in one repository.

The implementation layout is divided by responsibility. The current design baseline keeps only
its documentation and repository guidance; introduce these directories when a specified
implementation slice needs them, without restoring the retired implementation as a template:

```text
apps/
  independently deployable Agora services

harnesses/
  trusted harness integrations and independently built runtime images

packages/
  reusable in-process code with no deployment identity

contracts/
  machine-readable database, API, schema and policy boundaries

docs/
  architecture decisions and normative specifications
```

Each direct child of `apps/` or `harnesses/` produces an independently built deployable artifact.

A deployable may depend on shared packages, but it must not import another deployable. A package
must never depend on a deployable.

Running deployables communicate through explicit machine-readable contracts. Repository colocation
must never be used to bypass a service boundary.

Each deployable retains its own:

- build artifact;
- workload identity;
- configuration;
- privileges and data access;
- deployment lifecycle;
- scaling and failure boundary.

One repository allows the system to evolve coherently. It does not create one application process
or one trust zone.

## Why this choice

It provides both the source cohesion and runtime isolation the system requires:

- **Atomic evolution:** one change can update a model, its contracts, every affected implementation
  and its tests.
- **Shared vocabulary:** code, contracts, specifications and decisions describe the same system.
- **Repository-wide verification:** CI can validate dependency rules and cross-component contracts.
- **Runtime isolation:** every deployable receives only the authority required for its role.
- **Independent delivery:** deployables remain independently built, released and operated.

The central statement of this decision is:

> Code that must evolve together lives together; processes that must be isolated remain isolated.

## Options considered

### 1. One repository per deployable

This gives every runtime boundary a corresponding source boundary, but forces one product change
through several repositories, releases and contract versions.

It increases coordination without providing runtime isolation. Runtime isolation comes from
separate artifacts, identities and permissions, not from separate Git repositories.

### 2. One application process

This makes internal code sharing simple, but collapses deployment, scaling, failure and privilege
boundaries.

A process handling product requests must not gain infrastructure or execution authority merely
because another part of the product requires it.

### 3. Shared packages published across separate repositories

Published packages can reduce duplicated types, but they do not keep implementations, contracts,
specifications and tests within one coherent change.

They also add package publication and version ordering to the coordination already required between
deployables.

### 4. One universal artifact started in different modes

Separate processes could be started from the same artifact, but every process would carry code and
dependencies intended for other, potentially more privileged roles.

Distinct artifacts keep deployed contents aligned with each component's responsibility.

## Consequences

- A single change may span several deployables, packages and contracts.
- CI must enforce dependency direction and prevent imports between deployables.
- Cross-deployable behavior must be tested through contracts, not shared implementation details.
- Build and deployment pipelines still produce and release several artifacts.
- Contract changes must account for rolling deployments where different artifact versions coexist.
- Adding code to the repository never grants it another deployable's identity, data or permissions.

## Governing specs

- [Execution owners and isolation](../specs/reconciliation/execution.md#owners-and-isolation)
