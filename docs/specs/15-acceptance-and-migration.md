# Acceptance and migration

These are design and black-box acceptance scenarios for the accepted remodeling ADRs. A documented
scenario is not an executed test. Implementation must align its machine-readable contracts and
provide evidence before claiming the corresponding acceptance gate.

## Exact authority

Source: [ADR 0010](../adr/0010-capabilities-are-onecli-grants.md),
[Capabilities and OneCLI](10-equipment-and-broker.md), and the
[CAPABILITIES rule](reconciliation/006_capabilities.md).

| Scenario | Required outcome |
|---|---|
| `AUTH-001`: empty desired set, one grant remains from a two-grant capability | The remaining grant is observed and revoked; capability-name equality cannot pass. |
| `AUTH-002`: an unknown grant or broader tool permission is added manually | Excess authority remains visible, traffic is gated and the excess is removed. |
| `AUTH-003`: an unwanted attachment is masked by organization denial | The attachment is removed even though it is currently ineffective; lifting the denial restores nothing. |
| `AUTH-004`: two desired capabilities share a grant, then one is removed | Compilation retains the shared desired right; retries never remove it permanently. |
| `AUTH-005`: attachments match, but OneCLI denies desired authority | Work stays gated, the restriction is exposed, and no repeated attachment or organization-policy mutation occurs. |
| `AUTH-006`: a grant mutation partly succeeds and the caller crashes | Owner readback finds the partial difference and recovery targets the same Agent and payload. |
| `AUTH-007`: approval mode or a restriction changes | Equality detects the semantic change; a restricted permission is never treated as unconditional access. |
| `AUTH-008`: the compiler revision changes during an attempt | The old attempt retains its payload; fresh resolution creates distinct work before activation. |
| `AUTH-009`: a model needs provider access absent from the selected named capabilities | Authoring rejects the unsupported on Intent; no implicit provider grant is attached. |

## Session admission and conformance

Source: [Session boundaries](03-session-lifecycle.md), [ACP integration](04-acp-integration.md)
and [Harness conformance](09-agent-registry.md).

| Scenario | Required outcome |
|---|---|
| `SESSION-A01`: new Pod with a non-empty Workstream | The Agora Session exists before bootstrap; exact grants and model/effort are verified before the first Handoff; user prompts wait for sync. |
| `SESSION-A02`: model, effort and capabilities change during a turn | Further admission closes; restriction can act immediately; remaining mutations wait for quiescence and no mixed configuration performs new work. |
| `SESSION-A03`: a hot transition partly applies, then the controller crashes | Recovery reads the actual same context, keeps admission closed and commits at most one successor boundary when complete. |
| `SESSION-A04`: an equivalent Intent or reconnect reaches the same live conditions | No artificial new Session or opening Handoff is created. |
| `SESSION-A05`: an old callback or buffered frame arrives at a hot boundary | It retains original causation/attribution; the new Session cannot acquire old work by receipt time. |
| `SESSION-A06`: a process restarts within the same Pod | Its old evidence and admission are invalidated; no silent reuse of the previous execution attribution. |
| `SESSION-A07`: a new Intent arrives between verification and admission | The obsolete boundary cannot admit work or erase the newer obligation. |
| `SESSION-A08`: resume reports a request default instead of actual model/persona | Conformance fails; the option is not accepted as authoritative readback. |
| `SESSION-A09`: config notification continuity is lost | No cached response is relabeled fresh; acquisition reestablishes evidence before work. |
| `SESSION-A10`: grants need restriction while ACP is unreachable | Revocation still closes the provider path and removes excess rights. |
| `SESSION-A11`: two deployed workers carry different catalogues | Both use the selected trusted revision or refuse the attempt; image/authority targets never oscillate by worker version. |

## Native continuity and bounded shutdown

Source: [ADR 0008](../adr/0008-saves-anchors-and-refill.md), specs
[06](06-anchors-and-handoffs.md), [07](07-custody.md), [08](08-session-runtime-control.md),
[11](11-security.md) and [13](13-failure-and-idempotency.md).

