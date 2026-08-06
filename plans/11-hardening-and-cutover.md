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

**The remaining blocker turned out to be three more real bugs, all now fixed — the flow works
end to end.** The `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` was never a CA problem at all:

12. `relay.ts` required an `X-Workload-Identity` header its own module doc assumed a service mesh
    sidecar would inject. This cluster has no mesh, so nothing ever set it and every real CONNECT
    failed closed. Replaced with source-IP-derived identity resolved against the Kubernetes API
    (`k8s-pod-lookup.ts`, read-only `get`/`list` pods) — unforgeable by the Pod itself, chosen over
    Pod self-assertion after an explicit operator decision.
13. `AGORA_BROKER_RELAY_ENDPOINT` was declared `https://` while `relay.ts` serves a plain
    `node:http` CONNECT listener (the control API on 8443 beside it was already correctly
    `http://`). Every Agent attempted a TLS handshake against a plaintext port.
14. The gateway credential was extracted from the wrong half of OneCLI's proxy URL
    (`http://x:aoc_…@gateway` — username is a dummy, the token is the password), AND sent as
    `Proxy-Authorization: Bearer` where OneCLI's gateway speaks HTTP **Basic**. Critically, the
    gateway does not reject unrecognized auth — it silently degrades to unauthenticated
    passthrough: no TLS interception, no provider-credential injection, and a bare `401` reaches
    the Agent. Proven by peer certificate: `Bearer` -> the provider's own public cert;
    `Basic base64(x:token)` -> a cert issued by "OneCLI Local Gateway CA". That is also what
    finally justifies the operator-pinned CA mounted into every Pod.

**Verified live, full user path**: `POST /v1/workstreams` through the real SSO gate -> real Broker
grant -> real Pod in `agora-runs` -> ACP handshake -> relay -> OneCLI gateway (injecting the real
Claude Max credential) -> Anthropic -> a real reply ("Hello! Hope you're having a good day."),
turn `completed`.

**Two methodological lessons, both of which cost real hours here and generalize:**
- *A manual reproduction that does not travel the same path as the real client proves nothing.*
  Every probe written while chasing this used a raw TCP socket plus a hand-written CONNECT, which
  bypassed precisely the broken step — so the CA chain kept "proving" correct while the real binary
  kept failing. `curl` had been reporting `wrong version number` (the textbook TLS-to-plaintext-port
  error) the entire time.
- *A test double written to match our own implementation cannot catch our own implementation being
  wrong.* `onecli-fake-gateway.ts` accepted `Bearer` because that is what our relay sent; 50 relay
  tests passed green against code that could never work in production. Both fakes now enforce what
  was verified against the real product.

**On the spike gap** (worth recording plainly): `agents/claude-code/SPIKE.md` states in its own
gates (lines 65-67) that it was NOT re-proven inside a real Kubernetes Pod, and its topology
(lines 42-55) points `HTTPS_PROXY` directly at the OneCLI gateway with the bearer embedded in the
URL. It therefore never exercised `relay.ts` at all — not the scheme, not the credential
extraction, not the auth scheme. The spike validated OneCLI + Claude Max + CA (genuinely, and that
part held up), but a spike that bypasses the component we are writing does not validate that
component. Future spikes should be scoped against the real seam, or say loudly which seam they are
standing in for.

**Egress enforcement: verified working, and a documented trap.** A P11 probe briefly concluded the
route allowlist had never been enforced — that conclusion was WRONG and is recorded here because
the trap is easy to fall into twice (it is the same layer-mismatch mistake as the relay-scheme bug
above, made again within the same session).

OneCLI's gateway answers `200 OK` to EVERY CONNECT regardless of the allowlist, MITMs the TLS (peer
certificate issued by "OneCLI Local Gateway CA" — which is what the operator-pinned CA mounted into
every Pod exists to trust), and enforces the rules against the HTTP request INSIDE the tunnel.
Measured live, same Agent, same credential, real request sent through the established tunnel:

| host | CONNECT | request inside tunnel |
| --- | --- | --- |
| `api.anthropic.com` (allow-listed) | 200 | 404 from the real upstream — reached it |
| `http-intake.logs.us5.datadoghq.com` | 200 | **403** — blocked by the terminal `block *` |
| `example.com` | 200 | **403** — blocked by the terminal `block *` |

So `route-policy.ts`'s compiled allow/`block *` set IS effective, and the real `claude` binary's
own telemetry call to Datadog was in fact blocked in production. Two durable consequences:
`broker.security_audit`'s `relay.connect`/`approved` rows record tunnel establishment ONLY and must
never be read as an egress audit trail; and any future egress check must send a real request
through the tunnel rather than stopping at the CONNECT status line. Both are now documented at the
code sites (`route-policy.ts`, `relay.ts`).

Operator decision (2026-08-06): tightening egress further is deliberately DEFERRED — the current
containment (Cilium restricts the Pod to the relay; the gateway enforces the host allowlist) is
judged adequate for now, and the platform's own Cilium primitives are the preferred fallback if
OneCLI-side enforcement ever proves insufficient, rather than reimplementing filtering in
`relay.ts` against `docs/specs/10`'s delegation.

Exit criteria (operator go-live signoff, full SLO/alert/runbook exercise, proven rollback, old
system decommission) are NOT yet met — most of this plan's task list is still open. Status stays
`pending`; this Evidence section will keep growing as P11 continues.
