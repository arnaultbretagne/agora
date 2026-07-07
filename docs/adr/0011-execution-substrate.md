# 0011 — The execution substrate is per-spawn platform policy, not conversation state

- **Status**: Accepted (2026-07-06). **Supersedes its own original decision** (2026-07-05, below):
  substrate was first modelled as a birth attribute of the conversation; that was reversed after the
  runtime-isolation-plan shipped and we saw the model didn't hold up.
- **Deciders**: Arnault (direction + arbitrations), Claude (design)
- **Amends**: ADR 0007 (anchor custody on the isolated substrate — unchanged by this revision). ADR
  0005 (hub history = sole source of truth) and the re-seed floor are **unchanged** — they are what
  make substrate switching cheap and lossless.

## Context

The runtime layer has two *substrates* (agent-runtime ADR 0010): `shared` (one dense pod, many
conversations) and `isolated` (one gVisor-sandboxed pod per conversation — a *loge* — in
`agent-runs`). The product question is where "where does it run" lives in the model.

The **original decision (2026-07-05)** answered: placement is a birth attribute of the conversation —
`conversations.substrate` set at birth, `runs.substrate` copied as a frozen fact, immutable
thereafter. We shipped it, verified the isolated path end-to-end, then reviewed the model with fresh
eyes and it fell apart on three counts:

- **It contradicts the point of sandboxing.** If a conversation "is" isolated as an identity it
  carries, the natural next step is letting it choose — but a sandbox whose occupant picks its own
  sandboxing is not a sandbox. The isolation decision must sit *above* the thing being isolated.
- **It froze a policy *output* as an identity.** "Where it ran" isn't what a conversation *is*; it's
  the result of a platform decision applied at a moment. Freezing it blocked the useful case
  (retroactively isolating an existing conversation) for no benefit, and created a permanent
  no-op exception (a conversation could never change substrate).
- **`runs.substrate` was written and never read.** The manager routes by its own live-state map
  (rebuilt from the cluster), never from agora's DB. The column drove no decision — a stored fact
  that *looks* meaningful ("this run was isolated ⇒ safe") but conflates placement with safety.

## Decision

"Substrate" was one word for **three different things**. Separate them:

1. **Placement** — which pod a run physically executes in. Owned entirely by the **manager**,
   ephemeral, reconstructed from live cluster state (its `runLocations` map). Agora reads it never.
   → **stored nowhere in agora.**
2. **Isolation policy** — "should this run be isolated or shared?". A **platform** decision, evaluated
   **per spawn**, that the running content can never influence. → a **computed function** in the hub
   (`resolveSubstrate(conv, platformDefault)`), today just the `AGORA_SUBSTRATE_DEFAULT` global. Its
   result flows into the spawn payload (`{ substrate, group }`) and the liveness settle-window choice,
   then is forgotten. **Never read from the request body** — `POST /api/conversations` no longer
   accepts `config.substrate` (closes a self-elevation path: a loge has egress to the hub).
3. **Capability / equipment** — how a sandbox is outfitted (which token, what read/network access).
   The *only* thing that could legitimately become durable run-state, **if** it ever varies per run,
   because then "what could this run touch" is a real audit fact. It is **orthogonal to placement**
   and must be modelled as itself, not as a placement string. Today every loge is outfitted
   identically (one `claude-oauth-token`) → **nothing to store; not built.**

Concretely:

- **Drop `conversations.substrate` and `runs.substrate`** (`ALTER TABLE … DROP COLUMN IF EXISTS`,
  in-place, no data loss beyond the meaningless value; pre-existing conversations are untouched).
- **`spawnSpec`/`POST /sessions` keep `{ substrate, group }`** — that boundary is correct: it is where
  the resolved policy *enters* the runtime layer. `group` stays the opaque per-conversation
  co-location key (the manager keeps one loge per group, reused across the kill-then-respawn config
  switch so native `--resume` stays pod-local). agent-runtime is **unchanged**.
- **Anchor custody (ADR 0007) unchanged.** A resume whose transcript is gone everywhere still fails
  with the typed `409 anchor_transcript_missing` → one-shot `forceFresh` → re-seed floor.

## Consequences

- **Substrate switching is now free and lossless.** Because placement isn't pinned, the platform can
  isolate a previously-shared conversation (or vice versa) at any spawn. Cross-substrate resume falls
  to a cold re-seed (the two substrates' native transcripts live on PVCs the manager's custody
  doesn't bridge) — zero data loss (ADR 0005 floor), just a slower first turn. The failure-detection
  mechanics differ by direction (isolated has the explicit 409; shared misses via `transcriptBase`
  and re-seeds) — verify before relying on switching in anger.
- **The concept dissolves at its logical end.** If the policy is constant ("always isolate"),
  `shared`/`isolated` stops being a product distinction at all — it collapses to "the platform runs
  agents in sandboxes, period," i.e. pure infra invisible to the product. The shared/isolated duality
  was only ever meaningful as a *transition* state.
- **UI: none.** Substrate was never user-facing and now is not model-facing either.
- `docs/runtime-lifecycle.md` keeps the « loge » vocabulary and the anchor-custody/linger mechanics,
  but frames substrate as per-spawn policy rather than a conversation attribute.

## Superseded original decision (2026-07-05), kept for history

> `conversations.substrate` ∈ {shared,isolated} NOT NULL DEFAULT 'shared', set at birth by platform
> policy (`AGORA_SUBSTRATE_DEFAULT`, overridable by the birth request's `config.substrate`), immutable
> thereafter. `runs.substrate` copied from the conversation at spawn, a frozen run fact. — Reversed
> because placement is manager-owned ephemeral state (never read from agora), and freezing a policy
> output as a conversation identity both contradicts sandboxing and blocks retroactive isolation.
