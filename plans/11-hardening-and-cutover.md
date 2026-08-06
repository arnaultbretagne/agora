# P11 — Security hardening, operations and cutover

- **Status:** pending
- **Dependencies:** P05, P07, P08, P09, P10
- **Primary paths:** all deployables, deployment repository/manifests, runbooks

## Required reading

- all normative specs;
- all Accepted ADRs;
- every prior plan's evidence section.

## Deliverables

- Production deployment manifests and independent identities.
- NetworkPolicies/database roles/secrets configuration.
- Production OneCLI, Broker relay and OneCLI operational-store deployment.
- OTel/Loki dashboards, alerts and SLOs.
- End-to-end fault-injection suite.
- Backup/restore and disaster-recovery proof.
- Operator runbooks.
- Explicit legacy-data policy and cutover/rollback plan.
- Decommission checklist for old Agora and `agent-runtime`.

## Tasks

- [ ] Deploy Web, control plane, controller, Broker/relay, OneCLI and Session Runtimes with separate
  identities.
- [ ] Prove least privilege with negative authorization tests.
- [ ] Pin and attest images/dependencies.
- [ ] Pin the OneCLI image by digest and verify its release/source provenance.
- [ ] Persist OneCLI PostgreSQL and `/app/data`; manage `SECRET_ENCRYPTION_KEY` outside both.
- [ ] Prove a compatible backup/restore of OneCLI DB + CA/private key + encryption key.
- [ ] Enforce Session Runtime Pod → relay → OneCLI gateway as the only provider egress path.
- [ ] Verify every published route set ends in explicit `block *`.
- [ ] Prove gateway stdout is query-free and manual approval is disabled on content-bearing routes.
- [ ] Exercise OneCLI control/gateway/relay outage, CA rotation and policy-cache invalidation.
- [ ] Exercise Claude Max and ChatGPT token expiry/renewal without changing custody.
- [ ] Configure resource limits, quotas and admission policy.
- [ ] Implement dashboards/alerts from `12-observability.md`.
- [ ] Exercise every crash boundary and timeout.
- [ ] Prove product+custody backup/restore consistency.
- [ ] Load-test journal, projector, feed, custody and Session Runtime materialization churn.
- [ ] Perform security review and close critical/high findings.
- [ ] Choose fresh database versus separately specified legacy archive/import.
- [ ] Shadow real workloads without dual product truth.
- [ ] Execute staged cutover and rollback rehearsal.
- [ ] Revoke/delete old workloads, credentials and repositories only after acceptance.

## Required tests

Every scenario in `docs/specs/15-acceptance-and-migration.md`, plus:

- node/controller/database/Broker outage;
- OneCLI API/gateway/database outage and Broker relay outage;
- expired/compromised grant;
- leaked/replayed upstream OneCLI bearer from an unrelated workload;
- missing/reordered catch-all rule and direct-egress bypass attempt;
- OneCLI CA/encryption-key loss and restore mismatch;
- duplicate Pod and stuck deletion;
- oversized ACP frame/update flood;
- custody growth/timeout/checksum failure;
- projector lag/rebuild during live ingestion;
- unauthorized cross-user/Session access;
- adapter upgrade and rollback with retained custody;
- OneCLI and Agent route-set upgrade/rollback with secret-leak canaries.

## Non-goals

- No feature expansion during hardening.
- No custom gateway fallback when OneCLI is degraded.
- No silent legacy-data transformation.
- No removal of rollback before the observation window completes.

## Exit criteria

- Operator signs go-live checklist.
- All SLOs/alerts/runbooks are exercised.
- Production rollback is proven.
- OneCLI/relay security blockers from the spike are closed with exercised runbooks.
- Old system decommission is separately approved after stable operation.

## Evidence

**2026-08-06, live production-cluster session (in progress, not yet exit-criteria-complete):**

Deployed `agora-{web,controller,broker}` with separate ServiceAccounts/NetworkPolicies/database
roles to the `agora` namespace, `agora-runs` for Session Runtimes, `agora-onecli` fresh (not a
promotion of the P09/P10 test instance). SSO via oauth2-proxy/Pocket-ID in front of `agora-web`
(`agora.bretagne.dev`), `X-Forwarded-Email` trusted because the NetworkPolicy admits ingress only
from that pod.

