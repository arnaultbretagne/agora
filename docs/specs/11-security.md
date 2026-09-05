# Security and extinction

## Threat model and owners

Harnesses, installed tools, native state and all code inside an execution Pod are untrusted. Prompt
injection can cause arbitrary local execution. The design protects provider/infrastructure secrets,
Workstream data, product database integrity, Kubernetes control and capability authority without
relying on model cooperation.

[ADR 0009](../adr/0009-onecli-grant-authority.md) and [spec 10](10-equipment-and-broker.md) make OneCLI
the sole external grant and credential authority. The complete image carries software, not access.
The control plane owns product authorization and Intent; runtime control owns Kubernetes isolation;
Broker control owns the Pod-bound OneCLI Agent and its opaque access relay. These service boundaries
remain authenticated even when services share a repository.

## Authentication and product authorization

Human/API calls use platform identity and Workstream membership at every boundary. An owner can
read/write, administer membership and delete; an editor can submit Intent/prompts and edit product
metadata; a viewer can read authorized items/feed/status. Service actions record actor and delegated
authority and do not manufacture a human membership.

Service calls use authenticated workload identity. ACP connections and relay bindings are scoped
to the exact Pod/process or workload incarnation. One selective OneCLI Agent belongs to one Pod UID
and may serve successive Agora Sessions on that Pod; it is never reused by a replacement or another
Workstream. Session attribution does not grant external access.

The browser selects reviewed harness/model/effort and named capabilities and submits ordinary prompt
content or permission decisions. It cannot supply arbitrary PodSpecs, credential IDs, provider
endpoints, executable configuration, foreign Saves or OneCLI control material. Required provider
invocation is covered by explicitly selected named capability policy, never implicitly by a model.

## Network and opaque relay

Default-deny isolation prevents Pods from reaching product Postgres, Kubernetes control, other
Workstreams, providers, the public Internet or OneCLI directly. Explicit internal reachability is
limited to reviewed authenticated bridge, relay and custody transports. The provider relay reaches
only the reviewed OneCLI gateway path; there is no fallback route during an outage.

Broker authenticates the workload and selects its bound OneCLI Agent. It tunnels provider traffic
opaquely. It must not terminate provider TLS, inspect prompt/tool bodies, inject credentials or
become an HTTP provider adapter. OneCLI stores and injects provider credentials.

The relay's reachability filter is a deterministic conservative projection of observed effective
OneCLI grants. A route has no independent allow policy and confers no credential-backed authority
without a matching OneCLI grant. An unrepresentable or stale projection closes access until verified.
Unknown attached rights are removed even when masked by upstream restrictions (spec 10).

Conformance must exercise actual provider/tool requests, denied routes and existing tunnels under
the pinned OneCLI/relay version. A successful CONNECT response alone proves neither authorization
nor a credential-bearing operation. No undocumented gateway default, rule ordering or API feature
is assumed to provide the required behavior.

## Restriction, shutdown and in-flight requests

New Intent, loss of trustworthy evidence or a detected unsafe drift closes work admission. Broker
closes affected relay routes and existing tunnels before restriction, independently of ACP health,
quiescence and Save success. It removes excess attached/effective grants through OneCLI and verifies
the remaining exact set. Failure to revoke leaves the target gated with a typed owner diagnostic.

For shutdown, revoke all grants and upstream Agent authority, delete the Agent and remove its relay
binding, while runtime control independently terminates execution. An inactive binding or an Agent
with no grants still counts as footprint until removed. Partial cleanup cannot be called `off`.

Closure prevents further transport through the revoked binding. It cannot retract data already
returned or cancel an operation accepted by a provider. Such a request may complete remotely and
its outcome can remain unknown. A completed ACP cancellation is not a universal rollback of tools,
child processes or external side effects; local quiescence and external ambiguity are separate.
The ACP cancellation/late-update contract is described by
[ACP prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation).

A stale controller cannot revive access by finishing an old grant or Agent creation after cleanup.
Trusted mutation boundaries enforce current ownership and resolve unknown in-flight operations
before allowing conflicting work. Pod/Agent identities are never rebound. Workset finalization CAS
alone is insufficient to enforce this; the engine and spec 13 define the recovery obligation.

A missing Pod API object does not prove physical termination under partition. The runtime retirement
inventory and infrastructure-fencing contract in spec 08 protect against overlapping execution and
workspace writes. Workload expiry or relay closure alone does not establish that local code stopped.

## Secrets and content

Provider credentials exist only in OneCLI. Its control key is restricted to Broker control; the
per-Agent upstream bearer is encrypted in Broker-private operational storage and available only to
the relay. Pods receive neither. Workload/bridge credentials are short-lived, scoped and excluded
from product facts, logs, Saves and environment-based content transport. Trust roots and placeholder
stubs are non-secret deployment assets, never a way to recover upstream authority.

Saves and workspace dependencies exclude renewable authority by reviewed driver construction.
They can still contain confidential prompts, paths and tool output; reads remain Workstream-scoped,
encrypted and audited. Core services do not inspect Save bytes to enforce these rules.

ACP input is bounded and validated under stable ACP types. Unknown metadata is preserved without
execution, filesystem callbacks stay within authorized roots, permission decisions are explicit,
and Web escapes untrusted content. Retained raw envelopes have product access control; logs are not
an alternate transcript store.

OneCLI/relay logs and audit records exclude query strings, headers, request/response bodies, tokens
and Save bytes. Content-bearing approval previews are disabled unless their exact pinned behavior
has a reviewed confidentiality contract. Approval scope still participates in grant equality; this
does not silently replace required approval with unconditional access.

## Infrastructure, storage and supply chain

Only runtime control's service identity can create/delete execution workloads. Validated templates
pin image digests, non-root identity, restricted mounts, limits and no Kubernetes token. A Pod may
not choose its image, service account, command or privileged configuration. Database roles separate
product facts, projections, custody metadata, custody payloads and migrations; core has no payload
read grant. Access is enforced by storage roles as well as application authorization.

Harness/tool/adapter and OneCLI artifacts have reviewed pinned versions and provenance. Pods install
nothing at startup. Registry changes include dependency, grant, Save compatibility and isolation
review; rollout retains definitions required by running old images. Conformance includes rejection
of wrong incarnations, direct provider paths, stale grants, credential capture and late mutations.

Audit records retain actor, Workstream, Session where one exists, target incarnation, operation,
policy/registry revision and outcome. Reconciliation attempts before Pod birth have no fabricated
Session. Privileged overrides and break-glass reads require dedicated durable audit. No security
property in this specification is claimed verified by this documentation-only design revision.
