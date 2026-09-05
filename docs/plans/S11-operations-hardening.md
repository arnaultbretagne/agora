# S11 — Operations, retention and hardening

- **Status:** planned
- **Depends on:** S10
- **Produces:** pinned deployment settings proved by the conformance suite, retention jobs, metrics and dashboards, supply-chain review, deployment packaging, security review, backup/restore drill
- **Master plan:** [S11](../master-plan.md#s11--operations-retention-and-hardening)

## Goal

Turn "it works on kind" into something an operator can run: every timing the specs leave open is
pinned and proved under a controllable clock; retention runs; telemetry is safe; images have
provenance; the three OneCLI assets are backed up and restored once for real.

## Read first

1. [engine: Retry budgets and fairness](../specs/reconciliation/engine.md#retry-budgets-and-fairness), *Watches and recovery sweeps*
2. [execution: Harness and owner conformance](../specs/reconciliation/execution.md#harness-and-owner-conformance) (logs paragraph, pinned artifacts)
3. [continuity: Storage and retention](../specs/reconciliation/continuity.md#storage-and-retention)
4. [ADR 0005 §Consequences](../adr/0005-postgresql-durable-store.md), [ADR 0006 §Consequences](../adr/0006-complete-harness-images.md)
5. [acceptance: Validation boundary](../specs/reconciliation/acceptance.md#validation-boundary)
6. Field findings [§3.2](../field-findings.md#32-what-onecli-does-not-provide-and-what-that-costs) (CA persistence, backup assets, stdout), [§4](../field-findings.md#4-kubernetes-and-network-slice-s6), [§6](../field-findings.md#6-methodological-lessons)

## Before coding

- **P7, final values.** Collect every timing and budget introduced since S2 (claim duration and
  renewal, evidence freshness windows per source, action deadlines, startup and shutdown deadlines,
  preservation budget, retry caps, backoff cap and jitter, resynchronization and sweep intervals,
  publication batch size) into `contracts/catalogue/runtime-settings.json` with one line of
  rationale each. Add to `engine.md` the sentence that these are the pinned values the conformance
  suite proves.
- **P14, final retention values.** Saves referenced by Anchors or in-flight restores, latest
  successful Save per retained producing Session, grace for unreferenced generations and partial
  staging, Workstream deletion order (extinguish → recovery material → private artifacts).

## Deliverables

```text
contracts/catalogue/runtime-settings.json, retention-settings.json
packages/engine/src/settings.ts          typed loader; no defaults in code
packages/testkit/src/conformance/timing.test.ts   every setting exercised under the controllable clock
apps/control-plane/src/retention.ts      sweeps per continuity.md; never deletes still-required material
apps/*/src/telemetry.ts                  structured logs with the allowed correlation set only; metrics per boundary
deploy/                                  Kustomize overlays (dev, staging); per-deployable identity, limits, PodDisruptionBudgets; OneCLI with PVCs and external key
.github/workflows/                       image build with digest pinning, SBOM and provenance attestation; nightly end-to-end
docs/operations/
  runbook.md                             deploy, rotate, back up and restore the three OneCLI assets, drain a node, handle an unresolved retirement obligation
  security-review.md                     trust boundary walk-through with evidence links
```

## Work plan

### Step 1 — Settings and timing conformance

Replace every literal timing in the code with the typed settings. Write conformance tests that,
under the controllable clock, prove: a lease cannot be reclaimed by clock skew; backoff never
exceeds its cap; the preservation budget is not extended by retries or restarts; the security
closure (relay/revocation) is not delayed by action backoff; a HOLD row is rechecked within its
bound; an exhausted budget is visible and does not spin.

Acceptance: one test per setting, failing when the setting is violated (falsification).

### Step 2 — Retention

Implement the sweeps from *Storage and retention*: unreferenced Saves past grace, partial staging,
Workstream deletion pipeline (refuse while execution is not extinguished). `DELETE /v1/workstreams/{id}`
arrives here, as an Intent to `power = off` followed by deletion once `POWER-001` converged.

Acceptance: an anchored Save is never deleted; deletion of a Workstream with a live Pod is refused
until extinction; invalidation never deletes still-required material.

### Step 3 — Telemetry

Structured logs carry only actor, Workstream, Session, target, revision, rule id, verb, outcome and
error class. A redaction test feeds a fake prompt, tool result, bearer, query string and Save bytes
through every log path and asserts none appears. Metrics: claims, ticks, evaluations by rule and
result, attempts by state, HOLD causes, owner request latency and rejection reasons, unresolved
obligations, `unknown` dispatches. Health and readiness reflect owner connectivity.

### Step 4 — Supply chain and images

Every deployable and harness image built in CI, pinned by digest in the catalogue and manifests,
with SBOM and provenance attestation; a change to the common tool bundle rebuilds and re-runs the
conformance suite for every harness; image startup cost recorded.

### Step 5 — Deployment packaging and OneCLI operations

Kustomize overlays; OneCLI Deployment with persistent `/app/data` and PostgreSQL, external
`SECRET_ENCRYPTION_KEY`, terminal `block *` published and asserted at startup (findings §3.2);
decide and document the OneCLI `LOG_LEVEL` posture. Perform and record a real backup and restore of
the three assets: credentials still inject after restore, CA unchanged, running Pods keep TLS
validation (findings §3.2).

### Step 6 — Security review

Walk every trust boundary in `execution.md` *Owners and isolation* against the deployed system:
Pod has no token, no store access, no direct egress; Broker holds the control key and nothing else
holds it; control plane cannot reach Kubernetes or OneCLI; payload role isolated; bridge and relay
authentication; log redaction. Record evidence links per bullet in `docs/operations/security-review.md`.
Fix what fails before marking done.

## Reuse

Findings only; no archived operational code.

## Definition of done

- [ ] All settings pinned in catalogue files and proved under the controllable clock.
- [ ] Retention sweeps and Workstream deletion pipeline tested.
- [ ] Redaction test green on every log path; metrics exposed.
- [ ] Images pinned with SBOM and provenance; bundle change rebuilds all harnesses.
- [ ] Backup/restore drill performed and recorded; `block *` invariant asserted at startup.
- [ ] Security review with evidence per boundary; master plan S11 marked done.

## Report

Table of pinned settings with rationale; drill timings; residual risks explicitly accepted by the
operator (for example, unresolved obligations on partitioned nodes, OneCLI stdout posture).
