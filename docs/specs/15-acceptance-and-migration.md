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
