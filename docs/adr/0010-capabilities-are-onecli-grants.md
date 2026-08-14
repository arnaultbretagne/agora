# ADR 0010 — Capabilities compile to exact OneCLI grants

- **Status:** Accepted
- **Date:** 2026-08-13

## Context

Agora needs to express what external actions an execution may perform without exposing provider
credentials, OneCLI identifiers or vendor scopes as product vocabulary.

Named profiles would encode combinations that multiply as capabilities are added. Per-harness tool
availability would recreate a compatibility matrix even though every harness already contains the
same complete tool bundle.

Skills, personas and MCP configuration can guide behavior but cannot securely authorize a hostile
process.

## Decision

An Intent contains a flat set of named capabilities.

Each distinct right has its own capability name. Capabilities are not combined profiles,
`(resource, access-level)` pairs, raw provider scopes or OneCLI object identifiers.

A trusted, versioned policy compiler resolves the complete capability set into one exact desired
OneCLI grant set. The result names every required OneCLI secret or connection grant and its allowed
tools. Anything absent from that set must be ungranted.

The compiler emits only that OneCLI grant set. It emits no image selection, MCP registration or
independent relay policy; relay confinement is mechanically derived from the effective grants under
ADR 0009. Tool installation, registration and executable availability do not vary with the
capability set: the same complete tool surface is already present for every harness. Availability
and discoverability never substitute for a OneCLI grant.

The compiler refuses an unknown capability or any capability without an exact OneCLI mapping. It
never guesses a broader grant and never falls back to another authorization path.

Before a Session performs work, reconciliation makes the OneCLI Agent's observed effective grant
set equal to the compiled set. The Session facts record the effective capability names, compiler
version and non-secret grant digest.

Changing the desired capability set creates a new complete Intent and, when realized, a new Session.
If OneCLI can reconcile the new grant set safely at runtime, the same Pod may be retained across that
Session boundary.

Personas and skills remain independent Intent fields. They are files and instructions, not
capabilities. Discovering, copying or self-installing a skill never changes the OneCLI grant set.

## Why this choice

Flat capabilities let product intent remain stable while OneCLI-specific grants evolve behind a
versioned compiler.

Compiling the whole set at once provides replacement semantics: stale grants are removed rather than
accumulated, and observed authority has one exact answer.

The central statement of this decision is:

> Everything is installed for every harness; a capability changes only the exact grants OneCLI
> makes effective.

## Options considered

### 1. Named combination profiles

Rejected because combinations multiply, hide independent rights and become difficult to diff.

### 2. Resource and access-level pairs

Rejected because they force every capability into one generic hierarchy. Distinct rights are clearer
as distinct flat capability names.

### 3. Browser-supplied provider scopes or OneCLI grants

Rejected because it exposes enforcement details and lets untrusted input request authority outside
the reviewed product vocabulary.

### 4. Install or expose tools only when granted

Rejected because it recreates image and harness combinations and mistakes software visibility for
authorization.

### 5. Let personas or skills grant tools

Rejected because files available to hostile code cannot provide an enforceable security boundary.

## Consequences

- The capability catalogue and compiler are versioned, reviewed policy artifacts.
- Adding a capability requires an exact OneCLI mapping. Adding a new supported tool is a separate
  common-bundle change governed by ADR 0006.
- Capability changes may be applied without a Pod rebuild, but realized changes always create a new
  Session boundary.
- Attempts to perform a privileged external operation without the corresponding effective OneCLI
  grant fail closed.
- Purely local software that requires no privileged external authority is part of the common bundle,
  not a capability.
- Exact schemas, compiler mappings, digests and transition barriers belong in normative specs.

## Governing specs

- [Capabilities and OneCLI](../specs/10-equipment-and-broker.md)
- [Security](../specs/11-security.md)
