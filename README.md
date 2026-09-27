# Agora — refonte

Agora fait travailler des agents dans des sandboxes, garde leurs échanges et retrouve le
travail après une interruption. Cette branche, `feat/sandbox-backend`, développe le back-end
des sandboxes décrit dans [docs/backend.md](docs/backend.md) ; elle part de la branche de
conception `design/agora-foundations`.

| Dossier | Contenu |
| --- | --- |
| [docs/](docs/) | La conception : produit, back-end des sandboxes, interface. |
| [apps/](apps/) | Les services déployables : le back-end des sandboxes et sa page de banc. |
| [harnesses/](harnesses/) | Les images de sandbox, une par harness. |
| [packages/](packages/) | Le code partagé : bridge, agent mock, outils de test. |
| [.github/workflows/](.github/workflows/) | La CI : vérifications et publication des images. |

L'arborescence suit l'ADR 0001 de `main` : un déployable ne dépend jamais d'un autre, un
paquet jamais d'un déployable.

## Travailler

Node 24 exécute directement le TypeScript : rien n'est compilé.

```sh
npm ci
npm run check      # typecheck puis tests de chaque workspace
```

Les images sont construites depuis la racine, par la CI (`sandbox-backend`), et publiées par
digest ; infra-k8s les épingle (`apps/agora-sandboxes`, `apps/agora-lab`).
