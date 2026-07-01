# agora

> The agora: the public square where you talk to your agents.

The platform **product**: a **site** that pilots remote Claude **runtimes**
through **pipes** (Claude Code's native `channels`) — though from the site's point of view there are
only **conversations and their pipes**, not runtimes (ADR 0001).

```
┌─ pod agent-runtime (infra) ───────────────┐     ┌─ pod website (agora) ────┐
│  thin supervisor (spawn/kill/list)         │◄───►│  multi-conversation hub   │◄─ browser / iOS / Discord…
│    ├─ runtime#1 (claude) ─spawn→ channel#1 ─┼─WS─►│  routes to channel#i      │
│    └─ runtime#N ─────────spawn→ channel#N  ─┼─WS─►│  aggregates conversations │
└─────────────────────────────────────────────┘     └───────────────────────────┘
            ▲ channel = plugin (agora code, delivered onto the PVC)
```

## The artefacts

| Folder | Build → | Role |
|---|---|---|
| **`website/`** | image | The hub. You talk to your agents here; it aggregates N conversations, drives the supervisor API, routes messages. |
| **`channel/`** | Claude Code plugin | The pipe between a runtime and the site. **stdio** MCP server that `claude` spawns itself; relays over **WS** to the website. |
| **`shared/`** | — | The WS protocol common to both. |

## Boundary with the infra

The image, the supervisor, auth, pod security = the **`agent-runtime`** repo (infra
brick, **product-agnostic**). agora is the product that *plugs* into it:

- the **channel** is co-located with the runtime (the primitive's `stdio` constraint) but it's
  **product code**, delivered as a **plugin** installed onto the PVC — **not** baked into the image;
- the **website** runs in its own pod.

The site talks to **two** contracts: the **supervisor API** (runtime lifecycle)
and the **channels** (messages). That's the entire product ↔ infra surface.

## Layout (as built)

```
agora/
├─ shared/protocol.js     WS protocol: channel⟷hub frames + hub→client events + validators
├─ channel/               the plugin (Claude Code channel)
│  ├─ .claude-plugin/plugin.json   manifest — declares `channels: [{ server: "agora" }]`
│  ├─ .mcp.json                    the stdio MCP server (node server.js)
│  ├─ server.js                    stdio MCP (claude side) ⟷ WS (hub side) bridge
│  └─ protocol.js                  generated copy of ../shared (self-contained on install)
├─ website/               the hub
│  ├─ server.js           HTTP+REST façade, WS /ws/client (browsers), WS /ws/channel (pipes)
│  ├─ lib/store.js        neutral conversation store — the sole source of truth (ADR 0005)
│  ├─ lib/supervisor.js   agent-runtime supervisor client + per-kind spawn recipe
│  ├─ lib/seed.js         re-seed builder (flattened role-tagged history replay)
│  ├─ lib/hub.js          routing, lifecycle, re-seed, restart reconcile
│  ├─ public/             claude.ai-like UI (vanilla ESM, light/dark, mobile)
│  └─ test/               node:test — protocol / store / seed / hub (18 cases)
├─ .claude-plugin/marketplace.json   local marketplace exposing the channel plugin
└─ scripts/sync-shared.mjs           copies shared/ → channel/ (self-contained plugin)
```

## Enablement (how claude loads the channel — spike-validated)

- `--channels plugin:agora@<marketplace>` activates the channel; the plugin's `plugin.json` **must**
  declare `channels: [{ server: "agora" }]` (else claude loads the MCP server but skips the channel).
- The reply tool is `mcp__plugin_agora_agora__reply` → pass it to `--allowedTools` for a headless run.
- Managed policy must allow it: `/etc/claude-code/managed-settings.json` →
  `channelsEnabled: true` + `allowedChannelPlugins: [{ marketplace, plugin: "agora" }]`.
- Details + the startup-race mitigation: `/srv/spike/FINDINGS.md` §5 / §5b.

## Run the POC

`bash .poc/run.sh start` boots the supervisor (agent-runtime) + hub, then open `http://127.0.0.1:8600`.
Requires the agent-runtime supervisor build and a Claude Max login on the runtime's HOME. `.poc/run.sh stop` to stop.

## Design

See [`docs/adr/`](docs/adr/README.md) — the architecture decisions, in reading order.
