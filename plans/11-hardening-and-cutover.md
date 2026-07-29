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
- OTel/Loki dashboards, alerts and SLOs.
- End-to-end fault-injection suite.
- Backup/restore and disaster-recovery proof.
- Operator runbooks.
- Explicit legacy-data policy and cutover/rollback plan.
- Decommission checklist for old Agora and `agent-runtime`.

## Tasks

- [ ] Deploy Web, control plane, controller, Broker and Loges with separate identities.
- [ ] Prove least privilege with negative authorization tests.
- [ ] Pin and attest images/dependencies.
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
- expired/compromised grant;
- duplicate Pod and stuck deletion;
- oversized ACP frame/update flood;
- custody growth/timeout/checksum failure;
- projector lag/rebuild during live ingestion;
- unauthorized cross-user/Session access;
- adapter upgrade and rollback with retained custody.

## Non-goals

- No feature expansion during hardening.
- No silent legacy-data transformation.
- No removal of rollback before the observation window completes.

## Exit criteria

- Operator signs go-live checklist.
- All SLOs/alerts/runbooks are exercised.
- Production rollback is proven.
- Old system decommission is separately approved after stable operation.

## Evidence

To be completed by the implementing agent.
