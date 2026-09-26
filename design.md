# Agora

Proposition de design à relire — 21 septembre 2026.

Cette branche repart de zéro. Aucun code, schéma, ADR ou contrat des versions
précédentes n'est adopté implicitement. Les choix proposés ci-dessous restent à
valider ; toute réutilisation fera l'objet d'une décision explicite.

## But

Agora permet de travailler avec des agents exécutés dans des sandboxes, de suivre
leurs échanges et de retrouver le travail après une interruption.

Le produit fournit une interface commune à plusieurs harnesses via ACP. Il conserve
l'historique indépendamment de la durée de vie des processus et de l'infrastructure.

## Décisions acquises

- **Agent Sandbox** possède le cycle de vie des sandboxes sur Kubernetes.
- **Infisical Agent Vault** remplace OneCLI pour le courtage des credentials.
  Agent Vault désigne ici le produit autonome, distinct d'Infisical Agent Proxy.
- **ACP** est l'interface entre Agora et les harnesses.
- Le nettoyage des sandboxes abandonnées relève d'Agent Sandbox et, si nécessaire,
  d'une extension de reaping dans cette infrastructure. Aucun reaper dans Agora.
- Une indisponibilité du proxy ou un refus d'accès peut faire échouer une opération.
  Agora n'a pas à réparer automatiquement cette dépendance pour poursuivre une
  convergence globale.

## Fonctionnalités proposées

| Fonctionnalité | Comportement attendu |
| --- | --- |
| Historique durable | Retrouver les demandes, réponses, outils et erreurs après fermeture du navigateur ou redémarrage d'Agora. |
| Exécution à la demande | Ouvrir une exécution avec un harness et une configuration choisis parmi les options autorisées. |
| Interaction | Envoyer un message, suivre les sorties, répondre aux permissions ACP et demander l'annulation d'un tour. |
| Arrêt | Fermer l'admission de nouveaux messages et demander l'arrêt de l'exécution. Retirer le sandbox de l'UI dès que la suppression est acceptée. |
| Reconnexion | Retrouver une exécution encore vivante sans créer un second contexte ni renvoyer le dernier message. |
| Reprise après perte | Expliquer ce qui est récupérable et permettre une continuation explicite. |
| Choix du harness | Utiliser une interface commune, sans prétendre que tous les harnesses ont les mêmes capacités de reprise ou de configuration. |

Le changement de harness avec transfert de contexte, les personas, les skills
personnalisables, les branches de conversation et la collaboration multi-utilisateur
restent hors du premier périmètre proposé. Ils ne sont pas hérités des anciennes versions.

## Responsabilités

```text
Utilisateur → Agora → ACP → harness dans une sandbox
                │                 │
                │                 └→ Agent Vault → services externes
                │
                ├→ stockage durable des échanges et commandes
                └→ API Agent Sandbox : demander, retrouver, arrêter
```

Agora possède les commandes de l'utilisateur, leur attribution, le journal et les
vues affichées. Agent Sandbox possède les ressources d'exécution. Agent Vault
possède les credentials et applique les restrictions de leur utilisation.

Agora configure ces intégrations avec des valeurs autorisées. Il ne réimplémente
ni un contrôleur de Pods, ni un coffre, ni un proxy HTTP, ni leur surveillance globale.

L'[interface Agora ↔ Agent Sandbox](agent-sandbox.md) précise les opérations et les
délais retenus : bail de 10 minutes, renouvellement chaque minute, tour limité à 1 heure.

L'[interface Agora ↔ assistant-ui](assistant-ui.md) précise le fil, les commandes et
les composants retenus : projection ACP en base, un flux unique repris par position.

## Historique et exécution

Proposition : conserver deux notions produit simples.

- Un **Workstream** regroupe un travail et son historique ordonné.
- Une **Session** attribue les échanges à une exécution concrète d'un harness.

Une reconnexion au même contexte vivant conserve cette attribution. Un nouveau
processus ou contexte doit être identifié explicitement ; le nom stable d'une
sandbox ne suffit pas à prouver la continuité.

La configuration demandée et celle effectivement appliquée restent distinguées.
Cela n'impose ni un objet Intent complet à chaque changement, ni un moteur générique
de réconciliation. La frontière exacte des Sessions lors d'un changement de modèle
reste à décider.

Le journal conserve les échanges ACP complets acceptés, y compris leurs métadonnées.
Les messages assemblés et les états d'outils sont des vues reconstruisibles. Les
credentials d'infrastructure ne sont pas des données conversationnelles.

PostgreSQL est proposé pour ce stockage transactionnel ; aucun ancien schéma n'est
repris par défaut.

## Traitement d'un message

1. Autoriser l'utilisateur sur le Workstream et dédupliquer sa requête.
2. Vérifier la Session cible, la connexion ACP et les commandes incompatibles en cours.
3. Enregistrer durablement la commande avant son envoi.
4. Envoyer sur la connexion existante ; journaliser les échanges reçus et alimenter l'interface.

Le chemin courant ne relit pas Kubernetes, les grants et le transcript natif avant
chaque message. Les événements de connexion et les réponses des opérations mettent
à jour ce qu'Agora sait de son interaction avec le harness.

Une connexion ouverte n'est pas une preuve de progression. Un délai dépassé rend
le blocage visible ; il ne prouve ni l'échec de la commande ni l'absence d'effet.

## Commandes et reprise d'Agora

Proposition : un seul tour actif par Workstream. Les changements de configuration,
les envois et les arrêts partagent une règle d'ordre explicite. L'annulation peut
interrompre le tour actif ; une annulation tardive ne doit pas viser le suivant.

