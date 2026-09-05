# Agora

Agora coordinates successive harness executions within a Workstream. A complete **Intent** says
what is wanted, fresh **Observation** reports what exists, a **Session** records one execution,
and the **Workstream** orders its facts. Reconciliation connects these four temporal concepts.

This branch is the design baseline for a new implementation. It contains the current decisions and
behavior contracts; executable code, old schemas, implementation plans and build tooling have been
retired. Their presence in Git history does not make them part of the new architecture.

## Read the design

1. Start with [ADR 0002](docs/adr/0002-workstream-session-model.md) for the model and
   [ADR 0003](docs/adr/0003-reconciliation-over-state.md) for reconciliation.
2. Read the [specification index](docs/specs/reconciliation/README.md), then the registries and
   ordered rules it lists.
3. Follow the supporting [engine](docs/specs/reconciliation/engine.md),
   [execution](docs/specs/reconciliation/execution.md) and
   [continuity](docs/specs/reconciliation/continuity.md) contracts as needed.
4. Use the [acceptance scenarios](docs/specs/reconciliation/acceptance.md) to assess concrete behavior.
   The [ADR index](docs/adr/index.md) supplies the rationale for all ten active decisions.

```text
docs/
  AGENTS.md                reading and design instructions
  adr/                     active decisions and index
  specs/reconciliation/    taxonomies, rules and supporting contracts
AGENTS.md                  repository instructions
README.md                  this entry point
```

## What comes next

Specify and implement one behavior at a time, with aligned wire/storage contracts and evidence for
its acceptance scenarios. Introduce code, tests and tooling when that slice needs them under
[ADR 0001](docs/adr/0001-unified-repository.md). Concrete policies, schemas, integration support,
deadlines and workspace/fencing mechanisms are still prerequisites to resolve, not guarantees
provided by these documents. There is no runnable application or implementation test suite here.

## Recover the previous repository

The annotated tag [`archive/pre-design-cleanup-2026-09-05`](https://github.com/arnaultbretagne/agora/tree/archive/pre-design-cleanup-2026-09-05)
retains the complete tracked repository before cleanup, including the architecture-review commits.
Browse that tag for the old implementation, flat specifications and parked ADRs. To inspect it
locally without changing this branch:

```sh
git worktree add --detach ../agora-before-cleanup archive/pre-design-cleanup-2026-09-05
```

Git preserves committed files; it does not back up ignored or untracked local files. The cleanup
changes tracked content only. Historical documents are available for reference, not as implicit
contracts to restore during implementation.