| Scenario | Required outcome |
|---|---|
| `CONT-001`: bootstrap appends facts before Handoff creation | The range ends at `H` pinned before Session birth; none of its own facts enters that range. |
| `CONT-002`: fresh Workstream has no prior facts | `W = H = 0`; verify the native origin and send no empty Handoff. |
| `CONT-003`: restore an older Save into a new Pod | A new Agora Session owns restore/resume and exact refill `(W, H]`, even if the ACP id is reused. |
| `CONT-004`: URI is present but payload differs or the turn is incomplete | No synchronization success; current native input digest and completed incorporation must be established. |
| `CONT-005`: Handoff may be accepted, then its response is lost | Preserve one ambiguous command and gate work; no blind resend on reconnect or notification. |
| `CONT-006`: native compaction or context replacement destroys verifiable lineage | Invalidate evidence and gate admission; a stored receipt never becomes live proof. |
| `CONT-007`: switch A → B → A with A's compatible Anchor | Resume A's native Save in a new Session and refill its missing range. |
| `CONT-008`: permanent Save/target incompatibility versus temporary store outage | Only verified incompatibility excludes the pair; clean fallback uses another Pod/Session and does not loop on the known-bad Save. |
| `CONT-009`: queued product facts were never incorporated at capture | The Save frontier does not simply copy the current journal head; Anchor publication requires a provable nondecreasing frontier. |
| `CONT-010`: stale capture races a newer Anchor at the same watermark | Conditional publication rejects the stale capture and preserves the newer Anchor. |
| `CONT-011`: restore references an unversioned or unavailable workspace dependency | Reject exact resume; no claim that a transcript Save reconstructs missing workspace state. |
| `CONT-012`: context is live but no new Save has committed for many turns | Report native-state loss exposure since the old Anchor; promise no fixed recovery point. |
| `OFF-001`: capture hangs, fails or exceeds its limit | Revoke immediately and terminate after the original bounded preservation budget; retain the old Anchor and record loss exposure. |
| `OFF-002`: controller restarts after Save/Anchor commit | Discover the committed result, continue target cleanup and never reset the shutdown deadline. |
| `OFF-003`: Failed or expired-startup Pod remains with denied grants | Construction marks the incarnation unreusable and selects cleanup before a later capability HOLD can strand it. |
| `OFF-004`: Pod is gone but an Agent, attachment or inactive binding remains | Power stays on and cleanup removes the orphan using exhaustive Workstream attribution. |
| `OFF-005`: force-deleted Pod can still run on a partitioned node | Retain its retirement obligation, cut authority independently and block successor work until physical fencing/termination is proved. |
| `OFF-006`: Kubernetes or OneCLI fails during shutdown | Reachable owners still restrict/clean their resources; no incomplete inventory can prove off. |
| `OFF-007`: provider accepted an operation before revocation | Close existing paths and forbid new requests; preserve uncertainty about the remote effect instead of claiming rollback. |
| `OFF-008`: a partial restore is stopped | Do not capture/publish its unverified native context over the preceding healthy Anchor. |

## Engine concurrency and recovery

Source: [ADR 0003](../adr/0003-reconciliation-over-state.md), the
[engine contract](reconciliation/engine.md) and [spec 13](13-failure-and-idempotency.md).

| Scenario | Required outcome |
|---|---|
| `ENGINE-001`: two complete Intent requests race | Authoring gives distinct increasing sequences, keeps both immutable events and coalesces work onto the latest; identical request-key retries add no event. |
| `ENGINE-002`: same request key is reused with another payload | Reject the conflict; do not reinterpret the old command or Intent. |
| `ENGINE-003`: an old pass converges after a newer Intent commits | Exact conditional finalization fails and the newer work/admission boundary remains intact. |
| `ENGINE-004`: drift re-enqueues the same Intent during finalization | A new work generation survives; comparing only Intent sequence cannot delete it. |
| `ENGINE-005`: a work row is deleted/recreated and an old worker returns | Non-reused generation/claim/epoch values reject the ABA attempt. |
| `ENGINE-006`: a claim expires while its worker is paused in a network call | Transfer blocks new old-owner dispatch and tracks the possibly accepted request before any conflicting effect. |
| `ENGINE-007`: delayed GRANT or Agent creation arrives after off | The old target stays gated, the late effect is discoverable and cleaned, and off cannot finalize while the request remains unresolved. |
| `ENGINE-008`: BUILD response is lost while inventory is still empty | Retain the reserved creation attempt; no second build or false off conclusion can precede resolution. |
| `ENGINE-009`: old TURN_OFF returns after a replacement is authorized | Cleanup uses original UID/Agent targets; it cannot delete by a reused name or reopen/finalize anything for the successor. |
| `ENGINE-010`: every notification is lost, or thousands are duplicated | Polling finds durable due work; duplicates coalesce without bypassing backoff or duplicating effects. |
| `ENGINE-011`: HOLD's watch is lost or a permanent error exhausts retry budget | Durable bounded recheck remains, failure is visible and no unchanged action spins or falsely converges. |
| `ENGINE-012`: finalized live Workstream drifts while absent from the workset | Owner watch or bounded sweep re-enqueues it; scanning active work rows alone fails acceptance. |
| `ENGINE-013`: separate grant reads straddle an external mutation | Reject/reacquire the inconsistent pair; no fabricated attached/effective equality. |
| `ENGINE-014`: context or selected registry revision changes during a tick | Invalidate prerequisite evidence; old resolution cannot mutate/admit/finalize the new target. |
| `ENGINE-015`: action completion races a fresh wake | Its conditional release/backoff update cannot postpone or overwrite newer work; the continuation itself does not invent an Intent revision. |
| `ENGINE-016`: one Workstream repeatedly fails and other due work arrives | Bounded claims/scans and per-row backoff prevent starvation. |
| `ENGINE-017`: off is requested while OneCLI is down or a prior harness definition is retired | Accept the authorized complete off Intent with retained selections and start reachable cleanup; inapplicable execution settings cannot veto extinction. |
| `ENGINE-018`: database work/admission commit succeeds but owner activation fails | Keep execution gated and re-observe; database success is not proof that the current external target is safe to use. |

