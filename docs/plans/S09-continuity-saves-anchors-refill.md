# S9 — Native continuity: Saves, Anchors, restore and refill

- **Status:** merged; the end-to-end run on real Kubernetes with real OneCLI is a deployment step (see the master plan's S9 status)
- **Depends on:** S8
- **Produces:** `packages/custody`, custody transport in runtime-control, the claude-code custody driver, RESTORE and REFILL, TURN_OFF capture part, `observation.anchor` and `observation.sync` (non-empty range), the Handoff renderer under a versioned seed policy
- **Master plan:** [S9](../master-plan.md#s9--native-continuity-saves-anchors-restore-and-refill)

## Goal

Shutdown preserves eligible native context within a fixed budget and proceeds regardless; a new
Pod restores the Save, resumes the native context in the **new** Session and refills exactly
`(W, H]`; the opening Handoff is rendered deterministically under a versioned seed policy; loss
exposure is reported honestly. Core never reads Save bytes.

## Read first

1. [ADR 0008](../adr/0008-saves-anchors-and-refill.md) in full, [ADR 0005 §custody](../adr/0005-postgresql-durable-store.md)
2. [continuity](../specs/reconciliation/continuity.md) in full
3. [003 verbs](../specs/reconciliation/003_verbs.md): TURN_OFF (capture), RESTORE, REFILL; [007 SESSION](../specs/reconciliation/007_session.md) `SESSION-002`; [009 SYNC](../specs/reconciliation/009_sync.md)
4. [002](../specs/reconciliation/002_observation.md): `observation.anchor`, `observation.sync`
5. [execution: Shutdown and physical extinction](../specs/reconciliation/execution.md#shutdown-and-physical-extinction), [engine: Prompt delivery](../specs/reconciliation/engine.md#prompt-delivery-and-context-creation) (Handoff paragraph)
6. [acceptance: `CONT-003..012`, `OFF-001`, `OFF-002`, `OFF-008`](../specs/reconciliation/acceptance.md#native-continuity-and-bounded-shutdown)
7. Field findings [§2.2 claude-code](../field-findings.md#22-claude-code) (the one file, the exclusions), [§7](../field-findings.md#7-reuse-register) (custody drivers, `handoff-seed-v1.md`)

## Before coding

- **P12, driver and workspace.** Write into `continuity.md` (*Saves, capture and workspace*) the
  claude-code driver contract: the captured artifact (the single transcript file, findings §2.2),
  the excluded global state, the quiescent-cut procedure, format id/version, size and time limits,
  the workspace dependency classification for the fixed workspace root (which paths are in the
  bundle, which are disposable, which need an immutable snapshot), and how the driver proves the
  exact opening input and lineage (`observation.sync`) including across compaction. Get it reviewed.
- **P13, seed policy.** Write `contracts/policies/handoff-seed-v1.md` afresh under the current
  *Handoff and seed policy* obligations, using the archived draft as a starting point only (findings
  §7): inclusion and order per fact kind, encoding, byte budgets, deterministic truncation with
  manifest, resource access, the `fidelity=degraded` confirmation rule and its interaction with
  shutdown. Pin its revision id.
- **P14, retention (first values).** Grace periods for unreferenced Saves and partial staging;
  what Workstream deletion must extinguish first. Record in `continuity.md` *Storage and retention*.
- Roles: `agora_custody_meta` (metadata read), `agora_custody_payload` (bytes, runtime-control's
  transport only). Web and Pods have no payload access.

## Deliverables

```text
contracts/db/schema.sql          "S9 custody — saves (metadata), save_payloads (bytes, separate role), anchors, save_invalidations"
contracts/schemas/save-metadata.schema.json, opening-descriptor.schema.json, handoff-command.schema.json
contracts/policies/handoff-seed-v1.md
packages/custody/
  src/saves.ts                   capture key binding, atomic visibility after checksum, immutable metadata
  src/anchors.ts                 one per (workstream, harness_id); conditional publication with expected previous; monotonic frontier
  src/invalidations.ts           append-only evidence; exact Save/driver pair exclusion; temporary failure excludes nothing
  src/compatibility.ts           Anchor metadata vs observed harness definition
  src/driver.ts                  CustodyDriver interface: capture(quiescentCut) → bytes+frontier; restore(bytes) → placement; proveOpening(descriptor) → evidence
  src/payload-store.ts           streamed write/read under the payload role
apps/runtime-control/src/custody-transport.ts   place and verify bytes before launch; partial placement cleaned under the same attempt
harnesses/claude-code/src/driver.ts             the claude-code CustodyDriver (transcript file, exclusions, checksum, opening proof)
apps/control-plane/
  src/verbs/turn-off.ts          + quiescence attempt, eligible capture, conditional Anchor advance, then termination regardless
  src/verbs/restore.ts           select Save → transport → session/resume → bind to the new Session; no Handoff
  src/verbs/refill.ts            commit or recover the one opening Handoff for (W, H]; same admission barrier minus sync
  src/handoff/renderer.ts        canonical facts (or a projector proved complete through H) → deterministic Handoff resource; digest
  src/descriptor.ts              opening descriptor completed idempotently (origin, Save/W or 0, H, policy revision, command id)
packages/observation/src/anchor.ts, sync.ts (non-empty range from driver evidence)
```

## Work plan

### Step 1 — Schema and custody package

`saves (id, workstream_id, session_id producing, harness_id, format_id, format_version, driver_revision, image_digest, byte_length, checksum, frontier_w, seed_policy_revision, native_origin jsonb, workspace_deps jsonb, created_at; immutable)`,
`save_payloads (save_id pk, bytes bytea)` under the payload role, `anchors (workstream_id, harness_id, save_id, frontier_w, published_at; pk (workstream_id, harness_id))`,
`save_invalidations (save_id, driver_revision null, cause, verifier, target, at)`. No consumer or
`restored_into` column anywhere. Capture key `(pod_uid, process_generation, context_id, frontier_w, driver_revision)`
unique: repeating discovers the same Save; a different payload under the key is a conflict.
Publication: `UPDATE anchors … WHERE save_id = expected_previous` (or insert when none) and
`frontier_w >= current`, rejecting equal frontiers from a stale capture (`CONT-010`).

Acceptance: role tests (payload role only reads bytes), `CONT-009` (frontier is what the driver
proved, not the journal head), `CONT-010`.

### Step 2 — Driver and transport

Implement `CustodyDriver` for claude-code from P12. Capture only at a quiescent cut (no turn in
flight, process idle), read the single transcript, exclude everything else, compute checksum and
the provable frontier. Restore places the file at the harness's expected path for the fixed
workspace slug before the gate is released; partial placement is cleaned or resumed under the same
attempt, never over unrelated state. Runtime-control streams bytes from the payload store; the Pod
has no store access.

Acceptance: driver round-trip on the real adapter (kill process, restore into a fresh home,
`session/resume`, codeword recalled; findings §2.2), partial placement recovery, `CONT-011`
(missing or unversioned workspace dependency → exact resume rejected).

### Step 3 — TURN_OFF with bounded preservation

Extend the verb: persist concrete targets and the original shutdown deadline; close admission;
start relay closure and revocation immediately (S7); attempt quiescence and eligible capture within
the fixed budget; commit the Save, then conditionally advance the Anchor; then terminate with bounded
grace **whether or not** capture succeeded; record loss exposure when it did not. Restart never
resets the deadline (`OFF-002`). An unverified restore or unsynchronized context is ineligible for
publication (`OFF-008`).

Acceptance: `OFF-001` (capture hangs → revoke immediately, terminate at the budget, old Anchor kept,
loss recorded), `OFF-002`, `OFF-008`.

### Step 4 — `observation.anchor` and RESTORE

`anchor.ts`: fresh read of the Anchor for `(workstream, harness_id of the observed Pod)` and the
Save's non-opaque metadata, joined with the harness definition; `compatible` only without verified
invalidation and with accepted format/driver/persona/workspace; else `none`. `restore.ts`: after
authority is verified, select the Save, transport it, initialize ACP, `session/resume` for the native
context, bind it to the **new** Session with origin watermark `W`; deliver no Handoff. Permanent
verified incompatibility appends an invalidation for the exact pair and lets cleanup proceed;
temporary failure or ambiguous response invalidates nothing (`CONT-008`). No restore-to-start switch
inside the failed Session.

Acceptance: `CONT-003` (older Save into a new Pod: new Session owns restore, reused ACP id is fine),
`CONT-008`, `CONT-007` prepared (per-harness Anchors; exercised in S10).

### Step 5 — Descriptor, renderer, REFILL and `observation.sync`

`descriptor.ts` completes the opening descriptor idempotently (origin Session/Pod, verified
process/context, Save and `W` or `0`, `H` pinned at birth, policy revision, command id, digest once
rendered). `renderer.ts` folds canonical facts in `(W, H]` under the seed policy into the ACP
embedded resource content with URI `agora://workstreams/{workstream_id}/handoffs/{command_id}`;
byte-identical for the same inputs; never reads the current head. `refill.ts` dispatches the
Handoff as a `handoff` command under the S4 reservation discipline and the S8 admission barrier
minus its own prerequisite; an empty range dispatches nothing. `sync.ts` yields `current` only from
driver evidence of the exact input, completed incorporation and continuing lineage; `stale` only
with positive absence and no unresolved delivery; otherwise no value.

Acceptance: `CONT-004` (URI present but payload differs or turn incomplete → no `current`),
`CONT-005` (Handoff variant: possibly accepted, response lost → one ambiguous command, gated, no
resend), `CONT-006` (compaction breaks lineage → invalidated, gated), `CONT-012` (long-lived context
with old Anchor → loss exposure reported), renderer determinism across runs and locales.

### Step 6 — End to end

On kind + OneCLI with the claude-code image: converse, set `power = off` (Save captured, Anchor
advanced, Pod gone, Agent deleted), set `power = on` (new Pod, new Session, restore, resume, refill
of the facts appended while off, `SYNC-002`, first user prompt admitted).

## Reuse

Allowed (findings §7): `agents/claude-code/src/custody.ts` knowledge (path, exclusions, checksum,
session id from payload) behind the new driver interface; `handoff-seed-v1.md` as a draft input.
Forbidden: bridge-embedded capture endpoints, `restoreFrom` credentials in the PodSpec.

## Definition of done

- [x] P12 (continuity.md — Registered driver: claude-code), P13 (`contracts/policies/handoff-seed-v1.md`),
      P14 (continuity.md — Retention, first values); the policy revision `handoff-seed-v1` is pinned.
- [x] Custody schema with separate payload role; capture key uniqueness; conditional publication.
- [x] Named scenarios: `CONT-002, 003, 004, 005 (handoff), 006, 008, 009, 010, 011`, `OFF-001, 002, 008`.
      `CONT-007` (A → B → A) stays prepared, not exercised: it needs the second harness, which is S10.
      `CONT-012` (loss exposure over many turns) is recorded by the `shutdowns` row rather than
      reported through observation yet — the material is there, the surfacing is S12's.
- [x] Driver round-trip on the real adapter (`harnesses/claude-code/measure/custody-round-trip.mjs`).
- [x] End-to-end off/on with refill against the real adapter, driver, transport and database
      (`scripts/s9-end-to-end.mjs`); NOT on kind, which needs a cluster this environment has none of.
- [ ] Master plan S9 marked done — deliberately not, for the same reason S8 is not.

## Report

State the Save format id/version and limits, the seed policy revision, what the driver proves and
does not prove (the spec's own list: no lossless retention, no semantic understanding), and the
measured capture and restore durations.
