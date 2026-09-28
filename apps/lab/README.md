# lab

Le banc, sur `agora-lab.bretagne.dev` derrière Pocket-ID. Il monte le paquet
[executions](../../packages/executions/) et sert une page volontairement brute pour jouer tous
les cas de [docs/executions.md](../../docs/executions.md).

| Dossier | Contenu |
| --- | --- |
| [src/](src/) | Le point d'entrée : configuration et montage des exécutions. |
| [public/](public/) | La page du banc. |
| [scripts/](scripts/) | Les cas du contrat joués contre le banc déployé. |

Ports : **8080** pour l'API et la page, **8081** pour la réception des anchors (seul port ouvert
aux sandboxes).

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `SANDBOX_NAMESPACE` | requis | Namespace des claims et des sandboxes. |
| `SIGNING_KEY_FILE` | requis | Clé privée Ed25519 qui signe les jetons du bridge. |
| `ANCHOR_DIR` | `/data/anchors` | Où les anchors sont stockés. |
| `LEASE_SECONDS`, `TURN_CAP_SECONDS`, `RENEW_SECONDS` | 600, 3600, 60 | Bail, durée maximale d'un tour, cadence du ré-armement. |
| `MAX_ACTIVE` | 4 | Exécutions actives au plus. |
| `LAB` | — | `true` pour ouvrir les routes du banc. |
| `ANCHOR_AUDIENCE` | `agora-anchors` | Audience attendue du jeton projeté des Pods. |

Image : `docker build -f apps/lab/Dockerfile .` depuis la racine.
