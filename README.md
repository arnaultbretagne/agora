# agora

> L'agora : la place publique où tu parles à tes agents.

Le **produit** de la plateforme : un **site** qui pilote des **runtimes** Claude distants
via des **pipes** — les `channels` natifs de Claude Code.

```
┌─ pod agent-runtime (infra) ───────────────┐     ┌─ pod website (agora) ────┐
│  superviseur thin (spawn/kill/list)        │◄───►│  hub multi-conversation   │◄─ navigateur / iOS / Discord…
│    ├─ runtime#1 (claude) ─spawn→ channel#1 ─┼─WS─►│  route vers channel#i     │
│    └─ runtime#N ─────────spawn→ channel#N  ─┼─WS─►│  agrège les conversations │
└─────────────────────────────────────────────┘     └───────────────────────────┘
            ▲ channel = plugin (code agora, livré sur le PVC)
```

## Les artefacts

| Dossier | Build → | Rôle |
|---|---|---|
| **`website/`** | image | Le hub. Tu y parles à tes agents ; il agrège N conversations, pilote l'API du superviseur, route les messages. |
| **`channel/`** | plugin Claude Code | Le pipe entre un runtime et le site. Serveur MCP **stdio** que `claude` spawn lui-même ; relaie en **WS** vers le website. |
| **`shared/`** | — | Le protocole WS commun aux deux. |

## Frontière avec l'infra

L'image, le superviseur, l'auth, la sécurité du pod = le repo **`agent-runtime`** (brique
infra, **agnostique au produit**). agora est le produit qui se *branche* dessus :

- le **channel** est co-localisé au runtime (contrainte `stdio` de la primitive) mais c'est
  du **code produit**, livré comme **plugin** installé sur le PVC — **pas** baké dans l'image ;
- le **website** tourne dans son propre pod.

Le site dialogue avec **deux** contrats : l'**API du superviseur** (cycle de vie des runtimes)
et les **channels** (messages). C'est toute la surface produit ↔ infra.

## Design

Voir [`docs/adr/`](docs/adr/README.md) — les décisions d'architecture, par ordre de lecture.
