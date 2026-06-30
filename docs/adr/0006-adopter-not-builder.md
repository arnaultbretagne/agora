# ADR 0006 — Adopt, don't build: the landscape and the decision

## Status

Proposed — 2026-06-30

## Context

We're building a product (hub + channel) on top of Claude Code. Hygiene question: **are we reinventing
something that already exists?** Many tools orbit CLI agents — before building, we **scout**. The
opposite risk: adopting a heavy framework that **locks us in** (and drags us back toward the API/SDK =
Damocles, `agent-runtime` ADR 0005).

## Decision

**Adopt the *primitive* (channels), build the product *thin* (hub + channel) — don't adopt an agent
framework.**

- We **adopt** what is **native and subscription-safe**: the `channels` primitive, the JSONL format,
  the plugin mechanism (ADR 0002 / 0005).
- We **build the hub and the channel ourselves, thin** — because it's **our** topology
  `(site → runtimes → pipes)` and **our** constraints (subscription, single-user, k8s, OIDC), which no
  tool serves *as-is*.
- We **do not adopt** an agent-orchestration framework (which presume the API/SDK or another execution
  model).
- **fakechat** = the **reference** (proof that a channel + web UI holds), **not** a dependency.

## Rationale — the scouted landscape

Each is useful; none **replaces** the product under our constraints:

- **fakechat** (Anthropic, `external_plugins/`) — channel + web UI in **one** process (couples
  channel + site, `127.0.0.1`). **Perfect as proof and MVP seed**; not a multi-conversation /
  multi-client / k8s product. ⇒ we take **inspiration**, we **decouple** (ADR 0001 / 0003).
- **Happy** (happy.engineering) — mobile/desktop for Claude Code, e2e-encrypted, multi-session. Very
  close to the "drive Claude remotely" intent — but a **third-party service**, its own infra /
  account; we want **our** k8s platform, single-user, behind **our** OIDC. ⇒ confirms the need,
  doesn't **serve** it for us.
- **agentapi** (Coder) — **HTTP on top of the TUI** by **terminal parsing**. It's the "scrape the PTY"
  approach we **avoid**: fragile — and above all `channels` makes it **pointless** (native push >
  scraping). ⇒ ruled out **by** the primitive.
- **OpenCode / Pi** — other CLI harnesses. Interesting, but **not the Claude subscription** (the hard
  point, `agent-runtime` ADR 0005). Off-target as long as the constraint is "stay on the Claude
  subscription". *(Keeping watch: if multi-harness one day, they come in as `kinds` behind the
  supervisor.)*
- **Codex App-Server / CloudCLI** — the "app server" angle from other ecosystems. Same verdict: not
  the Claude subscription, not our topology. Useful as **keeping watch** on the pattern (an app-server
  in front of an agent), not as a foundation.

**Why "build-thin-own":**

- **No tool combines all our constraints**: (Claude OAuth subscription) × (single-user, Terms) ×
  (k8s + homegrown OIDC) × (multi-conversation `(conv, pipe)`). Each drops **at least one**.
- **The primitive does the heavy lifting.** With `channels` + JSONL, the product that's left is
  **thin**: a router/aggregator + a stdio↔WS bridge. Building it ourselves costs **less** than bending
  a third-party framework to our constraints — and **adds no** dependency that could drag us back
  toward the API/SDK.
- **Adopt the primitive, not the framework** = inherit Anthropic's work *where it's safe* (the native
  push), without inheriting an execution model that **betrays** the subscription constraint.

## Consequences

- **Accepted watch-debt**: `channels` (preview) and the JSONL format move → we follow Claude Code
  closely (and that's *already* the `agent-runtime` image's lifecycle). Happy / OpenCode / Codex =
  passive watch.
- **fakechat stays the testbed**: any doubt about the primitive is settled by **looking at / forking
  fakechat** before speculating.
- **Invariant**: no agent framework in agora's dependencies. A PR that introduces one must first
  **kill the subscription constraint** (so: rejected by default).
- If the "Claude subscription" constraint were to **fall** one day (unlikely), the *adopt-vs-build*
  decision would need **reopening** (OpenCode / multi-harness would become relevant). Noted so we
  don't forget.
