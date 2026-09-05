# Acceptance and migration

These are design and black-box acceptance scenarios for the accepted remodeling ADRs. A documented
scenario is not an executed test. Implementation must align its machine-readable contracts and
provide evidence before claiming the corresponding acceptance gate.

## Exact authority

Source: [ADR 0010](../adr/0010-capabilities-are-onecli-grants.md),
[Capabilities and OneCLI](10-equipment-and-broker.md), and the
[CAPABILITIES rule](reconciliation/008_capabilities.md).

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
