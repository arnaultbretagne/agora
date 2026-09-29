# docs

La conception d'Agora : un document par sujet, qui dit comment ça marche, et les décisions
d'architecture dans `adr/`, qui disent pourquoi. Le point d'entrée est `design.md`.

## Ce qu'on y met

- **Un document par sujet** — le produit, les exécutions, les credentials, l'interface. Il décrit
  le contrat : les acteurs, les échanges, les règles, les cas validés et ce qui reste à préciser.
- **Un ADR par décision d'architecture**, dans `adr/`, selon la recette de ce dossier.

## Règles

- **Un sujet, un document.** Le nom du fichier dit le sujet ; un nouveau sujet fait un nouveau
  fichier, pas une section ajoutée ailleurs.
- **Pas de lien entre fichiers.** Le nommage et l'arborescence suffisent à retrouver un
  document ; un lien finit par mourir. On cite un document par son nom.
- **Écrit comme la doc d'Agora.** Ce qui est vrai d'Agora, pas l'état d'un chantier : ni
  « refonte », ni « cette branche », ni « pour l'instant ».
- **Langue :** les documents en français, les ADR en anglais.
- **Forme :** prose et tableaux, avec les vrais noms des éléments ; des schémas Mermaid quand ils
  aident, minimaux. Pas de code.
