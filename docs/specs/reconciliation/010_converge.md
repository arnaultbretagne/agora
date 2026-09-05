# 010 — `CONVERGE`

`CONVERGE` is the terminal rule. It is evaluated only when every preceding rule has passed, which
means each domain the current Intent covers — power, construction, session, sync, capabilities,
configuration — has been observed to match its desired value. It has nothing left to check and ends
the evaluation.

## Inputs

`CONVERGE` reads nothing.

## Rules

| Rule | Conditions | Result |
|---|---|---|
| `CONVERGE-001` | always | `CONVERGED` |

A single unconditional row is trivially mutually exclusive and exhaustive.

Placing convergence in a dedicated terminal rule keeps every domain rule's converged case a plain
`PASS` and makes the rule set extensible without churn: a new domain — skills, next — is inserted
before `CONVERGE`, which is renumbered to stay last, and no existing rule changes its result.

`CONVERGED` here means the complete Intent, as its fields are currently registered in
[`001`](001_intent.md), is realized. The engine then emits no successor tick; a later Intent, or an
observed drift surfaced by a watch, revives the work row and evaluation restarts at `POWER`.
