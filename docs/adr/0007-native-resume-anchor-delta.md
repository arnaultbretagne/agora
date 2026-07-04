# ADR 0007 — Native resume as a fidelity fast-path over re-seed (the "anchor + delta" model)

## Status

Accepted — 2026-07-04 (implementation green-lit as a staged plan; empirically validated 2026-07-02,
see *Validation*). **Amends, does not supersede, ADR 0005**: the hub-owned neutral history stays the
**sole source of truth**; this ADR adds an *optional* native-resume fast-path on top of it, and folds
re-seed and resume into a single mechanism. The persisted `natives` handle map lands in the Postgres
schema of ADR 0009 from day one.

## Context

ADR 0005 **dropped `--resume`** for channel conversations and made re-seed the only reopen mechanism. Its
factual basis was the 2026-06-30 spike, which — with the **then-current** `--dangerously-load-development-channels`
mechanism — found that channel sessions wrote **no transcript**, that **inbound channel events were not
recorded** (GitHub #55896), and that there was **no resume** for a channel-driven session. On those facts,
"resume is impossible" was correct.

**Those facts no longer hold.** Re-tested 2026-07-02 against the **productised `--channels plugin:…`**
mechanism (claude 2.1.197 *and* 2.1.198, in the real runtime pod):

- a channel session **does write a full native transcript** (`~/.claude/projects/<cwd>/<uuid>.jsonl`),
  including the agent's `thinking` and `tool_use`/`tool_result` blocks, persisted on the PVC across pod
  restarts;
- `claude --resume <uuid> --channels …` **reattaches the channel, accepts a new inbound push, and answers
  in the restored context** (the resumed runtime recalled a keyword delivered *only* over the channel in
  the prior, killed runtime).

So the premise "`--resume` cannot work for channel convs" is empirically dead. Meanwhile re-seed carries a
real, permanent fidelity cost: it replays a **flattened, role-tagged text** of the hub history — whole
user-facing turns only, **no reasoning, no tool structure** — and **truncates at `MAX_SEED_TURNS = 80`**.
For a same-harness reopen where the native transcript still exists, resume is strictly higher-fidelity and
cheaper to maintain (no replay to build).

We do **not** want to trade away what ADR 0005 bought: harness-neutrality, PVC-independence, and the hub
as the complete record. So the question is not "resume *or* re-seed" but "**can resume be a fast-path that
degrades gracefully to re-seed**".

## Decision

**Keep the hub's neutral history as the sole source of truth (ADR 0005 unchanged). Add native resume as a
fidelity fast-path, and unify it with re-seed under one "anchor + delta" reopen model.**

Every reopen — same harness or not — does the same three things:

1. **Pick the best anchor for the target harness.** Persist, per conversation, a native-handle map:
   ```
   natives: { "<kind>": { sessionId: "<native uuid>", syncedSeq: <int> } }
   ```
   The anchor is the handle whose native session is still restorable, and `syncedSeq` is the hub `seq` up
   to which that native session is a faithful copy of the history.
2. **Restore the anchor.** If a valid handle exists **and** its transcript is still present, spawn with the
   harness's native resume (`--resume <uuid>` for `claude`; the equivalent for another kind). Otherwise
   spawn a **fresh** runtime. Either way we then…
3. **Flat-inject the delta** = the hub turns *after* `syncedSeq` **plus** the new unanswered messages,
   pushed over the channel exactly like today's seed. After the runtime produces its reply, update that
   harness's handle: `sessionId` (unchanged if resumed, new if fresh) and `syncedSeq = conv.seq`.

**Cross-seed is not a separate path — it is `anchor = 0`.** Reopening on a *different* harness (or when the
transcript is gone) means no valid handle for that kind → fresh runtime → the delta is the *entire*
history → this is precisely the ADR 0005 re-seed. Classic resume is the other extreme (`syncedSeq = seq-1`,
delta = one message). Same code; only the starting anchor differs.

**Where the harness-specific knowledge lives.** The resume flag is emitted by the **per-kind spawn recipe**
(`website/lib/supervisor.js` `spawnSpec`), which already owns the `--channels`/`--allowedTools` wiring. The
**supervisor stays dumb** (ADR 0002/0003): it still just forwards argv. Adding resume to a new kind =
extending its recipe, nothing else.

**Fresh spawns pin the session id.** `spawnSpec` passes `--session-id <uuid>` on a fresh spawn (a uuid the
hub generates and stores as the handle), so the hub **owns** the conv→transcript mapping instead of
scraping claude's self-chosen uuid.

**Resume is optimistic and always degradable.** We attempt resume; if the runtime dies immediately
(missing/renamed transcript — claude prints *"No conversation found with session ID"* and exits) the hub
falls back to **fresh + full re-inject**. Re-seed is the correctness floor; resume is *only ever* a
fast-path over it.

**Out of scope (decided):** history **divergence**. Editing/deleting/summarising a past turn would make a
native transcript lie, and would force anchor invalidation. We **do not** support editing past turns (the
operator never does it), so we do **not** track divergence. If that changes, the fix is: any mutation at a
`seq ≤ syncedSeq` drops the affected handles (next reopen cross-seeds from the edited truth).

## Rationale

- **Fidelity where it's free.** A same-harness reopen restores the agent's own reasoning and tool results,
  not a lossy text flattening, and escapes the 80-turn cut — at *lower* cost (no replay assembled).
- **One mechanism, two extremes.** Folding cross-seed and resume into "anchor + delta" means there is no
  second code path to keep correct; cross-harness portability (ADR 0005's core win) is the `anchor = 0`
  case and is preserved by construction.
- **Neutral history still rules.** The hub history remains what every client shows and the only thing that
  *must* survive; the native transcript is a disposable accelerator. Lose the PVC and you lose speed, never
  correctness.
- **Graceful degradation is cheap** because re-seed already exists and already works — resume never has to
  be trusted, only tried.

## Consequences

- **Data model** (`website/lib/store.js`): a persisted `natives` map per conversation; `spawnSpec` gains
  `--session-id` on fresh spawns and a `resumeFrom` mode; `hub.js` carries the reopen decision (choose
  anchor, resume-or-fresh, compute+inject delta, reconcile the handle after the turn); the seed builder
  splits into *full* (`[conversation resumed] <history> + new`) vs *delta-only* (just the new turns — a
  resumed runtime already holds the context and must **not** be re-seeded the history).
- **Claude auto-updates at runtime.** Observed 2026-07-02: the prod pod jumped **2.1.197 → 2.1.198
  mid-day**, on its own, from under the image. Native transcript/resume behaviour is therefore **not
  pinned by our image** and can shift on any claude release. Two mitigations, both required: **(a) pin the
  claude version in the agent-runtime image** (control when behaviour changes); **(b)** because (a) can
  never be perfect, **resume must always be able to fall back to re-seed** (already in the decision). This
  is why re-seed stays the floor and is never removed.
- **Transcript lifecycle = PVC lifecycle** (deliberately crude for now — "one PVC we keep"). A finer
  retention/GC policy, and the case of the transcript vanishing under a live handle, are future work; the
  optimistic-resume fallback already makes a missing transcript merely *slower*, not *broken*.
- **Supervisor unchanged** (ADR 0002/0003) — all new knowledge is in the product's spawn recipe and hub.
- **ADR 0005 stands**; this ADR only removes its *"--resume is impossible"* premise (now false) and adds
  the fast-path. The guiding principle — *history must depend on no harness format, no PVC, no native
  transcript* — is unchanged: it governs the **source of truth**, while resume is an *accelerator* that is
  allowed to depend on all three precisely because it may fail without consequence.

## Validation (2026-07-02) — the verrou test

Run in the **real runtime pod** (native claude install, prod creds, `HOME=/home/node`, cwd
`/home/node/work`), driving a minimal stub-hub over the actual channel plugin:

| Check | Result |
|---|---|
| Turn 1 (`--session-id <uuid>`, fresh) replies over the channel | ✅ `"OK"` |
| Native transcript written at `<uuid>.jsonl` | ✅ (with `thinking` + `tool_use`/`tool_result`) |
| Turn 2 (`--resume <uuid>`) reattaches the channel | ✅ `hello` on the hub |
| Turn 2 accepts a fresh inbound push | ✅ |
| Turn 2 answers **in the restored context** | ✅ recalled `BASTION` (delivered only in the killed turn-1 runtime) |

Environment notes that make the result trustworthy — and that explain why an earlier local run failed:
- the **local POC rig** (npm-global `claude.exe`, `HOME=/srv/spike/itest/pochome`) writes **no** channel
  transcript even with a clean env + `--session-id` — an **install/env quirk, not a version regression**
  (the *same* 2.1.198 writes transcripts fine in the pod);
- `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` **leak** from a parent Claude-Code session and break a child
  claude — strip them (`env -u`; setting them to `undefined` in node-pty does **not** unset);
- an expired/blanked `~/.claude/.credentials.json` (`expiresAt:0`) makes claude sit at *"Not logged in"*,
  reply nothing, and write no usable transcript — verify creds before trusting a negative resume result.

## Companion doc

The full runtime lifecycle this ADR is part of (spawn, seed, resume, fallback — every case, the
decision tree, the flags, the invariants, the per-harness resume contract) is documented in
[`docs/runtime-lifecycle.md`](../runtime-lifecycle.md) (French). Prod-verified 2026-07-04: the C4
verrou (resume, fallback drill, hub-restart re-claim) plus a cross-model probe — `--resume <uuid>
--model <other>` reattaches the same transcript file with the new model answering in restored
context (anchors are per *kind*, not per model).