A real user-driven "+ New workstream" click (not a synthetic test) found no PVC provisioning path
existed at all — unblocked with a manually-created `pvc-default` (per-Workstream auto-provisioning
deliberately deferred, Arnault's own choice). That test then failed everything, triggering a long
live-debugging arc that found and fixed, each verified against real infra (never just port-forward
— see the NetworkPolicy lesson below), in order:

1. `apps/web`'s `requirePrincipal` only accepted the P05 dev placeholder `Authorization: Bearer`,
   never the real SSO path — added `X-Forwarded-Email` support.
2. `agora-pg` CiliumNetworkPolicy never had ingress rules for the three new services — masked by
   port-forward/kubelet-probe traffic not going through the same Cilium enforcement path as real
   pod-to-pod traffic (methodological lesson, applies broadly).
3. `claude-code`/`codex` registry definitions were `rollout: 'internal'` — flipped to `'enabled'`
   (operator decision, both agents already live-verified in P09/P10).
4. `apps/web`'s equipment-catalogue endpoint/client used hardcoded fake values instead of the real
   `@agora/equipment-policy` catalogue.
5. OneCLI Agent identifier used underscores; the real API requires hyphens only.
6. A stray NUL byte in `grant-service.ts` made git/grep treat the file as binary.
7. The Broker's runtime-bundle drift check compared raw credential-stub bytes, but OneCLI re-signs
   each Agent's `id_token` with a distinct signature (same claims) — normalized before compare.
8. The same drift check also tripped on `last_refresh`, a timestamp that changes on every
   `getContainerConfig` call even for the same Agent — stripped as volatile.
9. The same drift check again on the operator-pinned CA: a YAML `|` block scalar always appends a
   trailing newline; OneCLI's own live response has none — trim before compare.
10. `broker.grant_activations`' idempotency check does `SELECT ... FOR UPDATE`, which requires the
    UPDATE privilege even though no UPDATE is ever issued — the role only had SELECT/INSERT.
11. **The actual root cause of the original report**: `apps/web/src/orchestration.ts` never called
    the Broker's real `POST /v1/execution-grants` — a fixed `FAKE_EXECUTION_GRANT_REF` placeholder
    from before the Broker (P08) existed, never retrofitted. Real issue/renew wiring added
    (`broker-grant-client.ts`, `execution_grant_ref` persisted on `product.sessions`, resume
    renews the Session's one grant rather than reissuing). This alone surfaced five MORE real bugs
    once end-to-end testing reached further than ever before, all found live (none of them
    catchable by the automated suite, which runs against a maintenance/superuser DB role, not the
    real restricted application role):
    - Broker activation was idempotent by `(grant_id, request_id)` only — a resume's fresh
      `request_id` against the same already-activated grant always threw, which would have
      fail-closed every resume. Now idempotent by `workload_identity`, refreshing `expires_at`.
    - `product.sessions`' column-scoped `GRANT UPDATE` never included the new
      `execution_grant_ref` column — "permission denied for table sessions" live.
    - `SessionRuntimeControlError`/`BrokerActivationDeniedError` only surfaced `Problem.title`,
      discarding `.detail` — a bare "unexpected controller error" told nothing; fixing this is
      what made the next two findings visible at all.
    - `agora-controller`'s kube-apiserver egress rule allowed port 443 (the ClusterIP Service's
      own exposed port) instead of 6443 (the real backend port Cilium's `toEntities:
      [kube-apiserver]` actually enforces against) — every materialize silently timed out with no
      Pod ever created. Found by comparing against the OLD system's own already-correct rule.
    - `connectAcpBridge` (apps/web) dials the Session Runtime Pod's IP directly (never proxied
      through the controller) — no NetworkPolicy admitted this on either side.

After all of the above: a real grant is issued, a real `claude-code` Pod materializes, and a real
ACP `initialize`/`session/new` handshake completes (genuine `agentInfo`/`availableCommands` from
the real Claude Agent, not a fake test double).

**Not yet resolved, current blocker**: the actual prompt round-trip fails with `API Error: Unable
to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)` inside the Pod. `relay.ts` is a plain
`node:http` CONNECT tunnel with zero TLS inspection (confirmed by reading it directly) — the
verification failure is almost certainly one hop further, at the OneCLI gateway's own certificate.
The operator-pinned CA in both `agora-onecli-ca` ConfigMaps (`apps/agora`, `apps/agora-runs`) is
identical in both places and matches the value verified earlier this session; the Broker's own
drift check (which compares against this exact same pinned value) passes, since grant issuance
succeeded. Not yet diagnosed further — deliberate checkpoint before going into OneCLI gateway TLS
internals, a different subsystem than the grant-wiring gap this arc was chasing.

Exit criteria (operator go-live signoff, full SLO/alert/runbook exercise, proven rollback, old
system decommission) are NOT yet met — most of this plan's task list is still open. Status stays
`pending`; this Evidence section will keep growing as P11 continues.
