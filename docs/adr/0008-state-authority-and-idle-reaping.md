# ADR 0008 — State authority: the hub *reads* a composed state; the reaper lives in the supervisor

## Status

Proposed — 2026-07-03. **Supersedes the hub-side idle-reaper** shipped in `7a95f7e` (moves it to the
supervisor). **Amends ADR 0004** (the hub gains a state-*reader* role instead of a state-*reconstructor*
one) and pairs with **agent-runtime ADR 0008** (the supervisor gains the generic reap mechanism). ADR 0005
(hub owns the neutral history) is unchanged.

## Context

Two production symptoms, one root cause.

1. **Stale-green.** Two conversations showed `live` (green dot) for ~2h while their `claude` process was
   already dead. The runtimes had **exited on their own** (the supervisor held 0 sessions), but the hub
   still displayed them alive. Only a hub restart surfaced the truth: `reconcile` asked the supervisor,
   got *"session gone"*, and flipped both to `dormant`.

2. **Fresh-1h on restart.** The idle-reaper we just shipped (`7a95f7e`) lives in the **hub**, keyed on
   `pipe.lastTurnAt` — an in-memory hub value. It is **lost on every hub restart**: `reconcile` re-claims a
   live runtime and sets `lastTurnAt = now`, granting a fresh full-TTL grace regardless of the true last
   turn.

Both are the **same bug class: the hub is inferring liveness it does not own.** A conversation's aliveness
is really the conjunction of three independent axes, and **two of the three are owned outside the hub**:

| Axis | "alive" means | True owner |
|---|---|---|
| **pipe** | a live channel→hub WS is serving the user | **hub** (the WS terminates here) |
| **terminal** | the `claude` PTY process is actually running | **supervisor** (it spawned it, it gets the exit) |
| **harness** | the agent loop is `ready` and responsive (not `unresponsive`) | **runtime** (`ready`/`unresponsive` frames) |

Today `stateOf` only truly reads the **pipe** (plus the `ready` bit that happens to transit *through* that
pipe). It has **no independent check of the terminal** — it treats "pipe present" as a proxy for "process
alive". When `claude` dies but the channel's WS-drop is missed or delayed, the proxy lies → green ghost.
Same class of mistake as keeping the idle clock in the ephemeral hub.

## Decision

### 1. State is a composition read from its owners; the hub is a reader, not a reconstructor

The displayed state is the conjunction of the three axes, each read from its **owner**, not reconstructed
from a single proxy:

- `live` (green) = **pipe up AND terminal running (supervisor) AND harness ready & responsive**.
- `dormant` (grey) = **any axis dead** — terminal gone (whatever the pipe says), never started, or reaped.
- `error` (red) = harness `unresponsive`, **a spawn whose channel never says `hello` within a startup
  grace (~30 s)**, spawn failure, or a crash-with-error (persisted, as today).

Concretely: `stateOf` stops treating pipe-presence as terminal-liveness. The **terminal** axis is read from
the supervisor (its `GET /sessions/:id` is the authority), which reports `running | exited` **plus an
optional `exitCode`** (`supervisor.ts` `onExit`). The **presence** of the exitCode carries the signal:
`exited` **with** an exitCode → an *unexpected* exit → crash → **`error`** (red); `exited` **without** one →
a *supervisor-initiated* kill (reap/shutdown, which deliberately suppresses the code) → clean → **`dormant`**;
`404` (session unknown, supervisor bounced) → `dormant`. So a stale pipe can no longer show green — if the
supervisor says the process is gone, the conversation is grey (or red on a crash), full stop. The hub
**aggregates and displays**; it does not invent.

