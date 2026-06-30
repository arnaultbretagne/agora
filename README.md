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

## Design

See [`docs/adr/`](docs/adr/README.md) — the architecture decisions, in reading order.
