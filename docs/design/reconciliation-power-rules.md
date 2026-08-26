# Working design — `POWER` reconciliation rule

> **Status:** Working design draft — non-normative. This document exists to adjust the first
> ordered reconciliation rule before it enters the normative reconciliation specification.

## Scope

```text
Intent.power = on | off
```

`POWER` is the first Intent rule evaluated on every reconciliation pass. `on` and `off` are values
of that single rule, not separate evaluators and not start/stop commands.

`POWER` is asymmetric:

- `on` establishes one safe Kubernetes candidate, then evaluation continues with the next rule;
- `off` makes every later Intent field inapplicable and removes the complete live footprint.

## Evaluation

Rules are evaluated in one fixed order. `POWER` is always evaluated when the reconciler reaches
it; it is not selected by a `when` clause.

`POWER` returns exactly one result:

```text
NEXT
CONVERGED
ACT(verb, target)
WAIT(reason)
FAIL_CLOSED(reason)
```

`NEXT` is internal: `POWER` is satisfied and evaluation continues with the next ordered rule.
`WAIT` means another Observation or retry may unblock evaluation. `FAIL_CLOSED` means no safe rule
exists without a policy or operator decision; no work may proceed.

Claim validation is engine control flow, not a `POWER` result. Before evaluation and action
dispatch, the engine verifies the exact `(workstream_id, intent_seq, work_generation)` claim. A
stale claim restarts evaluation from the latest Intent.

One pass dispatches at most one action. It then re-observes and starts again from `POWER`.

## Reads

`POWER` reads `Intent.power` independently. An `off` Intent remains actionable even if another
Intent field can no longer be resolved. The complete Intent is resolved into a Pod specification
only when `CREATE_POD` is selected.

Current reality is read directly from its owner:

```text
Kubernetes  all Pods owned by workstream_id
OneCLI      all Agents owned by workstream_id and their effective grants
Broker      all relay bindings owned by workstream_id
Agora       prompt admission
Harness     work in flight and quiescence
Save store  committed Save metadata
PostgreSQL  current Anchor
```

Each read returns either a value, possibly an empty collection, or a failure. A failure, timeout or
stale result never means empty.

Pods, Agents and bindings must be exhaustively discoverable by stable Workstream ownership. Facts
from the latest Session are not an inventory of current resources.

The shutdown path may additionally read only these historical facts:

- Session-to-Pod attribution;
- realized harness definition;
- stable capture key and selected watermark;
- explicit authorization to accept context loss, if that policy is adopted.

They select and attribute actions; they never prove current existence.

## Actions

The proposed `POWER` action vocabulary is:

```text
CREATE_POD
BLOCK_PROMPTS
GATE_POD
QUIESCE
CAPTURE_SAVE
ADVANCE_ANCHOR
UNGRANT
UNBIND
REMOVE_AGENT
DELETE_POD
```

`BLOCK_PROMPTS` is owned by Agora admission. `GATE_POD` is owned by the Kubernetes runtime control
boundary. They remain separate because one action has one owner and one effect.

`UNGRANT` changes OneCLI authority. `UNBIND` removes the Broker relay binding; it cannot add
authority and therefore does not make the relay a grant authority.

Every action names one immutable target and defines one independently observable postcondition.
When several targets qualify, the next target is the lowest immutable authoritative ID. This
orders cleanup actions; it does not select a surviving Pod.

## Early guards

Ownership/trust conflicts and multiple Pods are evaluated before the nominal `on` or `off` path.
They currently have no complete policy.

Until that policy is agreed, `POWER` may only perform independently reducing containment actions:

```text
BLOCK_PROMPTS
GATE_POD
UNGRANT
UNBIND
REMOVE_AGENT
```

After known authority has been contained, `POWER` returns `FAIL_CLOSED`. It does not capture or
delete a conflicting Pod. The exact containment order and Pod disposition remain open below.

## Ordered `power = off` rule

For the nominal zero-or-one-Pod case, the following requirements are evaluated in this exact order.
The first unsatisfied requirement returns the stated action. A failed Observation required by the
current row returns `WAIT`.

