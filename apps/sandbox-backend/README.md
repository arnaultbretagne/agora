# sandbox-backend

Le back-end des sandboxes ([docs/backend.md](../../docs/backend.md)) : il crée les
`SandboxClaim`, relaie ACP en suivant les tours, ré-arme l'échéance pendant un tour et
stocke les anchors que les Pods poussent. Il ne supprime jamais rien.

| Dossier | Contenu |
| --- | --- |
| [src/](src/) | Le service. |
| [public/](public/) | La page du banc. |
| [test/](test/) | Les tests du contrat, contre de vrais bridges et une API Kubernetes simulée. |
| [scripts/](scripts/) | Les cas du contrat joués contre un back-end déployé. |

Ports : **8080** pour l'API et le banc, **8081** pour la réception des anchors (seul port
ouvert aux sandboxes).

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `SANDBOX_NAMESPACE` | requis | Namespace des claims et des sandboxes. |
| `SIGNING_KEY_FILE` | requis | Clé privée Ed25519 qui signe les jetons du bridge. |
| `ANCHOR_DIR` | `/data/anchors` | Où les anchors sont stockés. |
| `LEASE_SECONDS`, `TURN_CAP_SECONDS`, `RENEW_SECONDS` | 600, 3600, 60 | Bail, durée maximale d'un tour, cadence du ré-armement. |
| `MAX_ACTIVE` | 4 | Sandboxes actifs au plus. |
| `LAB` | — | `true` pour ouvrir les routes du banc. |
| `ANCHOR_AUDIENCE` | `agora-anchors` | Audience attendue du jeton projeté des Pods. |

Image : `docker build -f apps/sandbox-backend/Dockerfile .` depuis la racine.
