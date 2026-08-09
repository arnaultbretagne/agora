# Implementation plans

These plans are executable work packages for coding agents. Each plan has a bounded scope, explicit
dependencies, required reading, deliverables, acceptance tests and non-goals.

The operator accepted the consolidated baseline, including the OneCLI orientation, on 2026-07-29.
P01 is ready to start; later plans remain dependency-gated.

## Dependency graph

```text
P01 Domain/contracts
 ├── P02 Postgres store
 │    ├── P03 ACP coordinator
 │    │    └── P05 Web/projections
 │    └── P06 Custody/resume ◄── P04 Session Runtime controller
 │          └── P07 Cross-Agent handoff ◄── P03/P05
 └── P04 Session Runtime controller
      └── P08 OneCLI-backed Broker
           ├── P09 Claude Agent ◄── P06
           └── P10 Codex Agent  ◄── P06

P11 Hardening/cutover ◄── P05/P07/P08/P09/P10
P12 Session config/titles ◄── P03/P05/P08/P09/P10
P13 OneCLI egress/grants ◄── P08/P11
```

## Plans

| ID | File | Start gate |
|---|---|---|
| P00 | [Program](00-program.md) | accepted baseline |
| P01 | [Domain and contracts](01-domain-and-contracts.md) | ready |
| P02 | [Postgres store](02-postgres-store.md) | P01 |
| P03 | [ACP Session coordinator](03-acp-session-coordinator.md) | P01, P02 |
| P04 | [Session Runtime controller](04-session-runtime-controller.md) | P01 |
| P05 | [Web and projections](05-web-and-projections.md) | P02, P03 |
| P06 | [Custody and resume](06-custody-and-resume.md) | P02, P03, P04 |
| P07 | [Cross-Agent handoff](07-cross-agent-handoff.md) | P03, P05, P06 |
| P08 | [OneCLI-backed Broker](08-equipment-and-broker.md) | P01, P04 |
| P09 | [Claude Agent](09-claude-agent.md) | P04, P06, P08 |
| P10 | [Codex Agent](10-codex-agent.md) | P04, P06, P08 |
| P11 | [Hardening and cutover](11-hardening-and-cutover.md) | all vertical slices |
| P12 | [Session configuration and titles](12-session-configuration-and-titles.md) | P03, P05, P08, P09, P10 |
| P13 | [OneCLI egress and grants](13-onecli-egress-relay-and-grants.md) | P08, P11 |

`manifest.json` is the machine-readable dependency/status view.

## Credential-gateway rule

OneCLI is the sole MITM, provider-secret store and injection gateway. Plans may implement its
control adapter, workload-authenticated opaque relay, policy mapping and deployment hardening. They
MUST NOT add a second credential gateway or port the former MITM/provider-adapter code.

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
