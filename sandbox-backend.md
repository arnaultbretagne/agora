# Le back-end des sandboxes

Contrat à implémenter — la partie d'Agora qui tient les sandboxes.

**Le back-end crée les claims, relaie ACP en suivant les tours et ré-arme l'échéance
pendant un tour. L'infrastructure détruit ; le Pod pousse son anchor en partant ; le
back-end le stocke.**

Il s'appuie sur [l'interface avec Agent Sandbox](agent-sandbox.md) et sur
[le contrat de l'image](sandbox-image.md). Les choix sont résumés dans [l'ADR](adr-backend.md).

## Qui fait quoi ?

- **Le back-end** tient une seule connexion par bridge, suit les tours, ré-arme
  l'échéance, reçoit et restaure les anchors. Il ne supprime jamais rien.
- **Le consommateur** ouvre le relais ACP d'un sandbox, envoie ses requêtes, reçoit
  les trames numérotées. Demain, c'est le journal d'Agora ; aujourd'hui, c'est le banc.
- **Le stockage des anchors** est durable et côté Agora : un volume du back-end
  pour le banc, la base d'Agora ensuite.

## Les ressources

| Ressource | Contenu |
| --- | --- |
| **Pool** | Nom, harness, template, image, stock chaud demandé et prêt. |
| **Sandbox** | Nom du claim, pool, identifiant de demande, état et sa raison, lancement chaud ou froid, Pod, échéance, instance du bridge, réponse d'`initialize`, session, tour en cours, dernière position, réglages. |
| **Anchor** | Identifiant, harness, session, fichiers, taille, sandbox d'origine, date. |
| **Fin** | Sandbox, dernier état connu, anchor reçu ou raison de son absence, date. Gardée pour l'historique. |

## L'API

| Route | Rôle |
| --- | --- |
| `GET /api/pools` | Le catalogue. |
| `GET /api/sandboxes` | Les sandboxes vivants et les fins récentes. |
| `GET /api/events` | Flux SSE : l'état complet au départ, puis chaque sandbox changé, entier. |
| `POST /api/sandboxes` | Créer : identifiant de demande, pool, anchor à restaurer (optionnel), réglages. |
| `POST /api/sandboxes/{nom}/stop` | Arrêter : fermer les envois, annuler le tour, cesser de renouveler. |
| `GET /api/sandboxes/{nom}/acp` | WebSocket : le relais ACP du consommateur. |
| `GET /api/anchors` | Les anchors stockés. |
| `GET /api/anchors/{id}/content` | Le contenu d'un anchor. |

Sur un port à part, **8081**, ouvert aux seuls sandboxes :

| Route | Rôle |
| --- | --- |
| `POST /anchors` | Recevoir l'anchor poussé par un Pod en fin de vie. |

Chaque commande répond *acceptée* ou *refusée, avec la raison* : pool inconnu, quota
atteint, identifiant de demande déjà pris par une autre demande, sandbox inconnu,
arrêt déjà demandé.

Les réglages d'un sandbox ont des bornes : de 60 à 600 s pour le bail, de 30 à 3 600 s
pour la durée maximale d'un tour. Les défauts sont ceux du
[contrat Agent Sandbox](agent-sandbox.md#un-bail-de-10-minutes-un-tour-de-1-heure-maximum).

## L'échéance

| Moment | `shutdownTime` |
| --- | --- |
| Création | maintenant + bail |
| Prompt admis | Un seul PATCH : début du tour et maintenant + bail. S'il échoue, le prompt est refusé. |
| Chaque minute d'un tour | min(maintenant + bail, début du tour + durée maximale) |
| Fin du tour confirmée | maintenant + bail, puis plus rien jusqu'au prompt suivant |
| Arrêt demandé | Plus rien ; `session/cancel` si un tour est en cours |
| Adaptateur perdu, processus remplacé | Plus rien |

Un tour dont la fin n'a pas pu être vue reste renouvelé jusqu'à sa durée maximale.

## Les états d'un sandbox

| État | Sens | Ce qui le prouve |
| --- | --- | --- |
| **démarrage** | Claim créé, pas encore prêt. | `Ready` faux ; raison du claim, raison d'attente du Pod. |
| **connexion** | Claim prêt, bridge pas encore joint. | `Ready` vrai, pas de `hello`. |
| **restauration** | Anchor déposé, reprise en cours. | `PUT /anchor` puis `session/resume` en cours. |
| **prêt** | Bridge joint, adaptateur vivant, pas de tour. | `hello`. |
| **en tour** | `session/prompt` envoyé, réponse finale pas encore reçue. | Annotation `agora.bretagne.dev/turn`. |
| **incertain** | La fin du tour n'a pas pu être vue. | `gap` au rejeu. |
| **perdu** | L'adaptateur est mort ou le processus a été remplacé. | `hello` ; instance différente de l'annotation. |
| **arrêté** | Envois fermés, plus de renouvellement. | Annotation `agora.bretagne.dev/stopped`. |
| **erreur** | Le claim n'aboutira pas. | Raison du claim, par exemple `WarmPoolNotFound`. |
| **fin de vie** | L'infrastructure supprime le claim ; l'anchor est attendu. | `deletionTimestamp` sur le claim. |

Le sandbox quitte la liste quand son anchor est reçu ou quand son claim a disparu. La
ligne de fin garde l'anchor, ou la raison de son absence.

## Le relais du consommateur

| Règle | Détail |
| --- | --- |
| Reçu par le consommateur | Les trames `{seq, acp}` du bridge, telles quelles ; `{local}`, les réponses du back-end lui-même (`initialize`, refus) ; des `{event}` d'état. |
| Reprise | `?after=N` rejoue ce que le back-end a encore en mémoire après N, avec `gap` s'il en manque. |
| `initialize` | Le back-end répond lui-même avec la réponse gardée par le bridge. |
| `session/prompt` | Refusé par une erreur JSON-RPC si le sandbox n'est pas prêt, si un tour est en cours, ou s'il est arrêté. |
| Fin du tour | La réponse à ce `session/prompt`, résultat ou erreur. |
| `session/new`, `session/load`, `session/resume` | Leur réponse fixe la session à reprendre après une restauration. |
| Permissions | `session/request_permission` va au consommateur et attend sa réponse, même s'il est parti. |
| Identifiants | Les requêtes du back-end portent des identifiants `agora-…`, jamais numériques. |

## La réception de l'anchor

1. Le Pod pousse, avec son jeton projeté.
2. Le back-end fait valider le jeton par l'API Kubernetes (`TokenReview`, audience
   `agora-anchors`) : il en tire le namespace et le nom du Pod.
