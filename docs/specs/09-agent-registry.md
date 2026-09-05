# Harness registry and conformance

This specification applies [ADR 0006](../adr/0006-complete-harness-images.md). The trusted registry
contains reviewed, versioned repository definitions, selected by `harness_id`. It replaces the
former product Agent/runtime-definition catalogue. Public API/schema alignment is still required
before implementation; this document does not endorse the previous wire shapes.

## Definition and authority

A definition records:

- stable harness integration id and public label;
- immutable harness image digest and common tool-bundle version;
- pinned harness, ACP adapter and SDK/schema versions;
- fixed launch and MCP registration configuration;
- supported models, effort values and their standard ACP option ids;
- reviewed named authority required for bootstrap/model invocation, resolved only by policy;
- custody driver, readable/writable formats and compatibility constraints;
- controlled launch, quiescence, process identity and health contracts;
- workspace capture/exclusion policy and resource/size/deadline limits;
- conformance evidence and rollout availability.

Browser Intent selects public enabled ids; it never supplies definitions, argv, images, provider
scopes or a preferred private/stale revision. The runtime controller owns workload materialization.
The policy compiler owns exact grants. Harness definitions contain no independent provider relay
policy and add no implicit credential access.

Every supported tool is present and registered in the same reviewed common bundle for every
harness. Model/bootstrap prerequisites do not introduce a per-harness tool-capability matrix.

## Resolution and publication

Trusted deployment configuration selects one immutable catalogue revision for all reconcilers and
controllers. Workers with incompatible definitions refuse work instead of substituting their own
bundled revision. One evaluation resolves a harness id, image and policy against one identified
compatible revision set; each action binds that resolution immutably.

Publication includes the affected harness ids and wakes their Workstreams, including those absent
from the workset. The construction rule currently replaces Pods on a superseded image digest.
Rollout must retain old definitions for provenance, shutdown, Save compatibility and rollback.
An old running digest must remain resolvable to its actual harness definition when capturing a Save.
Digest-to-harness mapping is unambiguous; two different integration ids cannot share an ambiguous
image identity in the admitted catalogue.

Before an on Intent is accepted, validate its model/effort and required named provider authority.
At runtime, validate the actual negotiated ACP capabilities/options again. A later incompatibility
is surfaced as unrealizable desired execution; it never mutates the immutable Intent silently.

## Required evidence

| Behavior | Required conformance evidence |
|---|---|
| Controlled launch | Pod can exist while harness work is gated; restore can precede ACP context opening. |
| Identity | Live Pod UID, process generation and ACP context can be correlated; restart/reconnect cannot pass as the previous incarnation. |
| Configuration | Actual model/effort readback after fresh start and restore; ordered dependent option changes; renewed evidence after connection loss. |
| Bootstrap | Its required authority is declared; obtaining config/readiness starts no user turn or unrequested generation. |
| Quiescence | Completion/cancellation, child processes, callbacks and external requests can be bounded and fenced before reuse. |
| Native continuity | The registered driver can establish the opening Handoff proof for the live context, including compaction and restore, under specs 06/07. |
| Delivery recovery | Unknown acceptance is distinguished from proof of non-acceptance; unsupported recovery remains explicit. |
| Save compatibility | Capture, checksum/size, exclusions, restore collision behavior and compatible-version readback are demonstrated. |
| Isolation | Direct provider/control/storage access is denied and OneCLI revocation remains effective independently of harness cooperation. |

An advertised option, a successful launch or an old Session fact is not this evidence. The same
contracts apply to every enabled harness; per-integration details identify how a supported standard
operation or driver guarantee fulfills them, without a new semantic product protocol.

## Driver boundary

Only the registered custody driver knows native paths and transcript formats. It declares capture
roots, credential exclusions, consistency guarantees and how live continuity evidence is read.
The product core compares non-secret typed evidence and metadata; it never parses Save bytes.

Proof must distinguish the live context from a durable Save, and the Save's producer Session from
its consumer. A custom persona cannot be assumed to become default because a client request or
adapter response says default; compatibility must establish the frozen persona invariant.

A native compaction policy must preserve or provide verifiable lineage for the opening continuity
proof. If that cannot be demonstrated, the integration must not claim the corresponding readback.

## Rollout and cost

Definitions may be disabled, internal, enabled, deprecated or retired as operator-managed catalogue
metadata. Enabling requires the evidence above. Retirement must preserve the restore/migration path
for retained Anchors or explicitly select supported fresh-context continuation.

Common tool changes rebuild and verify every harness image. Publication records image size, startup
cost, exposed tool count and compatibility results so the complete-bundle tradeoff remains visible.
Compatibility or supply-chain checks cannot be replaced by runtime installation/downloads.
