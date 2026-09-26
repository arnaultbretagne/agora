# Banc d'essai de l'interface

Une page qui rend chaque composant retenu par [`assistant-ui.md`](../assistant-ui.md), dans chacun
de ses états et avec ses options, pour décider sur pièce. Servie sur `agora-test.bretagne.dev`.

Tout tourne dans le navigateur : un faux serveur Agora (`src/agora/simulator.ts`) applique les
commandes et fait vivre le fil. Aucun harness, aucun journal, aucun appel sortant.

## Ce qui est où

| Chemin | Rôle |
| --- | --- |
| `src/agora/model.ts` | Le fil tel qu'Agora l'envoie : workstreams, tours, éléments, avis. |
| `src/agora/convert.ts` | La correspondance du contrat : tour → messages, élément → part. |
| `src/agora/runtime.tsx` | Le pont `useExternalStoreRuntime` et les commandes. |
| `src/agora/components.tsx` | Les composants « à nous » du contrat. |
| `src/agora/toolkit.tsx` | Rendus par sorte d'outil (diff, terminal) et plan. |
| `src/components/` | Composants du registre assistant-ui et shadcn, copiés puis adaptés. |
| `src/showcase/` | La page : démo de bout en bout et galerie par section. |

Les composants du registre sont des copies (`npx shadcn add https://r.assistant-ui.com/<nom>.json`).
Adaptations faites pour Agora : `thread.aui.tsx` (avis, badges, bandeaux, sans branches ni édition ni
pièces jointes), `thread-list.aui.tsx` (état d'exécution, sans menu), `tool-fallback.aui.tsx` (titre
ACP, décision de permission visible), libellés en français.

## Lancer

```sh
npm ci
npm run dev      # http://localhost:5173
npm run build    # dist/
```

L'image (`image/Dockerfile`, nginx non-root sur 8080, `/healthz`) est publiée par
`.github/workflows/ui-showcase.yml` à chaque push sur `spike/ui-showcase`.
