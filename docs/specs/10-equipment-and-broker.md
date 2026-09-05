# Capabilities and OneCLI

This specification is aligned to ADRs [0009](../adr/0009-onecli-grant-authority.md) and
[0010](../adr/0010-capabilities-are-onecli-grants.md). It replaces the former equipment, independent
execution-grant and Session-bound OneCLI model. Historical filenames do not preserve that model.
Machine-readable contracts require a separate alignment before implementation.

## Ownership

| Concern | Owner |
|---|---|
| Reviewed named capabilities and exact desired grant compilation | Trusted Agora policy compiler |
| Attached grants, effective authority, provider credentials and request enforcement | OneCLI |
| Per-Pod OneCLI Agent lifecycle and control API access | Broker control |
| Workload authentication and opaque confinement of provider traffic | Broker relay |
| Pod creation, execution isolation and workload identity | Runtime controller |

The Browser selects named capabilities in a complete Intent. It supplies no provider scope, OneCLI
identifier, image, command, secret or relay policy. Personas, skills, software presence and MCP
registration add no authority.

## Compilation

The compiler consumes the complete capability set under one reviewed catalogue/compiler revision
and the authenticated principal's permitted bindings. It produces one exact non-secret desired
OneCLI grant set, or a typed denial. It emits no image, MCP registration or independent egress policy.

Every right, including model/provider invocation, has a reviewed named mapping. A missing required
mapping or selection is rejected when authoring an on Intent; harness/model selection adds no hidden
base grant. The empty set is valid where the reviewed execution needs no privileged external access.
The same common tool surface remains available to every harness.

The compiler MUST:

- resolve each secret/connection reference through trusted policy, never Browser input;
- include exact tools, approval requirements and enforceable restrictions;
- union shared rights across all selected capabilities before computing a difference;
- reject unknown capabilities and incompatible or unrepresentable combinations;
- reject an approval requirement the deployment cannot serve;
- bind its output and digest to the selected immutable policy revision;
- refuse a provider operation whose authority cannot be granted and revoked through OneCLI.

A revision is selected by trusted deployment policy, not by whichever worker happens to run.
Changing that revision wakes affected Workstreams; an old attempt cannot resolve a new payload
under the same idempotency key. Session facts record the revision and digest actually realized.

## Exact grant comparison

Let `D` be the compiled desired authorization set, `A` OneCLI's attached authorization set and `E`
its effective authorization set after external restrictions. Convergence requires `A = D ∧ E = D`.

An authorization comparison preserves:

- credential or connection identity and grant kind;
- each allowed tool or the exact scope of a secret grant;
- approval versus unconditional permission;
- all restrictions affecting when or where that permission applies.

This is a non-secret comparison model behind the policy boundary, not a replacement provider
protocol. Inclusion means inclusion of permitted requests under their prerequisites, not textual
inclusion of serialized grant objects: approval-required execution is a subset of unconditional
execution of the same tool, and a narrower resource restriction is a subset of the broader scope.
The pinned mapping must prove such inclusion; it cannot guess it for an unknown restriction.
Finite tool grants are compared as individual authorizations. A full-access grant is
expanded only against a complete, revision-bound OneCLI tool catalogue; otherwise it remains an
explicit broad entry and cannot compare equal to a reviewed finite subset. Restrictions are
canonicalized only when the pinned OneCLI contract proves equivalence. Unknown fields or entries
remain distinguishable and prevent equality; they are never silently discarded.

An observed scope whose inclusion in the reviewed desired set cannot be proved is conservatively
classified as excess, retaining its removable OneCLI entry identity. Desired compilation never
emits an unknown scope. If the owner cannot identify or remove the entry, access stays gated with
a diagnostic; uncertainty cannot make the grant table pass.

A denied permission contributes no usable authorization to `E`; its attachment stays in `A` and
its denial reason remains acquisition diagnostics. An approval requirement contributes its actual
restricted authorization, never an unconditional allow. Comparisons never infer effective access
from attachment, or attachment from effective access.

The normalized observations are registered in
[the Observation taxonomy](reconciliation/002_observation.md). A capability requiring two grants
with only one remaining therefore leaves that remaining grant visible. An unknown extra grant or
one masked by organization policy also remains visible.

## Reconciliation and unavailable authority

[CAPABILITIES](reconciliation/006_capabilities.md) owns selection of `REVOKE`, `GRANT`, `HOLD` or
`PASS`; its procedure is not duplicated here.

