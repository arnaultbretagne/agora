# S10 — Second harness, catalogue publication and A → B → A

- **Status:** merged; see the master plan's S10 status for the one open item
- **Depends on:** S9
- **Produces:** `harnesses/codex` with driver and conformance evidence, catalogue revision publication with durable re-enqueue, `CONSTRUCT-002` replacement, per-harness Anchors exercised
- **Master plan:** [S10](../master-plan.md#s10--second-harness-catalogue-publication-and-a--b--a)

## Goal

Prove the design is not shaped around one harness: a second reviewed image passes the same
conformance suite, a Workstream switches A → B → A and resumes A's own Anchor, and publishing a new
catalogue revision is a first-class wake that replaces live Pods on a re-pinned digest after a
bounded Save.

## Read first

1. [ADR 0006](../adr/0006-complete-harness-images.md) (catalogue resolution, publication), [ADR 0008 §A → B → A](../adr/0008-saves-anchors-and-refill.md)
2. [005 CONSTRUCTION](../specs/reconciliation/005_construction.md) (`CONSTRUCT-002`, re-pinned digest), [007 SESSION](../specs/reconciliation/007_session.md)
3. [engine: Intent authoring and revision selection](../specs/reconciliation/engine.md#intent-authoring-and-revision-selection), *Watches and recovery sweeps* (Registry/compiler policy row)
4. [execution: Harness and owner conformance](../specs/reconciliation/execution.md#harness-and-owner-conformance)
5. [acceptance: `CONT-007`, `SESSION-A11`, `ENGINE-014`](../specs/reconciliation/acceptance.md)
6. Field findings [§2.1, §2.3 codex](../field-findings.md#23-codex), [§2.4](../field-findings.md#24-a-second-prompt-during-a-running-turn), [§3.2](../field-findings.md#32-what-onecli-does-not-provide-and-what-that-costs) (OpenAI host expansion)

## Before coding

- **P3 for codex.** Measure `@agentclientprotocol/codex-acp` as S8 did for claude-code: config
  options (`model`, `reasoning_effort`, `modes`), `set_config_option` behavior, truthful readback
  after resume, second-prompt behavior (findings §2.4: codex never answers the second request;
  the control plane's one-turn rule is what protects us).
- **P11 for codex.** Definition entry: image digest, launch command, `SSL_CERT_FILE` for the Rust
  binary (findings §2.3), model/effort catalogue mapping onto `intent.model`/`intent.effort`
  (Codex exposes reasoning effort under a different option name: the harness definition maps the
  registered Intent fields to the harness's option ids; no new Intent field), bootstrap authority
  `provider.openai`, egress hosts `chatgpt.com`, `auth.openai.com` (findings §2.3).
- **P12 for codex.** Driver contract: the date-partitioned rollout file keyed by the ACP session id
  in its first line; SQLite state and `auth.json` excluded; read-only `onecli-managed` stub.
- **Publication contract.** Extend `engine.md` *Intent authoring and revision selection* with the
  concrete publication procedure: a `revision_publications` row listing affected Workstreams
  (paginated enumeration of the desired-state index, including idle ones), bounded re-enqueue with
  fresh generations, immediate rejection of the obsolete revision at mutation/admission checks.

## Deliverables

```text
harnesses/codex/                 image, bridge (shared code with claude-code moved to packages/harness-bridge if identical), driver, README with P3 measurements
contracts/catalogue/harness-definitions.json  (codex entry), egress-hosts.json (+ openai hosts), grant-mappings.json (+ provider.openai)
contracts/db/schema.sql          "S10 operational — revision_publications, publication_targets"
packages/policy/src/publication.ts   publishRevision(tx, revisionSet) → durable target list + bounded re-enqueue
apps/control-plane/src/http/admin-publish.ts   operator endpoint (authenticated as a service actor) to publish a reviewed revision
packages/engine/src/sweeps.ts    + publication sweep resumes after crash
```

## Work plan

### Step 1 — codex image, bridge and driver

Build the image per ADR 0006 with the same common tool bundle as claude-code. Factor the bridge
into a shared package only if the code is identical apart from env translation; otherwise keep two.
Implement the driver per P12 (findings §2.3). Run the harness conformance suite from S8.

Acceptance: conformance suite green on the codex image; driver round-trip on the real adapter with
only the rollout file restored.

### Step 2 — A → B → A

End to end on kind: Workstream on claude-code with a Save and Anchor; Intent switches `harness` to
codex → `CONSTRUCT-002` tears down after a bounded Save (claude-code Anchor advanced), `CONSTRUCT-001`
builds codex, `SESSION-003` starts fresh, `SYNC-001` cross-seeds `(0, H]`; switch back to
claude-code → `SESSION-002` restores claude-code's Anchor and refills its missing tail.

Acceptance: `CONT-007` as an executed end-to-end test with assertions on Anchors per harness and on
the refilled range.

### Step 3 — Revision publication

`publishRevision` records the new immutable revision set, enumerates affected Workstreams (all with
an on Intent whose harness digest, mappings or policy changed, including Workstreams absent from the
workset), writes `publication_targets`, and re-enqueues them in bounded batches with fresh
generations; the sweep resumes after a crash. Workers read the selected revision from the durable
selection, never from their bundled files (`SESSION-A11`). Mutation and admission checks compare the
revision id and reject an obsolete one immediately.

Acceptance: `SESSION-A11` (two workers on different local catalogues both use the selected revision
or refuse), `ENGINE-014` (revision changes mid-tick: evidence invalidated, old resolution cannot
mutate or admit), publication of a re-pinned claude-code digest replaces a live Pod after a Save
(`CONSTRUCT-002` on same `harness_id`), crash mid-publication resumes and re-enqueues the rest.

## Reuse

Allowed (findings §7): `agents/codex/src/custody.ts` knowledge behind the driver interface, codex
Dockerfile shape, measured host sets. Forbidden: anything from `packages/agent-registry`.

## Definition of done

- [x] codex measured (P3), defined (P11), driver contract (P12) recorded in `harnesses/codex/README.md`;
      conformance suite green on the real adapter: **10 passed, 0 failed, 3 skipped** (11 passed with
      `--allow-model-spend`), the same score claude-code gets.
- [x] `CONT-007` end to end against BOTH real adapters (`scripts/s10-a-b-a.mjs`) and at the rule
      level (`apps/control-plane/test/verbs/harness-switch.test.ts`); `SESSION-A11` and `ENGINE-014`
      in `apps/control-plane/test/admin-publish.test.ts` and `packages/policy/test/publication.test.ts`.
      A re-pinned digest replacing a live Pod is the ordinary `CONSTRUCT-002` path a publication
      wakes; it is exercised as a publication + fresh generation, not on a cluster.
- [x] Publication procedure in `engine.md` (*Publication procedure*); the operator endpoint
      authenticates as a service actor and is closed entirely where none is configured.
- [ ] Master plan S10 marked done — deliberately not, for the same reason S8 and S9 are not: the run
      on real Kubernetes with real OneCLI credentials is a deployment step.

## Report

Versions for codex CLI and adapter, the option mapping chosen for `intent.effort`, publication
batch sizes, and any behavior where codex and claude-code differ under the same rule (expected: none
at the rule layer; list differences confined to the driver and the definition).