Exercise these as controlled interleavings with injected process pauses/crashes, owner responses and
clock advances. Abstract table partition checks alone do not establish lease fencing, delivery
idempotency, wake-up liveness or external service conformance.

## Canonical product history

- Journal complete accepted ACP envelopes before controlled dispatch or handling.
- Preserve accepted unknown members and lossless semantic JSON numbers.
- Attribute each execution fact to one Agora Session and one Workstream order.
- Rebuild projections without changing canonical facts or duplicating source content.
- Preserve uncertainty about dispatch; a scheduled outgoing envelope is not proof of receipt.

## Execution identity

- A request superseded before a Pod is established creates no Session.
- Every new Pod establishes a new Session before restore or ACP bootstrap, including failed attempts.
- A retained Pod can span successive Sessions only at the ADR 0007 quiescent boundary.
- A Pod and its dedicated OneCLI Agent never move to another Workstream or Pod incarnation.
- A compatible Save can be restored into a new Session without mutating its producer relationship.

## Security and isolation

- Reject arbitrary image, command, argv, environment and Kubernetes fragments at the runtime API.
- Accept reviewed capability names and reject Browser-supplied provider scopes/OneCLI identifiers.
- Enforce Workstream owner/editor/viewer membership and resource ownership at every boundary.
- Keep provider secrets in OneCLI and upstream Agent bearers in encrypted Broker-private storage.
- Deny Pod access to product storage, Save storage, Kubernetes control, other Pods and direct providers.
- Verify relay confinement derives only from effective OneCLI grants and never injects credentials.
- Verify revocation terminates existing tunnels and prevents subsequent credential-backed requests.
- Exercise auth, grants, relay and Save exclusions for every enabled pinned harness integration.
- Verify product, operational and OneCLI backup/restore independently and without credential leakage.

## Contract gates

The required evidence includes database constraints and concurrency checks, pinned ACP compatibility,
projection rebuild equivalence, external-owner idempotency, failure injection and authorization under
actual service identities. Contracts and tests must use the remodeled Workstream/Pod/Session grains.
An old test that expects a new Pod to retain the same Agora Session identity must be replaced.

## Existing product data

Legacy messages MUST NOT be converted into fabricated ACP facts. Before production cutover, choose
an explicit fresh-data/read-only-archive policy or separately specify an import format through an ADR.
Old native Saves are resumable only after compatibility has been demonstrated; otherwise retain them
under archive policy and start from explicitly supported product history.

## Delivery and go-live

Each implementation plan must identify its normative contracts and scenario ids, update its checklist
and supply the required evidence. A docs-only revision completes a design change, not implementation
acceptance. No plan may implement a stale flat specification or an unaligned schema as an alternative
baseline.

Production cutover requires aligned contracts, demonstrated scenarios, recoverable product and OneCLI
storage, operational failure procedures, retention/deletion policy and an explicit data migration
choice. There is no concurrent writing of two competing product models as equal sources of truth.