Before mutation, work admission is closed under the Session transition contract. Excess rights are
removed before missing ones are attached. Narrowing uses a reviewed OneCLI mutation that preserves
shared desired rights; if that is impossible, detach first and let a later tick restore the desired
subset. Partial mutation is verified from both inventories on the next tick.

A correct attachment with unavailable effectiveness waits for OneCLI propagation or the external
owner. Organization denial, expired provider authorization and missing approval support have typed
remediation. Repeatedly attaching the same grant cannot cure them. No worker edits organization
policy, injects a credential or grants a wider scope as a fallback.

Direct edits to an Agora-owned Agent are drift; a lasting requested change is authored as Intent.
External restrictions remain authoritative and are never reversed to make the Intent realizable.
Effective excess authority that Broker cannot remove keeps traffic closed and requires its owner.

## One Pod incarnation, one OneCLI Agent

`BUILD` establishes one Pod, a dedicated Agent with no grants, and an initially inactive relay
binding. A stable operational creation key is reserved before external creation; after Kubernetes
establishes the Pod, the binding includes its immutable UID. The Agent is never rebound to a
successor Pod or another Workstream. It can serve successive Agora Sessions only on that same Pod.

Every Agent and binding MUST remain exhaustively discoverable by Workstream independently of the
Pod's existence. Broker-private records may retain correlation, creation keys and cleanup work;
they never prove that OneCLI still holds an Agent. Default/shared Agents are forbidden.

A partial creation or deletion is recovered using the same target and creation key. Before creating
another Agent after an unknown response, Broker must resolve the first attempt through OneCLI's
inventory. A duplicate or orphan prevents work and is cleaned up by the construction/shutdown rules.

## Broker control and relay

Only Broker control holds OneCLI control authority. It creates/deletes dedicated Agents, mutates
grants, reads both attached and effective inventories, and owns encrypted private upstream Agent
bearers. Provider credentials remain exclusively OneCLI-owned.

The Pod receives a workload-authenticated fixed relay endpoint, non-secret auth placeholders and
operator-managed CA trust. It receives neither the OneCLI control key nor the upstream Agent bearer.
The runtime controller rematerializes that fixed bundle from trusted deployment state; responses
from OneCLI are not a vehicle for arbitrary Pod configuration.

Relay reachability is a fixed deterministic, conservative projection of OneCLI's freshly observed
effective grants. An unrecognized grant has no inferred route. The projection may narrow
reachability; it cannot widen OneCLI rights. No harness-specific independent allow-list or policy
compiler output authorizes additional egress.

The relay authenticates the Pod incarnation, validates that its binding is still usable, and
forwards opaque CONNECT traffic only to OneCLI. It never terminates provider TLS, reads provider
content, holds provider credentials or injects them. Direct Pod access to providers, the public
Internet and OneCLI is denied independently of proxy environment variables.

## Revocation and identity changes

Revocation can close the bound relay and terminate established tunnels without ACP cooperation.
It then removes or narrows OneCLI grants and verifies the resulting authority. The closure cannot
retroactively undo completed external operations or data already returned.

Replacement invalidates the predecessor's binding and Agent before successor work begins. A
reused Pod changes its authority only across the quiescent Session boundary; its Agent identity is
retained while its exact grant set changes. Removal of a Workstream's footprint also removes its
Agent and inactive bindings.

All mutations carry a target incarnation, a stable attempt key and current controller ownership.
A stale worker must not recreate an old Agent or reopen a closed predecessor binding. Unknown
upstream completion is resolved before reusing that target for work.

The [engine ownership protocol](reconciliation/engine.md#effect-ownership-and-late-requests)
governs these mutations, including a request that arrives after an obsolete worker loses its claim.
Unsettled creation remains an operational obligation even before OneCLI inventory shows its result.

## Persistence and recovery

Broker-private durable records contain only operational ownership, workload bindings, idempotency
and cleanup records, plus encrypted upstream Agent authority where required. They are isolated
from product facts, projections and Saves. Their loss closes outstanding access until owner reads
and authenticated rebinding establish a valid path.

OneCLI owns credential storage, gateway CA/private-key material, upstream Agent tokens and request
audit. Its database, CA state and encryption-key recovery set must be restored consistently.
Credentials, tokens, prompts, tool results and URL query strings are excluded from Broker logs.

The exact public OneCLI API version, supported grant restrictions and negative enforcement checks
must be pinned and demonstrated before an integration is enabled. This design does not assert that
an unverified adapter or existing machine-readable contract already meets these requirements.
