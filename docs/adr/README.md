# adr

Les décisions d'architecture de la refonte : le contexte, ce qui est décidé, pourquoi, ce qu'on a
essayé avant, et les conséquences. Le fonctionnement lui-même est décrit dans le document du
sujet, dans [docs/](../).

Les ADR de l'implémentation précédente (branche `main`) ne s'appliquent pas à la refonte. Un
ADR d'ici qui reprend un de leurs sujets le dit.

| ADR | Statut | Décision |
| --- | --- | --- |
| [0001](0001-la-passerelle.md) | Acceptée | La passerelle d'Agora est la seule sortie des exécutions : droits signés par Agora, vérifiés à chaque requête. |
