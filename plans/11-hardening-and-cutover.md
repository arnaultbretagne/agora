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

- [ ] Deploy Web, control plane, controller, Broker/relay, OneCLI and Loges with separate identities.
- [ ] Prove least privilege with negative authorization tests.
- [ ] Pin and attest images/dependencies.
- [ ] Pin the OneCLI image by digest and verify its release/source provenance.
- [ ] Persist OneCLI PostgreSQL and `/app/data`; manage `SECRET_ENCRYPTION_KEY` outside both.
- [ ] Prove a compatible backup/restore of OneCLI DB + CA/private key + encryption key.
- [ ] Enforce Loge → relay → OneCLI gateway as the only provider egress path.
- [ ] Verify every published route set ends in explicit `block *`.
- [ ] Prove gateway stdout is query-free and manual approval is disabled on content-bearing routes.
- [ ] Exercise OneCLI control/gateway/relay outage, CA rotation and policy-cache invalidation.
- [ ] Exercise Claude Max and ChatGPT token expiry/renewal without changing custody.
- [ ] Configure resource limits, quotas and admission policy.
- [ ] Implement dashboards/alerts from `12-observability.md`.
- [ ] Exercise every crash boundary and timeout.
- [ ] Prove product+custody backup/restore consistency.
- [ ] Load-test journal, projector, feed, custody and Loge churn.
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
- adapter upgrade and rollback with retained custody.
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

To be completed by the implementing agent.
