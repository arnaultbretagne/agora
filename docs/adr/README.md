# adr

Les décisions d'architecture d'Agora. Un ADR explique pourquoi Agora est construit ainsi ; le
fonctionnement lui-même est décrit dans le document du sujet, dans [docs/](../).

## Quand en écrire un

Pour un choix qui engage durablement et qu'il serait coûteux de défaire : un composant, une
dépendance, une frontière de confiance, un format échangé. Pas pour un détail d'implémentation,
ni pour ce que le document du sujet suffit à expliquer.

## Ce qu'on veut y lire

| Section | Contenu |
| --- | --- |
| En-tête | Statut, date, l'ADR qu'il remplace s'il y en a un, le document du sujet qui porte le contrat. |
| Contexte | Le problème et ses contraintes, sans la solution. |
| Décision | Ce qui est décidé, en quelques points vérifiables. |
| Pourquoi | Ce que la décision apporte, avec les mesures qui l'appuient. |
| Ce qu'on a essayé | Chaque option essayée ou étudiée : ce qu'elle était, ce qu'on a constaté, pourquoi on l'a écartée. |
| Conséquences | Ce que la décision coûte ou impose ensuite. |

## Règles

- **Nom :** un numéro sur quatre chiffres et un titre court, `0001-la-passerelle.md`. Le titre du
  document énonce la décision.
- **Statut :** *proposée* tant qu'elle est à relire et que rien n'en dépend ; *acceptée* quand
  elle engage le code ; *remplacée* quand un ADR plus récent la remplace, et il le nomme.
- **Pas de réécriture :** une décision acceptée ne se réécrit pas. Changer d'avis, c'est écrire
  un nouvel ADR qui la remplace ; seul le statut de l'ancien change. Les corrections de forme
  restent permises.
- **Constats sourcés :** chaque constat dit d'où il vient, avec sa date ou sa version : une mesure
  (où, quand), du code lu, une documentation citée comme telle.
- **Forme :** prose et tableaux, avec les vrais noms des éléments ; pas de code. Le contrat vit
  dans le document du sujet : l'ADR le lie, il ne le recopie pas.
