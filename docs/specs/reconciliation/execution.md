# Execution boundaries

This contract applies ADRs [0002](../../adr/0002-workstream-session-model.md),
[0004](../../adr/0004-acp-boundary-and-session-facts.md),
[0006](../../adr/0006-complete-harness-images.md),
[0007](../../adr/0007-kubernetes-runtime.md) and
[0009](../../adr/0009-onecli-grant-authority.md). Rules select objectives;
[verbs](003_verbs.md) own their procedures and the [engine](engine.md) fences their effects.

## Owners and isolation

| Boundary | Authority |
|---|---|
| Control plane | Product authorization, complete Intent, Workstream order, Session attribution, ACP Client and prompt admission |
| Runtime control | Kubernetes workloads, live process evidence, controlled launch, isolation, custody transport and physical retirement |
| Broker control and relay | Dedicated OneCLI Agent lifecycle, exact grant mutations, workload binding and opaque provider transport |
| OneCLI | Provider credentials, attached/effective authority and enforcement of credential-backed requests |
| Registered custody driver | Native payload interpretation, consistent capture/restore and bounded native continuity evidence |

These remain authenticated service boundaries. Human/API actions require authorization for the
Workstream and referenced resources; service actions retain actor and delegated authority. Session
attribution grants no access. Harnesses, tools and native state are untrusted, including under prompt
injection. Their callbacks never borrow control-plane filesystem access or infrastructure credentials.

### Workstream authorization

The minimal product authorization model, recorded before the control-plane API exists (S2):

- A principal identifier arrives in one header set by the deployment's trusted authentication proxy;
  the previous deployment used `X-Forwarded-Email`. The proxy, not Agora, authenticates the human;
  requests reaching Agora without that header carry no principal and are unauthenticated.
- The Workstream's creating principal is its owner. Only the owner reads or writes the Workstream,
  its Intents and its product-facing views. Ownership is not transferable while no transfer contract
  is registered.
- Service actions (workers, controllers, brokers) are not human principals: they act under their own
  service identity, carry the actor that caused them where a record requires one, and never widen a
  human principal's access.

Runtime control resolves reviewed images, commands, mounts and limits server-side. Public input
cannot supply arbitrary images, argv, environment, PodSpecs, credential IDs or executable definitions.
Pods run non-root with bounded resources, no host privileges or Kubernetes token, and default-deny
access to product/Save storage, control APIs, other workloads, direct OneCLI and external providers.
Only reviewed authenticated bridge, relay and scoped custody paths are reachable. Proxy environment
variables alone do not enforce confinement.

One Pod incarnation has one selective Agent, initially ungranted, and an initially inactive binding.
Neither may be rebound to another Pod or Workstream. They remain independently discoverable after
Pod loss. The Pod receives fixed endpoints, scoped workload identity, trust roots and non-secret
stubs. Only Broker control holds the OneCLI control key; upstream Agent authority is encrypted in
Broker-private storage. Provider credentials remain OneCLI-owned. Broker-private recovery records
are operational; their loss closes access until owner evidence reestablishes a valid binding.

The relay authenticates the incarnation and forwards opaque CONNECT traffic only to OneCLI. It
never terminates provider TLS, inspects provider content or injects credentials. Its reachability
filter is a conservative deterministic projection of fresh effective grants, with no independent
allow policy. Unknown/stale mappings close access. Restriction closes affected routes and existing
tunnels independently of ACP or Save capture. An accepted remote operation may still complete;
revocation cannot retract returned data or establish rollback.

## Session birth and admission

Every established Pod gets a new Agora Session before native launch or any ACP envelope, including
failed bootstrap attempts. In one operation serialized with Workstream appends, pin opening cutoff
`H` to the prior head, open the Session and record the Pod UID/provenance. Repeating that birth cannot
create another Session or cutoff. A request that establishes no Pod creates no Session. The birth
operation appends the Session's first fact — the registered `session.opened` kind
(`contracts/schemas/fact-kinds.json`) — so nothing of this Session precedes `H`; ending attribution
appends `session.ended`. No `off` Session exists (ADR 0002).

