# S6 — Runtime control on Kubernetes

- **Status:** planned
- **Depends on:** S3, S5
- **Produces:** `apps/runtime-control`, `contracts/api/runtime-control.openapi.yaml`, `packages/observation` (power/construction/session from Kubernetes), Kubernetes manifests, a kind-based CI job
- **Master plan:** [S6](../master-plan.md#s6--runtime-control-on-kubernetes)

## Goal

The first real owner. Pods are materialized from reviewed definitions only; inventories are
exhaustive and include unresolved retirement obligations; the controlled launch seam gates the
established Pod until the Session exists; process evidence and image evidence feed the
Observation normalizers. BUILD and TURN_OFF get their Kubernetes parts.

## Read first

1. [ADR 0007](../adr/0007-kubernetes-runtime.md) in full, [ADR 0006](../adr/0006-complete-harness-images.md)
2. [execution](../specs/reconciliation/execution.md): *Owners and isolation*, *Session birth and admission*, *Shutdown and physical extinction*, *Harness and owner conformance* (Launch and identity row)
3. [002 observation](../specs/reconciliation/002_observation.md): `observation.power`, `observation.construction`, `observation.session`
4. [003 verbs](../specs/reconciliation/003_verbs.md): BUILD, TURN_OFF; [005 CONSTRUCTION](../specs/reconciliation/005_construction.md); [007 SESSION](../specs/reconciliation/007_session.md) (`pending`/`unusable` semantics)
5. [engine: Watches and recovery sweeps](../specs/reconciliation/engine.md#watches-and-recovery-sweeps)
6. [acceptance: `OFF-003, 005, 006`, `SESSION-A06`, `ENGINE-012`](../specs/reconciliation/acceptance.md)
7. Field findings [§4 Kubernetes and network](../field-findings.md#4-kubernetes-and-network-slice-s6) **in full**, [§3.3](../field-findings.md#33-relay-identity), [§7](../field-findings.md#7-reuse-register)

## Before coding

- **P6, fencing and termination evidence.** Write into `execution.md` (*Shutdown and physical
  extinction*) what this implementation accepts as proof that a Pod's process stopped: a Pod
  observed `Succeeded`/`Failed` with all containers terminated, or a force-deleted Pod whose node
  is Ready and reports the Pod gone via the kubelet, or explicit infrastructure fencing (node drained
  and cordoned by the operator). State plainly that a partitioned node leaves the obligation
  unresolved and `off` unrealized. Get it reviewed.
- **P7, deadlines (first values).** Startup deadline, termination grace, inventory freshness
  window. Put them in a `contracts/catalogue/runtime-settings.json` with the note that S11 pins them
  after the conformance suite proves them.
- Namespace and identity: one namespace for Pods, one ServiceAccount per deployable, runtime-control
  has `pods` create/get/list/watch/delete and nothing else. Pods get no ServiceAccount token.

## Deliverables

```text
contracts/api/runtime-control.openapi.yaml    owner API (below), Problem responses with the Kubernetes Status.message in detail
contracts/catalogue/runtime-settings.json
contracts/catalogue/harness-definitions.json  minimal: harness_id → image digest, launch command, mounts (full definition in S8)
apps/runtime-control/
  src/k8s/client.ts             minimal REST client: get/list/watch(resourceVersion)/create/delete Pods; relist on 410 Gone
  src/k8s/pod-spec.ts           deterministic PodSpec from the reviewed definition only
  src/k8s/labels.ts             agora.dev/workstream, agora.dev/attempt-key, agora.dev/incarnation
  src/inventory.ts              every Pod for a Workstream regardless of phase + retirement obligations
  src/retirement.ts             obligations table; discharge only on termination evidence or fencing per P6
  src/launch-seam.ts            gate: Pod established → wait for Session birth confirmation → start harness (S8 fills the harness part)
  src/evidence.ts               process generation, container image ID, admitted spec digest
  src/owner-api.ts              OwnerServer (packages/owner-requests) + inventory endpoints
  src/watch.ts                  Pod watch → wake events to the control plane; relist + bounded sweep
  image/Dockerfile
deploy/
  namespace.yaml, rbac/, network-policies/, runtime-control.yaml   (Kustomize base)
packages/observation/
  src/power.ts                  Kubernetes contribution (Pods + obligations); Agents/bindings arrive in S7
  src/construction.ts           coherence: one non-retiring Pod on digest D; ⊥ cases; Pending is coherent
  src/session.ts                pending / openable / unusable from Pod status + launch-seam evidence
packages/testkit/src/fake-owners/runtime-control.ts   now conformant with the real API shape
.github/workflows/ci.yml        job "kubernetes" on a kind cluster
```

## Work plan

### Step 1 — Kubernetes client and PodSpec

Carry `k8s-client.ts` (in-cluster token/CA, `describeK8sError` keeping `Status.message`; findings
§4) and `pod-spec.ts`/`labels.ts` over; add watch with `resourceVersion`, relist on `410`, and
remove polling-only assumptions. The PodSpec is built from the reviewed definition and trusted inputs
only: image by digest, fixed command, `runAsNonRoot` with **numeric** `runAsUser`, no ServiceAccount
token (`automountServiceAccountToken: false`), resource limits, `runtimeClassName` from settings,
read-only root where the harness allows, fixed mounts for relay endpoint/CA/stubs (values arrive in
S7). No request field may name an image, argv, env or PodSpec fragment.

Acceptance: PodSpec golden test; a request carrying an image is rejected 422; `describeK8sError`
test.

### Step 2 — Owner API

| Method | Path | Semantics |
|---|---|---|
| `GET` | `/v1/workstreams/{id}/inventory` | every Pod (any phase) with UID, phase, container states, image IDs, admitted spec digest, labels; plus unresolved retirement obligations; `observed_at`, `resource_version`, `complete: boolean` |
| `POST` | `/v1/owner-requests` | owner request envelope (S5): `create_pod` (reserved target = attempt key; returns UID when known), `retire_pod` (concrete UID; records obligation and original deadline), `gate_release` (launch seam; requires Session id) |
| `GET` | `/v1/pods/{uid}/evidence` | process generation, image IDs, launch-seam state |
| `GET` | `/v1/wakes?cursor=` | wake stream for the engine (or server-sent events) |

An `inventory` that could not list completely returns `complete: false`; the normalizer then
produces no `off` value (POWER's existential `on` is still allowed from a positive footprint).

Acceptance: fake and real implementations pass the same contract test suite (findings §6.2).

### Step 3 — Inventory, obligations and observation normalizers

`observation.power` (Kubernetes part): `on` iff any Pod exists for the Workstream in any phase or
any obligation is unresolved; `off` requires a complete listing with none. `observation.construction`:
exactly one non-retiring Pod whose admitted digest (and, when Running, container image ID under the
manifest/platform mapping) resolves to a harness digest contributes it; duplicates, terminal,
retiring or unknown-image Pods contribute `⊥`. `observation.session`: `pending` while within the
startup deadline without a launched context; `openable` when Running and the launch seam reports
no live context bound; `unusable` on terminal phase, expired deadline or process loss.

Acceptance: table-driven tests over Pod states; `OFF-003` (Failed/expired Pod → `⊥` → cleanup
selected before any capability HOLD), `OFF-004` shape prepared (Kubernetes side only).

### Step 4 — Retirement and extinction

`retire_pod` records `(uid, workstream, original_deadline)` and deletes the Pod with the configured
grace. The obligation is discharged only by the P6 evidence. Force deletion or a NotReady node keeps
it; the inventory keeps reporting `on`. Restart never resets the deadline (persisted).

Acceptance: `OFF-005` (force-deleted Pod on a NotReady node: obligation retained, `power = on`,
successor build refused by CONSTRUCTION's `⊥`), `OFF-006` (API server unreachable: `complete:
false`, no `off`), `OFF-002` shape (restart after deletion continues from the persisted deadline).

### Step 5 — Launch seam and Session birth

`create_pod` reserves and creates a gated Pod (the harness container waits on the seam). When the
Pod is established, runtime-control reports the UID; the control plane opens the Session
(S3 `openSession`, idempotent by UID) and then requests `gate_release`. A Pod that never gets a
release is retired at the startup deadline (`unusable`). A process restart inside the Pod
invalidates the evidence: the seam reports a new generation and the incarnation is retired
([execution: hot boundaries](../specs/reconciliation/execution.md#hot-session-boundaries)).

Acceptance: `SESSION-A06` (process restart within the Pod → old evidence invalid, no silent reuse),
birth-then-release ordering test, `ENGINE-008` re-run with the real owner on kind.

### Step 6 — Watches and sweeps

Pod watch events become wakes; on cursor loss relist; a bounded periodic sweep lists all Pods and
obligations with Workstream labels and re-enqueues Workstreams absent from the workset.

Acceptance: `ENGINE-012` with a real Pod deleted out of band.

### Step 7 — Manifests, isolation and CI

Kustomize base: namespace, ServiceAccounts, RBAC (runtime-control: Pods only), default-deny
NetworkPolicy for harness Pods with explicit egress to the bridge listener, the Broker relay
(placeholder Service in S6) and DNS; runtime-control egress to the API server on **6443** (findings
§4). CI: a `kind` job that applies the base, runs the owner conformance tests and the `OFF-*`
scenarios above against the real API. Verify policies with real Pod-to-Pod traffic, never through
port-forward (findings §4).

## Reuse

Allowed (findings §7): `k8s-client.ts`, `pod-spec.ts`, `labels.ts`, `live-verification` manifests
as a starting point. Forbidden: archived `reconciler.ts` and `server.ts` (materialize/dematerialize
lifecycle), restore credential in the PodSpec (custody transport is redesigned in S9).

## Definition of done

- [ ] Owner API contract; fake and real owners pass the same suite.
- [ ] Normalizers for `power`, `construction`, `session` (Kubernetes part) with table tests.
- [ ] Retirement obligations with P6 evidence rules recorded in `execution.md`.
- [ ] Named scenarios on kind: `OFF-003, 005, 006`, `SESSION-A06`, `ENGINE-008, 012`.
- [ ] Manifests with default-deny policy; CI kind job green.
- [ ] Master plan S6 marked done; P6 and first P7 values recorded.

## Report

State the Kubernetes version tested, the P6 evidence accepted, which scenarios ran on kind versus
on the fake, and any Cilium/CNI-specific caveat (kind uses kindnet: NetworkPolicy enforcement
needs a CNI that enforces it; say which one CI installs).
