# Implementation plans

These plans are executable work packages for coding agents. Each plan has a bounded scope, explicit
dependencies, required reading, deliverables, acceptance tests and non-goals.

No implementation starts until the operator reviews the baseline and accepts the Proposed ADRs on
which that plan depends.

## Dependency graph

```text
P01 Domain/contracts
 ├── P02 Postgres store
 │    ├── P03 ACP coordinator
 │    │    └── P05 Web/projections
 │    └── P06 Custody/resume ◄── P04 Loge controller
 │          └── P07 Cross-Agent handoff ◄── P03/P05
 ├── P04 Loge controller
 └── P08 Equipment/Broker
      ├── P09 Claude Agent ◄── P04/P06
      └── P10 Codex Agent  ◄── P04/P06

P11 Hardening/cutover ◄── P05/P07/P08/P09/P10
```

## Plans

| ID | File | Start gate |
|---|---|---|
| P00 | [Program](00-program.md) | baseline review |
| P01 | [Domain and contracts](01-domain-and-contracts.md) | baseline review |
| P02 | [Postgres store](02-postgres-store.md) | P01 |
| P03 | [ACP Session coordinator](03-acp-session-coordinator.md) | P01, P02 |
| P04 | [Loge controller](04-loge-controller.md) | P01, ADR 0006 accepted |
| P05 | [Web and projections](05-web-and-projections.md) | P02, P03 |
| P06 | [Custody and resume](06-custody-and-resume.md) | P02, P03, P04 |
| P07 | [Cross-Agent handoff](07-cross-agent-handoff.md) | P03, P05, P06 |
| P08 | [Equipment and Broker](08-equipment-and-broker.md) | P01, ADR 0010 and 0014 accepted |
| P09 | [Claude Agent](09-claude-agent.md) | P04, P06, P08 |
| P10 | [Codex Agent](10-codex-agent.md) | P04, P06, P08 |
| P11 | [Hardening and cutover](11-hardening-and-cutover.md) | all vertical slices |

`manifest.json` is the machine-readable dependency/status view.

## Agent workflow

1. Claim one ready plan.
2. Read all required specs/ADRs in the plan.
3. Confirm dependencies are merged.
4. Update plan status from `pending` to `in_progress`.
5. Implement only its scope.
6. Add required contract, invariant and failure tests.
7. Run `npm test` and plan-specific integration tests.
8. Update the checklist and evidence links.
9. Mark complete only when every exit criterion is true.

Agents do not edit architecture to make their implementation easier. Ambiguity is returned as a
proposed spec/ADR change.