BUILD opens no native context. Subsequent rules reconcile exact grants, select restore or fresh
start, verify actual model/effort, then synchronize the immutable
[opening descriptor](continuity.md#opening-descriptor). Desired values are never recorded as realized
conditions before verification. All bootstrap and failure facts belong to the new Session.

Admission is checked for the same current Intent, selected revisions, ownership and concrete target:

- power is on, one reviewed Pod/Agent/binding envelope exists, and predecessor execution and authority
  are proved extinguished or fenced;
- a Session owns the work, the native context/connection is verified, and frozen default persona holds;
- attached and effective grants both equal the complete compiled desired set;
- actual model and effort match Intent before any Handoff or user prompt;
- opening synchronization is verified before user work;
- no prior turn, callback, child process or possibly accepted delivery prevents the boundary.

A Handoff is effectful and uses these same checks except its own synchronization prerequisite.
Controlled bootstrap may use declared, explicitly requested provider authority to obtain a context;
it cannot start an unrequested generation or user turn to obtain readiness/config readback.

At most one prompt turn, including Handoffs, is in flight per Workstream. Dispatch reservations
serialize with Intent authoring and Session transitions under the engine contract. A queued command
is revalidated at dispatch and never silently moved to another Session. Superseding Intent, evidence
expiry or unsafe drift closes further admission. A database commit alone cannot reopen a stale path.

## Hot Session boundaries

A retained Pod and its Agent can serve successive Sessions only across this boundary:

1. Close new admission and bind the transition to the ending Session, current Intent/revisions and
   Pod/process/context.
2. Finish or cancel the turn, settle its final ACP exchange, and drain or terminate callbacks, child
   work and local request paths within the original bounded deadline. Cancellation alone proves no
   quiescence. Record remotely accepted effects that remain unknown.
3. Restriction may act immediately without ACP cooperation. Additions and configuration changes
   wait for quiescence; only rule-selected mutations proceed. Their exchanges belong to the old Session.
4. Freshly verify all effective conditions, then conditionally commit one old/new attribution boundary
   for the still-current target before subsequent work. Repeated completion opens no duplicate Session.
5. Owners reopen admission only while the committed target and evidence remain valid.

Partial application or a crash keeps admission closed until actual conditions and the same context
are verified. An obsolete transition cannot complete for a newer Intent. Equivalent effective
conditions without intervening work require no new Session; a changed revision with identical
meaning/output adds provenance only. Effective conditions include harness artifacts, native context,
model/effort, capability meaning and grants, and the frozen persona guarantee.

Hot attribution retains the context's opening descriptor and sends no new Handoff. Reconnect to the
same verified process/context also creates no Session. Process/context loss, including a restart
inside the same Pod, invalidates evidence: this baseline retires the incarnation and rebuilds.
Failure to prove quiescence or identity never permits silent reuse. Unexpected changes during a
turn are recorded honestly; no historical effective boundary is invented at an unknowable time.

## ACP facts and current evidence

Use pinned stable ACP v1 SDK/schema types and standard requests/content/configuration. The bridge
authenticates and frames ACP without translating semantics; it is distinct from the provider relay.
Negotiate actual capabilities at initialization. Restore bytes before opening the resumed context;
resume binds to the consuming Agora Session. There is no automatic message replay into product facts.

Capture complete accepted envelopes before controlled transport write or semantic handling. Preserve
unknown members, `_meta`, array order and lossless semantic JSON numbers. SDK conversion cannot
replace canonical JSON with a lossy object. Each accepted occurrence has stable causation, one Session
and one Workstream sequence; content equality does not deduplicate it. Database failure applies
backpressure. Outgoing commit proves scheduling, incoming commit proves acceptance into the journal;
neither proves a subsequent effect. Invalid frames yield safe diagnostics, not canonical content.

Late/buffered frames retain their original request/connection attribution. A capture seam unable to
distinguish them must drain/reconnect before new work. Receipt time cannot relabel old work. Projections
are deterministic disposable views with source references, never a second journal or live proof.

Bridge capture rules (S4, verified against the pinned SDK — `packages/acp/README.md`):

- One NDJSON frame carries exactly one JSON value encoded as UTF-8, with at most trailing
  whitespace; anything else is a framing diagnostic, never a fact.
- The frame ceiling is 32 MiB per frame. A peer that exceeds it fails the connection closed; the
  buffer is never grown without bound.
- Frame scanning resumes where the previous scan stopped — reassembly must not rescan from zero.
- The bridge authenticates the ACP side before carrying frames. S4 development bridges share a
  static secret; S8 replaces it with per-incarnation credentials. The bridge frames and
  authenticates; it never translates ACP meaning.

Current configuration comes from a fresh owner snapshot or a freshly verified, complete ordered
stream continuing from such a snapshot for the same process/context. Lost continuity, reconnect or
unknown buffered updates invalidates it. Updating a cached response's timestamp renews nothing.
Actual resumed model/effort must be read, not echoed request defaults. Model changes precede fresh
dependent effort options; missing/unsupported values never imply a substitute default. The frozen
persona guarantee must also hold after restore.

Generic ACP support implies no universal config getter, liveness query, transcript read or prompt
deduplication. An integration must demonstrate its required evidence using supported standard
operations and the registered driver. [Prompt recovery](engine.md#prompt-delivery-and-context-creation)
covers new/resume/prompt/cancel ambiguity. Negotiated permissions, files, terminals and other Client
callbacks stay within authorized workload roots; they cannot widen OneCLI authority.

## Shutdown and physical extinction

[TURN_OFF](003_verbs.md#turn_off) persists concrete targets and the original shutdown deadline,
closes admission and starts relay closure/revocation independently. It attempts only eligible
quiescent capture and conditional Anchor publication within the fixed preservation budget, then
terminates with bounded grace regardless of capture outcome. Restart never resets the deadline.
Reachable owners continue cleanup while others fail. A successful Save neither retains authority
nor creates an off Session; shutdown facts belong to the execution being stopped.

Kubernetes API absence alone does not prove execution stopped. Runtime control retains every
unresolved retirement obligation in its authoritative inventory until fresh runtime termination
evidence or verified infrastructure fencing proves physical extinction. Fencing must prevent local
execution and conflicting workspace writes; closing provider access alone is insufficient.

A successor cannot perform work while predecessor execution or authority could overlap. Off remains
unrealized during an unresolved partition, with owner diagnostics and recovery scheduling. Mandatory
termination means preservation never vetoes cleanup; it promises no fixed physical extinction time
for an unreachable machine. Unknown creations and late owner requests also block finalization under
the engine contract. Names or Workstream aliases never substitute for concrete cleanup targets.

Physical extinction evidence (P6, what this implementation accepts as proof that a Pod's process
stopped): the Pod is observed `Succeeded` or `Failed` with every container state `terminated`; or
the Pod was force-deleted and its node is `Ready` and reports the Pod gone via the kubelet; or the
operator explicitly fenced the infrastructure (node drained and cordoned). A partitioned or NotReady
node leaves the obligation unresolved: the inventory keeps reporting the footprint and `off` stays
unrealized. A deletion receipt alone never discharges anything. Runtime-control restarts never reset
the persisted original shutdown deadline.

## Harness and owner conformance

An enabled definition pins image/common tool bundle, harness/ACP/driver versions, fixed launch/MCP
configuration, model/effort options, named bootstrap authority, Save formats/dependencies and operating
limits. Every harness carries the same reviewed tool surface. Software registration adds no rights.
Only `harness_id` selects an image; persona and capabilities produce no image variants. Retain old
definitions for running-image shutdown and Save compatibility. Image-to-harness resolution must be
unambiguous, including manifest/platform digest handling. Shared revision publication is governed
by [the engine](engine.md#intent-authoring-and-revision-selection).

| Required behavior | Evidence before enablement |
|---|---|
| Launch and identity | Gated Pod before ACP; stable incarnation correlation; bounded startup and safe process-loss retirement |
| Configuration and bootstrap | Actual fresh/restored values, dependent options, default persona and declared provider prerequisites |
| Quiescence and delivery | Bounded local drain/fencing; old callback attribution; unknown acceptance recovery without blind resend |
| Continuity and custody | Consistent capture/restore, compatibility, exclusions and verifiable native input lineage across supported compaction |
| Isolation and OneCLI | Actual allowed/denied provider operations, attached/effective comparison, revoked existing tunnels and rejected bypass paths |
| Ownership and recovery | Late creation/mutation discovery, stale-writer fencing, missed-watch recovery and physical extinction proof |

Pinned artifacts require provenance and supply-chain review; common bundle changes verify every
harness and record image/startup cost and compatibility. No startup installation substitutes for
that evidence. Frame/size limits, freshness, deadlines and fencing mechanisms must be explicit.
Owner/control/OneCLI recovery preserves compatible private identity, credential and trust state;
missing state closes access rather than moving secrets into Pods.

Logs contain safe actor/Workstream/Session/target/revision/outcome correlations, no query strings,
headers, prompts, tool content, credentials or Save bytes. Scoped bridge/workload credentials stay
outside ACP facts, product projections and Saves. Content-bearing approval previews need a reviewed
confidentiality contract; required approval cannot silently become unconditional permission.
The [acceptance scenarios](acceptance.md) are design obligations, not evidence of a working integration.