3. Il retrouve le claim de ce Pod, stocke l'anchor avec la session notée sur le claim.
4. Un jeton refusé, un Pod d'un autre namespace ou sans claim : 401 ou 404, rien n'est stocké.

Sans poussée reçue avant la disparition du claim, la fin est notée sans anchor.

## Redémarrage du back-end

1. LIST des claims labellisés : c'est tout l'état, claims en suppression compris.
2. Chaque claim prêt : connexion au bridge avec `after` = la position notée au début
   du tour en cours, sinon en direct.
3. Le rejeu contient la réponse finale : le tour se clôt normalement. Il y a un trou :
   le sandbox passe *incertain*. L'instance a changé : il passe *perdu*.
4. Le renouvellement reprend pour les tours en cours.

## Restauration

Créer avec un anchor : le claim note `agora.bretagne.dev/restore-anchor`. Une fois
le bridge joint, le back-end dépose l'anchor (`PUT /anchor`). Il envoie ensuite
`session/resume` avec la session de l'anchor et le workspace du `hello`, ou
`session/load` si l'agent n'annonce pas `sessionCapabilities.resume`. Enfin, il note
`agora.bretagne.dev/restored` et la session. Un échec laisse le sandbox en *erreur*.

## Le banc

Le banc est une page servie par le back-end, sur `agora-lab.bretagne.dev`, derrière
Pocket-ID. Ces routes n'existent que dans le banc.

| Route de banc | Effet |
| --- | --- |
| `POST /api/lab/sandboxes/{nom}/drop-bridge` | Coupe la connexion au bridge ; le back-end se reconnecte avec rejeu. |
| `POST /api/lab/sandboxes/{nom}/probe-auth` | Tente le bridge sans jeton, avec un jeton expiré, pour un autre sandbox, signé par une autre clé. |
| `POST /api/lab/restart` | Arrête le processus du back-end ; Kubernetes le relance. |

Le harness **mock** du banc est un agent ACP sans modèle. Selon le texte du prompt, il
répond en écho numéroté, dort, se tait, demande une permission, produit un outil ou
un long texte, ou meurt. Il écrit un vrai fichier natif et le relit à `session/resume` :
une restauration se vérifie en lui demandant ce qu'on lui a dit avant.

## Les cas à valider

| # | Cas | Attendu |
| --- | --- | --- |
| 1 | Créer depuis un pool chaud | Prêt en moins d'une seconde, lancement `warm`. |
| 2 | Créer au-delà du stock chaud | Prêt en quelques secondes, lancement `cold`. |
| 3 | Créer deux fois avec le même identifiant | Même sandbox, un seul claim. |
| 4 | Pool hors catalogue, quota atteint | Refusé, avec la raison. |
| 5 | Relais : `initialize`, `session/new`, prompt | Réponse d'`initialize` du bridge, trames numérotées, tour clos. |
| 6 | Second prompt pendant un tour | Refusé par une erreur JSON-RPC. |
| 7 | Annuler un tour | Fin `cancelled`, sandbox prêt. |
| 8 | Permission, consommateur parti puis revenu | La demande est rejouée, la réponse débloque le tour. |
| 9 | Consommateur déconnecté pendant un tour | Le tour continue ; la reprise rend les trames manquées. |
| 10 | Connexion au bridge coupée pendant un tour | Reconnexion, rejeu, tour clos sans trou. |
| 11 | Back-end redémarré pendant un tour | Tour retrouvé par l'annotation et clos par le rejeu. |
| 12 | Échéance pendant un tour | Avance chaque minute, sans dépasser début + durée maximale. |
| 13 | Fin de tour | Échéance à maintenant + bail, puis plus aucun renouvellement. |
| 14 | Échéance atteinte entre deux tours | Détruit par l'infrastructure ; l'anchor arrive pendant la grâce. |
| 15 | Tour trop long | Détruit à début + durée maximale ; l'anchor arrive. |
| 16 | Arrêter | Plus de renouvellement, destruction à l'échéance, anchor reçu. |
| 17 | Arrêter pendant un tour | Tour annulé, puis comme 16. |
| 18 | Restaurer un anchor | Nouveau sandbox, même session, l'agent se souvient. |
| 19 | Adaptateur mort | *Perdu*, plus de renouvellement ; l'anchor part quand même au SIGTERM. |
| 20 | Bridge sans jeton, expiré, pour un autre sandbox, autre clé | 401 à chaque fois. |
| 21 | Poussée d'anchor sans jeton projeté valide | 401, rien n'est stocké. |
| 22 | Harness réel (claude-code) | `initialize` et `session/new` réels ; anchor poussé et restauré. |

**À préciser :** le stockage des anchors dans la base d'Agora, et ce que le journal
fera des trames : il les dédupliquera par position.
