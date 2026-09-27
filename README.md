# Agora — refonte

Agora fait travailler des agents dans des sandboxes, garde leurs échanges et retrouve le
travail après une interruption. Cette branche, `feat/executions`, développe les exécutions
décrites dans [docs/executions.md](docs/executions.md) : Agora demande à Agent Sandbox un
sandbox pour un harness, lui parle en ACP, fixe son échéance et garde son anchor. Elle part de
la branche de conception `design/agora-foundations`.

| Dossier | Contenu |
| --- | --- |
| [docs/](docs/) | La conception : produit, exécutions, interface. |
| [apps/](apps/) | Ce qui se déploie : aujourd'hui le banc. |
| [harnesses/](harnesses/) | Les images de harness, qu'Agent Sandbox lance dans ses pools. |
| [packages/](packages/) | Le code partagé : les exécutions, le bridge, l'agent mock, les outils de test. |
| [.github/workflows/](.github/workflows/) | La CI : vérifications et publication des images. |

Un déployable ne dépend jamais d'un autre ; un paquet ne dépend jamais d'un déployable.

## Travailler

Node 24 exécute directement le TypeScript : rien n'est compilé.

```sh
npm ci
npm run check      # typecheck puis tests de chaque workspace
```

Les images sont construites depuis la racine par la CI (`executions`) et publiées par digest ;
infra-k8s les épingle (`apps/agora-sandboxes`, `apps/agora-lab`).
