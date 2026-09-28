# Agora — refonte

Agora fait travailler des agents dans des sandboxes, garde leurs échanges et retrouve le
travail après une interruption. `design/agora-foundations` est la branche de base de la
refonte : elle repart de zéro, sans historique commun avec `main`, et rien des versions
précédentes n'est repris sans être écrit dans [docs/](docs/).

| Dossier | Contenu |
| --- | --- |
| [docs/](docs/) | La conception : produit, exécutions, interface. |
| [apps/](apps/) | Ce qui se déploie : aujourd'hui le banc. |
| [harnesses/](harnesses/) | Les images de harness, qu'Agent Sandbox lance dans ses pools. |
| [packages/](packages/) | Le code partagé : les exécutions, le bridge, l'agent mock, les outils de test. |
| [.github/workflows/](.github/workflows/) | La CI : vérifications et publication des images. |

Un déployable ne dépend jamais d'un autre ; un paquet ne dépend jamais d'un déployable.

## Travailler par branches

| Règle | Détail |
| --- | --- |
| Une base | `design/agora-foundations`. On n'y commite jamais directement : tout y entre par PR. |
| Une branche par sujet | Partie de la base, préfixée `feat/`, `fix/`, `chore/` ou `docs/` (exemple : `feat/executions`). |
| Doc et code ensemble | La doc d'un sujet (son contrat dans `docs/`) change dans la même branche que son code, jamais à côté. |
| Rester à jour | On fusionne la base dans sa branche ; on ne fusionne jamais une branche de sujet dans une autre. |
| Retour sur la base | Par PR, CI verte ; la branche est supprimée après la fusion. |

Deux branches ne modifient donc jamais le même doc en parallèle, et chaque retour sur la base
se fait sans conflit.

**Le jour où la refonte remplace `main`**, on ne fusionne pas : on substitue. Depuis une
branche issue de la base :

```sh
git merge -s ours --allow-unrelated-histories origin/main
```

Ce commit garde exactement l'arbre de la refonte et donne `main` pour parent : la PR vers
`main` passe sans conflit, l'ancien code disparaît de l'arbre et son historique reste accessible.
C'est une décision à prendre à ce moment-là : le moteur en production est construit depuis `main`.

## Vérifier et construire

Node 24 exécute directement le TypeScript : rien n'est compilé.

```sh
npm ci
npm run check      # typecheck puis tests de chaque workspace
```

La CI vérifie chaque push et chaque PR vers la base, puis publie les images par digest ;
infra-k8s les épingle (`apps/agora-sandboxes`, `apps/agora-lab`).