Après un crash, Agora retrouve les commandes non résolues et leurs cibles. Une demande
de sandbox réessayée doit retrouver la même ressource lorsque sa création a réussi
malgré la perte de réponse.

Pour ACP, « enregistré », « potentiellement envoyé » et « terminé » sont distincts.
Une réponse perdue ne déclenche pas un nouvel envoi automatique. Agora cherche une
preuve auprès du même contexte si le harness le permet, sinon expose l'incertitude.
Un identifiant de commande Agora ne garantit pas la déduplication côté harness.

Cette récupération ciblée est nécessaire. Elle ne réintroduit pas une boucle qui
réévalue en permanence toutes les dépendances et toute la configuration souhaitée.

## Credentials et isolation

La sandbox reçoit une autorisation limitée d'utiliser Agent Vault ; les credentials
des services et les pouvoirs d'administration restent hors de la sandbox.

Les restrictions doivent correspondre à ce qu'Agent Vault et le service cible savent
réellement appliquer. Une permission ACP, un outil installé ou une instruction donnée
au modèle ne constituent pas une restriction d'accès au service.

Proposition initiale : fixer les droits pour une incarnation d'exécution. Un changement
de droits passe par un remplacement contrôlé plutôt que par une modification à chaud.
La portée, la durée, le renouvellement éventuel et la révocation du jeton du proxy
doivent être vérifiés sur l'intégration retenue.

Les clients HTTP doivent respecter le proxy et sa chaîne de confiance. La politique
réseau ferme les chemins permettant de contourner les restrictions attendues.
Une indisponibilité acceptable ne signifie pas qu'un élargissement des droits l'est.

## Arrêt et nettoyage

Agora ferme les nouveaux envois, demande l'annulation si nécessaire, retire l'accès
au proxy selon son contrat, puis demande l'arrêt à Agent Sandbox. Ces demandes doivent
survivre à un redémarrage d'Agora. La conservation du contexte ne doit pas bloquer
indéfiniment un arrêt demandé.

L'expiration et le reaper côté infrastructure nettoient aussi les ressources dont
Agora a perdu la trace. Ils ne remplacent pas le traitement d'une demande explicite
d'arrêt, et ne garantissent pas une terminaison instantanée.

Avant d'autoriser un remplacement, il faut décider quelle preuve empêche l'ancienne
exécution de continuer à modifier des fichiers ou appeler des services. Une ressource
absente de l'API ne suffit pas en cas de partition réseau. Si l'infrastructure ne
fournit pas cette garantie, le remplacement reste bloqué ou une garantie plus faible
doit être explicitement acceptée. Agora ne construira pas un système de fencing maison.

## Continuité du travail

Trois données ont des garanties différentes :

| Donnée | Garantie proposée |
| --- | --- |
| Historique produit | Durable après acceptation par Agora. |
| Contexte natif du harness | Reprise seulement si l'intégration la démontre. |
| Fichiers et artefacts | Dépendent d'une politique de stockage explicite, indépendante du journal. |

Un volume persistant peut préserver des fichiers sans préserver le processus. Un
transcript sauvegardé ne suffit pas à garantir la cohérence avec ces fichiers.

Les mécanismes antérieurs de Save, Anchor et Handoff sont à réexaminer. Ils ne sont
pas requis d'avance. Si une reprise native fiable n'est pas disponible, Agora conserve
l'historique et propose explicitement un nouveau contexte avec les éléments choisis.
Il ne présente pas cette opération comme une restauration exacte.

La compaction interne appartient au harness. Agora ne cherche pas à prouver après
chaque message que le modèle possède toujours tout l'historique.

## Pannes visibles

| Incident | Réaction attendue |
| --- | --- |
| Navigateur déconnecté | L'exécution peut continuer ; l'interface relit l'historique au retour. |
| Agora redémarre | Retrouver la cible et les commandes ; aucun renvoi aveugle. |
| ACP se déconnecte pendant un tour | Reconnexion ciblée ; résultat incertain tant qu'il n'est pas établi. |
| Harness ou sandbox perdu | Historique conservé ; reprise selon les données réellement disponibles. |
| Agent Vault refuse ou ne répond pas | Erreur de l'opération, sans escalade automatique des droits. |
| Stockage du journal indisponible | Suspendre les nouveaux envois et appliquer une backpressure bornée ; ne pas annoncer une durabilité absente. |
| Ancienne exécution impossible à arrêter | Nettoyage confié à l'infrastructure ; aucun remplacement annoncé sûr sans preuve. |

## Décisions à fermer avant implementation

1. Valider le périmètre fonctionnel et la définition des Sessions.
2. Définir le stockage du workspace et la reprise réellement promise pour chaque harness.
3. Vérifier le contrat Agent Vault : droits, jetons, révocation et clients compatibles.
4. Définir le contrat Agent Sandbox : création idempotente, identité du processus,
   arrêt, expiration, stockage et remplacement après panne.
5. Spécifier l'ordre des commandes, la récupération des envois incertains et les
   limites de buffering lorsque le journal est indisponible.
6. Définir l'accès des utilisateurs, les permissions ACP et la rétention des données.

## Validation et réutilisation

La première tranche doit démontrer : ouverture d'une sandbox, échange ACP journalisé,
rechargement de l'interface, redémarrage d'Agora pendant un tour, arrêt puis nettoyage.
Ajouter un refus du proxy et une perte du harness pour vérifier les erreurs visibles.

Chaque récupération de code ancien doit nommer la fonctionnalité servie, ses dépendances
et les scénarios qui la valident. Le journal, le transport ACP, les projections,
l'interface et les intégrations de harness sont des candidats, pas des acquis.

Les anciens moteurs de réconciliation, contrôleurs d'infrastructure et modèles de
grants ne définissent aucune obligation pour ce design.
