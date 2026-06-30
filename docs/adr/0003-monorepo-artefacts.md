# ADR 0003 — Monorepo + multi-artefacts

## Status

Proposed — 2026-06-30

## Context

`agora` carries three things (ADR 0001): the **site**, the **channel**, and the **protocol** that
links them. They have different **execution sites** and **delivery formats**: the site = an **image**
in its pod; the channel = a **plugin** spawned in the runtime pod; the protocol = code **shared** by
both.

One repo per artefact, or a monorepo?

## Decision

**A monorepo `agora`, three artefacts:**

| Folder | Build → | Execution site |
|---|---|---|
| `website/` | **image** | its own pod |
| `channel/` | **Claude Code plugin** | on the runtime's PVC, spawned by claude |
| `shared/` | *(internal dependency)* | compiled into both |

- `shared/` = **the WS protocol** (types / messages), **consumed by website and channel**.
- **claude pulls only `channel/`** (the plugin); it **never** sees `website/`.

## Rationale

- **The protocol is the shared edge → a monorepo keeps it coherent.** The channel and the site talk
  over WS (ADR 0002). Their contract (`shared/`) must evolve **in one piece**: a message change
  touches **both ends in the same commit**, the same PR, the same CI. Two repos = versioning a
  protocol **between yourself and yourself** = gratuitous pain.
- **But separate artefacts, because the execution sites differ.** The channel **is not** in the site's
  image, and vice versa. **Co-located-with-the-runtime ≠ baked-into-the-runtime-image**: the plugin
  lives on the **PVC**, delivered/installed separately (exactly like fakechat = Anthropic plugin on
  the PVC). The monorepo **doesn't erase** the deployment boundary; it **tools** it (one build per
  target).
- **claude pulls only the channel.** The runtime has **no reason** to know the site: it spawns a
  plugin (the channel) which, in turn, knows how to talk to the site. ⇒ minimal surface on the runtime
  side, and the site stays **replaceable** without touching the runtime.
- **Why not three repos.** The cost (versioning `shared/` by hand, 3 CIs, 3 PRs for a single protocol
  change) **outweighs** the benefit — an independence we don't need: all three move **together**. If
  an artefact one day takes on a real life of its own (its own release), we **spin it off** — not
  before.

## Consequences

- Layout: `agora/{website,channel,shared}/` + `docs/adr/`. `shared/` is an **internal dependency**,
  not a published package.
- **Two build pipelines** from one repo: `website/` → image (registry); `channel/` → plugin (artefact
  installable onto the PVC). `shared/` has **no** build of its own — it's compiled into each.
- **Protocol versioning = internal to the repo**: channel and website **from the same commit** are
  guaranteed compatible. The "channel of one version / site of another" case exists **at runtime**
  (long-lived runtime vs redeployed site) → that's a **protocol-compat** topic, handled when writing
  `shared/`, **not** a repo topic.
- The **plugin** follows the Claude Code plugin format — a `plugin.json` manifest (metadata) **plus a
  `.mcp.json`** that declares the channel's MCP server (two separate files, not one) — details settled
  while building it. *(Spike-confirmed: claude loads the channel via **both** — the plugin/`.mcp.json`
  provides the MCP server, and a `--channels plugin:<name>@<marketplace>` flag (dev:
  `--dangerously-load-development-channels server:<name>`) activates it per session.)*
- **Installing the plugin onto the PVC** is a deployment gesture (who places it, when) to wire up on
  the `infra-k8s` side. Here we just record: **delivered as a plugin, not baked into the image**.