**This read is continuous, not boot-only** (the incident's real fix). `reconcile` runs on a short timer
(~2–5 s), polling the supervisor's **batch `GET /sessions`** (one round-trip, O(1) server-side) and diffing
it against the currently-live pipes. This is necessary because the **pipe-drop event is not a reliable
death signal**: the channel only exits when `claude`'s *stdio closes*, and a wedged/half-dead `claude` can
keep the pipe up over a dead agent (exactly the stale-green incident). The pipe/harness axes stay in-memory
events (no network); only the terminal axis is polled, so the cost is one list call every few seconds
regardless of conversation count. Staleness window for silent death = the poll interval.

Propagation stays event-driven in the happy path (a dying `claude` closes its stdio → the channel
`process.exit(0)` → the WS drops → the hub sees the pipe fall), with the supervisor read as the
**authority that breaks ties** when the pipe lags or lies.

### 2. The reaper moves to the supervisor (mechanism); the hub keeps the policy

Idle-reaping returns to where ADR 0001 (agent-runtime) always placed it — *"a conversation ends/idles →
it should be reaped"* — co-located with the process it kills:

- **Policy stays in the hub.** The per-harness cache TTL is product knowledge; it remains in the spawn
  recipe (`spawnSpec` / `cacheTtlFor`) and is **passed at spawn** as an opaque `idleTtlMs` parameter.
- **Mechanism lives in the supervisor — a single idle clock.** It keeps one per-session `lastTouch`,
  **initialised at spawn**, and on its own sweep kills any session where `now − lastTouch ≥ idleTtlMs`.
  Spawn is a valid t0 because a runtime is *only ever* spawned to process a pending message (`#spawnFor` is
  called only from `sendUserMessage`, always with a queued message) — so **there is no idle-waiting-for-a-
  first-message state**, and no need for a separate connect-timeout or a `claimed` flag. It **interprets
  neither value** — the TTL and the touches are opaque inputs, so the supervisor stays thin (ADR 0001/0002).
- **The hub emits the heartbeat on each completed turn.** The supervisor is **blind to turns** (they flow
  hub↔channel↔claude and bypass it), so the hub — which receives every reply — sends a lightweight `touch`
  on **each completed turn: the *reply* (inference done)**, not the inbound send (which warms no cache).

  > **Discipline (the one place the bug can return):** touch fires only on a genuine completed turn —
  > **never** on a reconnect / re-claim / reconcile. This is what kills *fresh-1h*: the clock lives in the
  > supervisor and survives hub restarts; a re-claim carries no touch, so it does not reset it.

When the supervisor reaps, the PTY dies → the channel WS drops → the hub reads `terminal = gone` **via the
composition of §1** → `dormant`. One mechanic; the two decisions close on each other.

## Rationale

- **Read from owners, don't reconstruct from a proxy.** The stale-green ghost is structurally impossible
  once terminal-liveness is read from the supervisor instead of inferred from the pipe.
- **The idle clock belongs with the process.** Co-locating it with the PTY makes it survive hub restarts
  for free — *fresh-1h* disappears without any extra bookkeeping in the hub.
- **The supervisor stays infra.** TTL and touch are opaque numbers/pings; the supervisor still knows
  nothing about conversations, turns, or history. This *restores* ADR 0001's intent rather than bending it.
- **Graceful, event-first, authority-backed.** The fast path stays the WS-drop event; the supervisor read
  is only the tie-breaker. No polling storm, no new steady-state cost.

## Consequences

- **Hub (`website/lib`):**
  - `stateOf` (`hub.js`) composes the three axes and reads the **terminal** axis from the supervisor
    (authority), instead of deriving it from `pipe` presence.
  - **Remove** the hub-side `#reapIdle` / `lastTurnAt` bookkeeping (`7a95f7e`). `cacheTtlFor` **stays** but
    is now consumed to fill `idleTtlMs` at spawn, not to run a hub-side timer.
  - **`reconcile` becomes periodic** (~2–5 s timer, batch `GET /sessions`), not boot-only — this is the
    actual fix for silent death; without it the terminal axis is only read at startup.
  - **The hub no longer initiates any kill.** `closeConversation` → `SupervisorClient.kill` → `DELETE
    /sessions/:id` was the product-facing kill; with idle-reaping in the supervisor and **no manual "close
    conversation" UX**, the hub stops calling it. The `DELETE` endpoint remains as the supervisor's **own**
    reap primitive. A wedged/`unresponsive` runtime is not manually killed either: its `touch` stops → the
    supervisor idle-reaps it after the TTL (self-healing, at worst one TTL slow).
  - **`#sweepPending` loses its kill, keeps a *state* role.** A spawn whose channel never says `hello`
    within a **startup grace** (~30 s) is marked `error` (red, harness axis) and its `pending` entry
    cleared — a state sweep, **no process kill** (the supervisor's single idle clock reclaims the RAM).
    This subsumes the old 120 s never-claimed kill without the hub touching the process.
  - `spawnSpec` (`supervisor.js`) passes `idleTtlMs` in the spawn params; `SupervisorClient` gains a
    `touch(id)` call, invoked on **each completed turn** (reply), never on re-claim/reconnect.
- **Supervisor (agent-runtime):** see companion ADR 0008 — `idleTtlMs` spawn param, `POST /sessions/:id/touch`,
  and an idle sweep that kills. The runtime image is unchanged beyond the supervisor.
- **Protocol:** no new channel frames are strictly required for the reaper (heartbeat is hub→supervisor over
  the existing control API). The `ready`/`unresponsive` frames added for the state model stay as the
  **harness** axis inputs.
- **Restart semantics, cleanly split (no re-adoption anywhere):**
  - **Hub restart** — the supervisor is untouched, so it keeps both the processes **and** their `lastTouch`.
    `reconcile` re-claims, the channels re-hello, the pipe is restored. Nothing is re-seeded; a re-claim is
    not a turn, so it carries no touch and does not reset the clock.
  - **Supervisor restart** — the supervisor is the PTY parent, so its children die with it; its in-memory
    `lastTouch` dies too, and there is nothing left to cadence. The hub reconciles → `gone` → `dormant` and
    reopens on demand (agora ADR 0007). No live process is ever re-adopted.
  - **Hub down > TTL** — the supervisor reaps at the right moment (idle is real, cache cold); no turn is
    lost because the hub is the sole ingress.

  `lastTouch` therefore only ever lives beside a live registry entry and never needs reconstruction.

## Open / deferred

- **The onExit/orphan reaper** — a `claude` that outlives its supervisor (the `run.sh stop` case) is a
  **bug to eliminate**, not a state to re-adopt: the supervisor must kill its children on shutdown and
  sweep strays on boot (clean slate). This ADR assumes that fix and that `GET /sessions/:id` is truthful
  about terminal death; the hardening itself is specified in **agent-runtime ADR 0009**.
- **Single-supervisor is a *topology* constraint, not a design ceiling.** Today one co-located supervisor
  per pod (`replicas: 1`) owns all runtimes as PTY children, and the state/reaper read its local map. A
  future **operator model** — a central supervisor that spawns one *pod* per runtime for strong isolation
  (a "load-balancer that creates pods on the fly") — is **compatible with this design**: the three-axis
  composition and the reaper are agnostic to *process vs pod*; only the **terminal-axis owner** changes
  (read K8s pod status instead of a PTY map; reap = delete a pod; clean-slate = ownerReferences/TTL
  controller instead of `/proc`-scan). So we are not painting into a corner by starting single-supervisor.

## Amendment (2026-07-04) — product-command kills

"The hub initiates no kills" governs **lifecycle** management (idle, health): that authority stays
with the supervisor's reaper and the death detectors, and nothing above re-acquires it. It was never
meant to forbid a kill that *is* the product command itself — `deleteConversation` always closed the
runtime, and `patchConversation` now does too when a **spawn parameter** (`model`/`effort`/`agent`)
changes on a conversation with a live/pending runtime: without it, the old runtime keeps answering
with the old parameters until its idle reap (up to ~1h), which is not what the user asked. The next
turn respawns `--resume <anchor> --model <new>` (native context preserved — prod-verified
2026-07-04); an unanswered turn triggers an immediate respawn instead, so the NEW parameters answer
it. A turn mid-flight at kill time is deliberately abandoned: switching models mid-answer means you
want the new model's answer. See `docs/runtime-lifecycle.md` scenario 12.
