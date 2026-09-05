# 010 — `CONVERGE`

`CONVERGE` is the terminal rule. It is evaluated only when every preceding rule has passed, which
means each domain the current Intent covers — power, construction, capabilities, session,
configuration, sync — has been observed to match its desired value. It has nothing left to check and ends
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

Conditional finalization also completes the idempotent attribution/admission boundary from
[spec 03](../03-session-lifecycle.md). A new Pod already has its bootstrap Session; a realized hot
change opens its successor Session before further work. If ownership, Intent or target evidence
changed, neither finalization nor admission may complete. `CONVERGED` is never a stored permission
to execute after its supporting evidence expires.

The [engine](engine.md#conditional-finalization-and-admission) also checks unresolved owner requests.
A claim/Intent CAS alone cannot make a potentially late external effect safe.
