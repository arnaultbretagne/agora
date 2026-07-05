# 0011 — The execution substrate is a birth attribute of the conversation

- **Status**: Accepted (2026-07-05, verrous V1–V3 passés — agent-runtime ADR 0010).
- **Deciders**: Arnault (direction + arbitrations), Claude (design)
- **Amends**: ADR 0007 (anchor custody on the isolated substrate), the ADR 0009 schema (two additive
  columns), ADR 0010 (a new frozen run fact). ADR 0005 (hub history = sole source of truth) and the
  re-seed floor are **unchanged** — they are what makes this cheap.

## Context

Every run today executes in one shared pod: one HOME, one memory limit, one network identity across
all conversations. The platform needs true per-run isolation (nothing telescopes between
conversations), especially with autonomous job-like runs coming (dev loop). The runtime layer grows
two *substrates* (agent-runtime ADR 0010): `shared` (today's pod) and `isolated` (one sandboxed pod
per conversation — a *loge* — in `agent-runs`).

The product question is where "where does it run" lives in the model. Arbitration (Arnault,
2026-07-05): **placement is platform policy, fixed at conversation birth** — not a per-message user
knob. Config-travels-with-messages (ADR 0010) stays about *what* runs (kind/model/effort/agent);
*where* is a property of the conversation.

## Decision

1. **`conversations.substrate`** ∈ {`shared`,`isolated`} — `NOT NULL DEFAULT 'shared'`. Set **at
   birth** by platform policy: `AGORA_SUBSTRATE_DEFAULT` (env, default `shared`), overridable by the
   birth request's `config.substrate` (API-level — operator/tests/future agent profiles; **no UI in
   v1**). Immutable thereafter: changing placement = a new conversation. (The mechanics would tolerate
   a future PATCH — a substrate switch is just a dead anchor, i.e. the ADR 0007 floor — deliberately
   not exposed.)
2. **`runs.substrate`** — copied from the conversation at spawn, frozen: a run *fact* in the ADR 0010
   sense. The journal answers "where did this run execute" forever, even if policy changes later.
3. **spawnSpec** passes `{ substrate: conv.substrate, group: conv.id }`. `group` is an opaque
   co-location key to the runtime layer (it never learns conversation semantics — ADR 0002 holds);
   the manager keeps one loge per group and reuses it across the kill-then-respawn config switch, so
   native `--resume` stays pod-local in the hot path.
4. **Anchor custody (amends ADR 0007).** On `isolated`, the native transcript's survival is
   **manager-mediated**: loge-local while the pod lingers, else injected from the manager's anchor
   store at spawn. A resume whose transcript is gone everywhere fails fast with a **typed 409
   `anchor_transcript_missing`**, which `#spawnFor` maps to the existing one-shot `forceFresh` retry
   (same `retriedFresh` cap — no second automatic attempt). The floor stays re-seed from neutral
   history; **no new invariant, no divergence handling**.
5. **Deletion.** `deleteConversation` best-effort purges the conversation's native session uuids at
   the manager (`DELETE /anchors/:uuid`, from the runs table) after the store cascade; the manager's
   TTL sweep backstops misses.
6. **Wiring.** `SUPERVISOR_URL` now points at the **manager** (a deploy-time manifest change — the
   client code is untouched, the manager API is a strict superset of the supervisor API).

## Consequences

- **UI: none in v1.** The substrate is invisible (a per-conversation badge is possible later, from
  the last run's fact, like the model badge).
- Cache economics are unchanged per substrate (the idleTtl clock and touch flow are identical inside
  a loge). An isolated conversation pays pod-boot latency on reopen (~4–8s to live) — the policy
  default keeps interactive chat on `shared`.
- `docs/runtime-lifecycle.md` gains the substrate axis: the « loge » term, the linger window, the
  anchor-custody path, the 409→floor scenario. The three death detectors are unchanged (a deleted
  loge pod reads as 404 → `dormant`, exactly like a reaped session today).
- Schema: two additive columns (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`), no data migration, no
  fresh-DB.
