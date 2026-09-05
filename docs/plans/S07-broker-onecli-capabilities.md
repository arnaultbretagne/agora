# S7 — Broker, OneCLI and exact capabilities

- **Status:** planned
- **Depends on:** S5, S6
- **Produces:** `apps/broker`, `packages/policy`, `contracts/api/broker.openapi.yaml`, `contracts/catalogue/{capabilities,grant-mappings}.json`, `packages/observation` grant fields, BUILD/TURN_OFF Broker parts
- **Master plan:** [S7](../master-plan.md#s7--broker-onecli-and-exact-capabilities)

## Goal

The second real owner. One selective OneCLI Agent per Pod incarnation; the trusted compiler turns
the complete capability set into one exact grant set; attached and effective inventories are read
as a consistent pair; GRANT and REVOKE converge the Agent; the relay forwards opaque CONNECT
traffic to OneCLI only, confined by a deterministic projection of the fresh effective grants, and
closes routes and existing tunnels on restriction without waiting for ACP.

## Read first

1. [ADR 0009](../adr/0009-onecli-grant-authority.md), [ADR 0010](../adr/0010-capabilities-are-onecli-grants.md) in full
2. [001 §Capability compilation](../specs/reconciliation/001_intent.md#capability-compilation), [002 §grants and §Exact grant comparison](../specs/reconciliation/002_observation.md#exact-grant-comparison), [006 CAPABILITIES](../specs/reconciliation/006_capabilities.md), [003 verbs](../specs/reconciliation/003_verbs.md) GRANT/REVOKE/BUILD/TURN_OFF
3. [execution: Owners and isolation](../specs/reconciliation/execution.md#owners-and-isolation) (Broker paragraphs), *Harness and owner conformance* (Isolation and OneCLI row)
4. [engine: Effect ownership](../specs/reconciliation/engine.md#effect-ownership-and-late-requests) (the GRANT-after-off example), *Tick and acquisition* (consistent pair)
5. [acceptance: `AUTH-001..009`, `OFF-004`, `OFF-007`, `SESSION-A10`, `ENGINE-013`, `ENGINE-017`](../specs/reconciliation/acceptance.md)
6. Field findings [§3 OneCLI and the relay](../field-findings.md#3-onecli-and-the-relay-slice-s7) **in full**, [§2.2/§2.3 egress hosts](../field-findings.md#22-claude-code), [§6](../field-findings.md#6-methodological-lessons), [§7](../field-findings.md#7-reuse-register)

## Before coding

- **P8, OneCLI capabilities.** Stand up the pinned OneCLI (digest, with persistent `/app/data`
  and PostgreSQL) and verify, recording results in `apps/broker/README.md`: per-Agent
  attached inventory endpoint, `effective-credentials`, Agent listing with stable ids, whether
  Agent creation is idempotent by name, whether a lost creation is discoverable by that name,
  whether grant mutations are conditional. If attached and effective cannot both be read, or a lost
  creation is not discoverable, the integration must retain explicit uncertainty; write that into
  `execution.md` conformance and stop for review before implementing recovery claims.
- **P9, first capabilities and mappings.** Write `contracts/catalogue/capabilities.json` (named
  capabilities, flat) and `grant-mappings.json` (capability → exact OneCLI secret/connection grants
  with tools and approval). Start with the provider-access capabilities the harnesses need
  (`provider.anthropic`, `provider.openai`) and one tool capability. Every mapping is reviewed.
  Model selection adds no implicit grant (`AUTH-009`).
- **P10, relay identity.** Record the chosen mechanism in `execution.md`: source-IP resolution
  against the Pod inventory (measured baseline, findings §3.3) or a stronger workload identity if
  the cluster provides one. Whatever is chosen, the Pod cannot self-assert it.
- Confirm the OneCLI logging posture (findings §3.2): decide `LOG_LEVEL` and record the residual
  exposure; the relay itself never sees query strings.

## Deliverables

```text
contracts/api/broker.openapi.yaml
contracts/catalogue/capabilities.json, grant-mappings.json, onecli-tool-catalogue.json (for 'full' expansion), egress-hosts.json
packages/policy/
  src/catalogue.ts               load + validate catalogue files; revision id = digest of the reviewed set
  src/revision.ts                selected revision set shared by all workers (from deployment config, not local binaries)
  src/compiler.ts                compile(capabilities, revision, principalBindings) → exact set D | typed denial
  src/reachability.ts            deterministic projection: effective grant set → allowed CONNECT hosts (conservative)
apps/broker/
  src/onecli/client.ts           raw REST + pinned SDK where verified: ensureAgent, attach/detach, attached inventory, effective inventory, list, delete
  src/agents.ts                  Agent per Pod incarnation: create ungranted, bind, never rebind, delete on retirement
  src/grants.ts                  GRANT / REVOKE as owner requests with reservation and readback
  src/inventory.ts               attached + effective as a consistent pair (bracket/revalidate; retry inconsistent)
  src/relay.ts                   CONNECT listener; identity per P10; upstream Basic auth to OneCLI; no upstream socket before decision; tunnel registry for closure
  src/private-store.ts           encrypted Broker-private upstream authority; loss closes access
  src/owner-api.ts               OwnerServer + inventories + wakes
  image/Dockerfile
deploy/broker.yaml, onecli/ (Deployment with PVCs, Service, NetworkPolicy)
packages/observation/src/grants.ts      observation.grants.attached / effective
packages/observation/src/power.ts       + Agents, grants, bindings contributions
packages/observation/src/construction.ts + Agent and binding coherence
packages/testkit/src/fake-owners/broker.ts   conformant with the real API and with the measured OneCLI behaviors
```

## Work plan

### Step 1 — Catalogue and compiler

`packages/policy`: load the catalogue files, compute the revision id, expose the `CatalogueView`
S1 expects (replacing the S2 stub). `compile` unions the rights of all selected capabilities before
any difference, emits exact `Authorization` entries (S1 model), binds output and digest to the
revision, refuses unknown capabilities, unrepresentable combinations, approval requirements the
deployment cannot serve and any provider operation OneCLI cannot grant and revoke. It emits no image,
MCP registration or relay policy.

Acceptance: `AUTH-004` (shared grant retained when one capability is removed), `AUTH-008`
(revision change → distinct digest, old attempt keeps its payload), `AUTH-009` (model needing an
absent provider capability is rejected at authoring).

### Step 2 — OneCLI client and Agent lifecycle

Implement against the pinned OneCLI. Agent naming: deterministic from the Pod UID (hyphens only,
findings §3.2), so a lost creation is rediscoverable by name. Create ungranted, in selective mode.
`getContainerConfig` only from the Broker; extract the upstream bearer (the URL **password**;
findings §3.2) into the private store; verify CA and stubs against the reviewed bundle after
normalizing volatile fields (`id_token` signature, `last_refresh`, trailing newline). Never use
`applyContainerConfig` or `onecli run`. Delete the Agent when the incarnation is retired; never
rebind.

Acceptance: contract tests against a live OneCLI in CI (compose or kind): create/list/delete,
lost-creation rediscovery, bundle drift check with the three volatile fields.

### Step 3 — Inventories as a consistent pair

Read attached and effective for the same Agent; if OneCLI exposes a version/cursor, bracket the
pair; otherwise read attached → effective → attached and retry when the two attached reads differ.
Normalize to S1 `Authorization` entries, preserving unknown fields. Denial reasons and restrictions
travel as diagnostics. A failed read produces no set.

Acceptance: `ENGINE-013` (reads straddle an external mutation → reacquire, no fabricated
equality), `AUTH-005` (attachments match, effective denied → HOLD `CAPS-004`, restriction exposed,
no repeated attach), `AUTH-007`.

### Step 4 — GRANT and REVOKE

Owner requests (S5) with reservation, attempt key bound to target Agent and payload digest.
REVOKE first closes affected relay routes and terminates existing tunnels, then detaches or narrows;
unremovable external authority leaves access gated with a typed diagnostic. GRANT attaches only the
missing desired entries after the rule proved no excess; retry rereads OneCLI and never broadens.
Neither depends on ACP health.

Acceptance: `AUTH-001`, `AUTH-002`, `AUTH-003`, `AUTH-006` (partial mutation then crash → readback
finds the difference; recovery targets the same Agent and payload), `SESSION-A10` (ACP unreachable;
revocation still closes the path), `ENGINE-007` re-run with the real owner.

### Step 5 — Relay

Carry the CONNECT relay over (findings §7) and change what must change: identity per P10; the
allow decision comes from `packages/policy/reachability.ts` applied to the **fresh effective set**
of the bound Agent (no independent allow list; unknown or stale mapping closes access); no upstream
socket before the decision; upstream hop authenticates with HTTP Basic using the private store
credential; a tunnel registry so restriction can terminate existing tunnels. The relay never
terminates provider TLS or reads tunneled bytes. Audit rows record tunnel establishment only and say
so.

Acceptance: negative egress test that sends a real request **through** the established tunnel and
asserts 403 from the gateway (findings §3.2); a `Bearer`-auth regression test proving the fake
gateway rejects it (findings §6.2); tunnel termination on REVOKE; `OFF-007` (provider accepted an
operation before revocation: paths closed, uncertainty recorded, no rollback claimed).

### Step 6 — Observation and power/construction contributions

`observation.power` now also counts every Agent (granted or not), every attached or effective grant
and every binding; `observation.construction` requires the unique Pod-bound Agent and binding to be
coherent. BUILD's Broker part creates the Agent and binding for the reserved Pod; TURN_OFF's Broker
part closes routes, revokes and deletes them on the concrete targets.

Acceptance: `OFF-004` (Pod gone, Agent/attachment/binding remains → `power = on`, cleanup by
attribution), `ENGINE-017` (off while OneCLI is down: reachable cleanup proceeds, no `off`
finalization until inventories are complete).

### Step 7 — Deployment

OneCLI Deployment with PVCs for PostgreSQL and `/app/data`, externally supplied encryption key,
ordered allow rules with a terminal `block *` published by the Broker as a configuration invariant
(findings §3.2), Broker Deployment with its own identity, NetworkPolicy allowing harness Pods to
reach only the relay. Backup/restore drill of the three assets documented in S11.

## Reuse

Allowed (findings §7): `relay.ts` structure and `k8s-pod-lookup.ts`, raw REST grant calls verified
on 1.45.0, measured host sets, `live-verification` OneCLI manifests. Forbidden: `grant-service.ts`
(per-Session grants, TTLs), `onecli-agent-reaper.ts`, activation repository.

## Definition of done

- [ ] P8 verification recorded; any OneCLI limitation written as explicit uncertainty in `execution.md`.
- [ ] Catalogue files and compiler with `AUTH-004/008/009`.
- [ ] Consistent-pair inventories; `ENGINE-013`, `AUTH-005/007`.
- [ ] GRANT/REVOKE as owner requests; `AUTH-001/002/003/006`, `SESSION-A10`, `ENGINE-007` (real owner).
- [ ] Relay: through-tunnel negative test, Basic-auth regression, tunnel termination, `OFF-007`.
- [ ] `OFF-004`, `ENGINE-017` on the real owner.
- [ ] Master plan S7 marked done; P8, P9, P10 recorded.

## Report

Give the OneCLI version and digest, the endpoints relied upon, the verified idempotency/discovery
behaviors and the ones that are not available (with the resulting explicit-uncertainty behavior),
and the residual log exposure decision.
