# ADR 0002 — The `channels` primitive as the pipe

## Status

Proposed — 2026-06-30

## Context

The pipe between a conversation and the hub (ADR 0001) has to be built on *something*. Temptation:
invent our own transport — a homegrown WS that "talks" to the TUI, stdout scraping, or driving
`claude -p` / the Agent SDK by messages.

But there's a **hard constraint** (`agent-runtime` ADR 0005): stay on the **OAuth subscription**, the
**interactive TUI** — **not** the API, **not** `-p` / SDK (sword of Damocles). And Claude Code exposes
**exactly** a native primitive made for this: `channels` (research preview, ≥ v2.1.80).

## Decision

**The pipe = Claude Code's native `channels` primitive. We reinvent nothing.**

A channel, concretely:

- an **MCP server over stdio** that `claude` **spawns itself** (declared in config, capability
  `experimental: { 'claude/channel': {} }`);
- **inbound** (site → claude): the channel **pushes** an event via
  `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })` → claude
  receives it **in the live session** as `<channel source="…" chat_id="…">…</channel>`;
- **outbound** (claude → site): the channel exposes an **MCP tool `reply(chat_id, text)`** that claude
  calls *(the name `reply` is the convention/example — it's configurable)*;
- **permission-relay** (optional): capability `claude/channel/permission` → the channel can **relay**
  permission requests to the site.

## Rationale

- **Subscription-safe by construction.** The channel **pushes into the interactive TUI** running on
  the subscription. We **never** touch the API or `-p`/SDK. It's *the* mechanism that makes the
  product compatible with `agent-runtime` ADR 0005. Reinventing a transport = falling back to `-p`/SDK
  = Damocles.
- **Push-into-live-session.** A channel is not a request/response RPC: it **injects events into a
  running session**. That's exactly "talking to a live agent" — and it explains the stdio constraint
  (below).
- **Native = zero fragile glue.** No TUI scraping, no PTY-parsing, no "has claude finished?"
  heuristic. The harness does the work; we consume a **documented contract**.
- **Why stdio (and not remote MCP / HTTP-SSE).** The primitive pushes *into the live session* → the
  channel server must be **spawned by claude itself**, over **stdio**. **Remote MCP (HTTP/SSE) does
  not apply**: it *serves tools on demand*, it does **not push** events into the loop. ⇒ **the channel
  is co-located with the runtime** — a structuring consequence (ADR 0001 / 0003).
- **Permission-relay = the opt-in alternative to skip-perms.** In the boundary-pod (`agent-runtime`
  ADR 0003) **skip-permissions is the default**. The primitive offers better when wanted: **relay** the
  request to the site → the human decides from the hub. The mode is ultimately a **per-conversation
  parameter from the hub** (`agent-runtime` ADR 0003) — skip by default, relay opt-in.

## Consequences

- **The channel is not a remote service we host**: it's a **process spawned by claude**, over stdio,
  **in the runtime pod**. Its *code* is product (agora); its *execution site* is the runtime →
  delivered as a **plugin** (ADR 0003), **not** baked into the image.
- **The channel has two faces**: MCP-stdio on the claude side (inbound notifications + `reply`
  outbound) and **WS** on the hub side (the real network "pipe"). **It is the one that bridges
  stdio ⟷ WS.**
- The primitive's **`chat_id`** = a conversation's **routing key**, which the hub uses (ADR 0004).
- **Dependency on a research preview.** `channels` is in preview (≥ v2.1.80): the surface may shift.
  Mitigation: it's **isolated in a single artefact** (the channel). We **accept** the preview — it's
  the bet aligned with the subscription constraint (the "stable" alternative transports are precisely
  the ones we forbid ourselves).
- **Protocol shape documented; content semantics + enablement spike-confirmed (2026-06-30).** The wire
  shape (notification method, `reply`, capabilities) is documented; the spike confirmed `reply()`
  delivers **one clean final turn** (no streaming, no internal transcript). **Enablement**: a
  `--channels` / `--dangerously-load-development-channels` flag **+** this MCP server (plugin or
  `.mcp.json`) **+** `--allowedTools` for the reply tool (`/srv/spike/FINDINGS.md`).
- **fakechat** (Anthropic) is the **proof** that this design holds (channel + web UI) and our
  **reference** (ADR 0006).

## Amendment 2026-07-14 — the channel WS gets its own listener (`:8601`), split from the human plane

The channel's hub-side face (the WS pipe, §Consequences) has until now shared `website:8600` with the
human UI + API. But a loge must reach the channel, so the CiliumNetworkPolicy that permits that also
exposes the port serving the **human run-lifecycle API** — and that internal route does not necessarily
pass `oauth2-proxy`. A compromised loge could try to drive run lifecycle, or request a more privileged
capability profile (ADR 0012), through it. Once loges gain credentialed reach via the broker
(agent-runtime ADR 0011), that path is unacceptable.

**Decision.** The channel WS moves to a dedicated listener **`:8601`**, serving `/ws/channel` (plus a
minimal probe health) and **nothing else** — no assets, no `/api/*`, no detailed health. The human UI/API
stays on **`:8600`** behind `oauth2-proxy`. Loges are granted network access to **`:8601` only**. It is
the **same in-process hub/store** (one state authority, ADR 0008) — a listener split, not a second hub.

This is a **security prerequisite**, not an optimisation: only the human plane may set a run's equipment.
Rollout is two-step (open 8601 compatibly, then close loges→8600 in the CNP); see master plan P1.