| Order | Required condition | Result if unsatisfied |
|---:|---|---|
| 1 | New prompts are blocked. | `ACT(BLOCK_PROMPTS, workstream_id)` |
| 2 | The attributable Pod is gated, if one exists. | `ACT(GATE_POD, pod_uid)` |
| 3 | The attributable harness has no work in flight, if a controllable one exists. | `ACT(QUIESCE, pod_uid)` |
| 4 | A Session-bound live context that will be intentionally deleted has a committed Save at the selected watermark. | `ACT(CAPTURE_SAVE, session_id, pod_uid, capture_key, watermark)` |
| 5 | The Anchor covers that committed Save. | `ACT(ADVANCE_ANCHOR, anchor_key, save_id)` |
| 6 | No effective OneCLI grant remains. | `ACT(UNGRANT, agent_id, grant_id)` |
| 7 | No relay binding remains. | `ACT(UNBIND, binding_id)` |
| 8 | No OneCLI Agent remains. | `ACT(REMOVE_AGENT, agent_id)` |
| 9 | No attributable Pod remains. | `ACT(DELETE_POD, pod_uid, resource_version)` |

Once every preceding requirement is satisfied, `POWER` performs fresh exhaustive reads and returns
`CONVERGED` only when all four inventories are empty:

```text
Kubernetes Pods         = []
OneCLI Agents           = []
OneCLI effective grants = []
Broker relay bindings   = []
```

A missing Pod skips only the Pod, harness, Save and Anchor rows. It never skips authority cleanup.

Failure or inability to capture does not waive Save. Deletion without a new committed Save is
allowed only when fresh evidence proves the context was already irrecoverably lost or an explicit
loss policy authorizes it. The exact classification remains open.

No `off` Session is created. Extinction facts remain attributed to the Session being stopped when
one exists.

## Ordered `power = on` rule

The nominal path assumes zero or one Pod and no ownership conflict.

| Order | Required condition | Result if unsatisfied |
|---:|---|---|
| 1 | Kubernetes has been read successfully. | `WAIT(KUBERNETES_OBSERVATION)` |
| 2 | OneCLI and Broker have been read sufficiently to identify authority whose Pod is absent. | `WAIT(AUTHORITY_OBSERVATION)` |
| 3 | No effective grant belongs to an absent Pod. | `ACT(UNGRANT, agent_id, grant_id)` |
| 4 | No relay binding belongs to an absent Pod. | `ACT(UNBIND, binding_id)` |
| 5 | No OneCLI Agent belongs to an absent Pod. | `ACT(REMOVE_AGENT, agent_id)` |
| 6 | One attributable Pod exists. | `ACT(CREATE_POD, resolved_pod_specification)` |
| 7 | The sole Pod is not terminating. | `WAIT(POD_TERMINATING)` |
| 8 | The sole Pod has the expected Workstream ownership. | `FAIL_CLOSED(POD_OWNERSHIP)` after the early containment guard |

Once every preceding requirement is satisfied, `POWER` returns `NEXT`.

`CREATE_POD` creates a gated Pod. A successful create response is not proof of existence; the next
pass must observe it through Kubernetes. `NEXT` does not permit bootstrap or user work. Under ADR
0007, the immediate subsequent structural rule must open the Session before restore, ACP bootstrap
or harness work.

Exact grants, harness readiness and release of the Pod belong to later ordered rules.

## Invariants

- Stored lifecycle phases and Session facts never prove current reality.
- A successful empty read and a failed read are never interchangeable.
- An external action is followed by fresh Observation from the root.
- Controlled Pod deletion never bypasses required Save and Anchor work.
- No external authority survives `power = off` convergence.
- No second grant authority is introduced beside OneCLI.
- The relay binding is removed explicitly but cannot grant authority.
- Every action has one owner, one target, one effect and an observable postcondition.

## Open decisions

1. Exact containment order and Pod disposition for multiple Pods.
2. Exact containment and deletion policy for invalid ownership, workload identity or compromise.
3. Adoption or deletion of an Agora-created gated Pod without a Session after controller recovery.
4. Whether a Pod that never completed bootstrap contains context requiring a Save.
5. Evidence that distinguishes an irrecoverably lost context from a temporarily unreachable one.
6. Authorization, scope and lifetime of forced context loss after Save failure.
7. Whether a reducing action such as `UNGRANT` remains allowed when an unrelated Observation source
   is unavailable.
8. Treatment of a terminating Pod under `power = on`, including whether a successor may be created
   before the old Kubernetes object disappears once it is gated and deauthorized.
9. Audit location for reconciliation attempts occurring before any Session exists.
10. Exact next ordered rule after `POWER`, including the Session-opening action and contract.

## Architectural basis

[ADR 0002](../adr/0002-workstream-session-model.md),
[ADR 0003](../adr/0003-reconciliation-over-state.md),
[ADR 0007](../adr/0007-kubernetes-runtime.md),
[ADR 0008](../adr/0008-saves-anchors-and-refill.md),
[ADR 0009](../adr/0009-onecli-grant-authority.md), and
[ADR 0010](../adr/0010-capabilities-are-onecli-grants.md).
