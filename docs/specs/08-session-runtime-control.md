# Kubernetes runtime control

## Ownership and correlation

[ADR 0007](../adr/0007-kubernetes-runtime.md) selects Kubernetes. Runtime control owns creation,
observation, controlled launch, isolation, capture transport and termination of Pods. The control
plane owns Intent, Session attribution, ACP and rule selection; Broker owns OneCLI lifecycle and
opaque relay bindings. There is no persisted product `Runtime`, `SessionRuntime` or `runtime_id`.

Operations are scoped to a Workstream and correlated to a specific Pod UID once it exists. An
immutable creation attempt identifies a request before Kubernetes allocates the UID. Pod names,
process generations, workload identities and OneCLI Agent IDs are operational correlations, not
new domain identities. One Pod can host successive Agora Sessions, never concurrent Workstreams.

The controller retains operational requests, target UIDs and unfinished retirement obligations
across crashes. These records cannot prove that a Pod is ready or absent. Live Kubernetes reads,
launcher/process evidence and verified infrastructure fencing establish current conditions.
Historical Session facts are provenance, never a live resource inventory.

The [engine ownership protocol](reconciliation/engine.md#effect-ownership-and-late-requests)
governs creation, mutation and retirement requests, including unknown upstream acceptance.

## Construction contract

A creation request accepts only Workstream identity, still-current mutation ownership, stable
attempt key, trusted harness/catalogue revision and an authorized workspace mount reference. It
resolves the reviewed image, command, resource limits and isolation template server-side. It accepts
no user PodSpec, arbitrary image, command, environment, provider token or executable configuration.

`BUILD` creates one initially gated Pod and its unique selective OneCLI Agent and relay binding.
The Agent starts without grants; Broker holds its private upstream credential. The Pod receives
only its workload identity, fixed relay/bridge addresses, trust roots and non-secret stubs. It
receives no OneCLI control authority, upstream bearer, provider credential or product database access.

All creation operations have a durable correlation before external dispatch. Repeating the same
request discovers/completes the same target, never creates a second one. A timeout cannot free the
creation slot while a prior request may still produce resources. A newer owner resolves or fences
that attempt before allowing another build. Partial resources remain attributable even if the Pod
never appears; no resources are found solely by following the latest Session or an existing Pod.

The established Pod is held at a controlled launch seam. Session birth and its fixed Workstream
cutoff precede native restore or ACP work (spec 03). Native restore can occur in this existing Pod
before the harness context is launched. `BUILD` opens no ACP context and grants no capability.
Envelope existence, ACP reachability and prompt admission are separate observations.

## Current construction and process evidence

Kubernetes Pod spec image references and running container image IDs are distinct evidence. A
Pending Pod can expose its admitted digest-pinned image without executing it. Runtime control
checks the trusted template and binding ownership, then verifies the running image ID when one
exists. Registry rules must account for manifest/index versus platform image digests. Tags or
Agora-written labels alone cannot establish the observed image.

A coherent envelope has exactly one non-retiring Pod, one uniquely Pod-bound Agent and one binding.
A healthy startup can be Pending. Terminal/terminating Pods, proven process loss, expired launch
budgets and controller-retired incarnations are unreusable footprints; they cannot pass construction
and sit indefinitely behind a capability propagation wait. A launcher still making progress within
its deadline remains eligible for `SESSION`'s bounded `pending` hold.

Startup time is measured from the original attempt under a declared registry budget. Retries and
controller restarts do not reset it. An owner must distinguish progress, process replacement,
verified failure and unavailability. An unreachable source cannot be normalized to absence or
success. A harness process restart invalidates its old native context even if the Pod UID survives;
this baseline retires that incarnation and rebuilds rather than silently reusing its Session.

If duplicate envelopes exist, admission closes for all. Construction selects cleanup of the whole
footprint; the controller does not pick an undocumented survivor. No automatic workload controller
may produce a replacement that bypasses the same ownership and predecessor-extinction checks.

## Connections and capture

Authenticated ACP bridge connection credentials are scoped to the Workstream, Pod/process target,
client purpose and short validity. Reconnect to the same verified live context does not create a
new Session. A credential or response from an older target cannot attach to its replacement.
Broker provider relay traffic is separate from ACP bridge transport.

Capture is an explicit request bound to the current producing Session, context, verified frontier,
driver revision and stable capture ID. Runtime control streams to custody under spec 07 and returns
only metadata. Capture and Anchor publication are separate from deletion. The controller never
implicitly selects a different frontier, advances an Anchor or interprets Workstream history.

## Shutdown contract

`TURN_OFF` targets every attributable Pod, retiring incarnation, Agent, grant and binding, including
partial or orphaned construction. Cleanup is idempotent per concrete target; it must not delete or
revoke a later target merely because a Workstream identifier matches.

1. Close prompt admission and revoke bridge admission to further work. Persist the original shutdown
   deadline and concrete cleanup targets under current ownership.
2. Independently start Broker relay closure, existing-tunnel termination and OneCLI revocation.
   Request harness cancellation/drain and stop child work; ACP cooperation is not a security barrier.
3. Within the remaining fixed budget, capture eligible quiescent context, commit its Save and
   conditionally advance its Anchor. Record capture failure, ineligibility or timeout without
   extending the budget or waiting for a new forced-loss approval.
4. Terminate the Pod with bounded grace regardless of Save outcome. Continue OneCLI Agent removal,
   credential invalidation and relay cleanup even if Kubernetes or another owner is unavailable.
5. Re-observe all inventories and outstanding physical execution obligations. Complete extinction
   only once all are absent. Save completion or an accepted deletion response is insufficient.

Partial cleanup progresses on reachable owners; failure of one does not postpone restrictions on
another. A retry after Save/Anchor commit skips completed immutable work. Capture cannot run after
its Pod/context was lost, and a failed restore cannot overwrite the preceding healthy Anchor.
The verb never decides whether a successor should be built; a later rule reads the latest Intent.

## Partition and physical termination

Kubernetes force deletion removes the API object without waiting for confirmation that the process
stopped; the process can continue on an unreachable node
([Kubernetes Pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)).
Consequently, absence from a Pod list alone does not complete Agora extinction.

The runtime owner keeps an outstanding retirement entry for each target whose execution is not
proven stopped. It is part of its authoritative operational inventory until fresh kubelet/runtime
termination evidence or verified infrastructure fencing resolves it. Fencing here must prevent
local execution and conflicting workspace writes, for example confirmed node shutdown; merely
closing provider access is insufficient for the single-execution invariant.

Relay closure and OneCLI revocation cut external access independently. A successor remains gated
while either execution or authority could overlap. During a partition, `off` can remain unrealized
with a typed diagnostic even though all possible termination requests have been issued. Mandatory
extinction means preservation never vetoes termination; it does not promise control of an
unreachable machine within a fixed time. Operator remediation must report its evidence explicitly.

## Isolation and lifecycle policy

Every Pod runs non-root, without a Kubernetes API token, host paths, arbitrary PVCs or privileged
service credentials. It has reviewed CPU/memory/PID/storage limits and default-deny network access.
Only the controller can create/delete these workloads. Workload identity and access are bound to
Pod UID; names and IP reuse confer no authority.

Idle collection requests the same controlled shutdown objective through the control plane.
Emergency termination records its cause and follows authority cleanup. No collector invents a
Session phase or treats a successful Save as permission to retain access after an `off` Intent.

The existing `contracts/openapi/session-runtime-control.yaml` requires replacement/alignment before
implementation. This specification defines operation semantics, not compatibility with that
unreviewed wire schema. Concrete routes, fields, timeout values and infrastructure-fencing support
must be pinned and tested under [specs 09](09-agent-registry.md) and [15](15-acceptance-and-migration.md).
