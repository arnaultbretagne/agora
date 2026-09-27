# Le back-end des sandboxes

Contrat à implémenter — la partie d'Agora qui tient les sandboxes.

**Le back-end crée les sandboxes, relaie ACP en suivant les tours, renouvelle le bail
et, avant de supprimer, sauvegarde l'anchor. Il ne garde rien que le claim et le
stockage des anchors ne sachent déjà.**

Il s'appuie sur [l'interface avec Agent Sandbox](agent-sandbox.md) et sur
[le contrat de l'image](sandbox-image.md).

## Qui fait quoi ?

- **Le back-end** tient une seule connexion par bridge, suit les tours, renouvelle,
  décide les suppressions, capture et restaure les anchors.
- **Le consommateur** ouvre le relais ACP d'un sandbox, envoie ses requêtes, reçoit
  les trames numérotées. Demain, c'est le journal d'Agora ; aujourd'hui, c'est le banc.
- **Le stockage des anchors** est durable et côté Agora : un volume du back-end
  pour le banc, la base d'Agora ensuite.

## Les ressources

| Ressource | Contenu |
| --- | --- |
| **Pool** | Nom, harness, template, image, stock chaud demandé et prêt. |
| **Sandbox** | Nom du claim, pool, identifiant de demande, état et sa raison, lancement chaud ou froid, Pod, échéance, instance du bridge, réponse d'`initialize`, session, tour en cours, dernière position, réglages. |
| **Anchor** | Identifiant, harness, session, taille, checksum, sandbox d'origine, raison de la capture, date. |
| **Suppression** | Sandbox, raison, anchor obtenu ou raison de son absence, date. Gardée pour l'historique. |

## L'API

| Route | Rôle |
| --- | --- |
| `GET /api/pools` | Le catalogue. |
| `GET /api/sandboxes` | Les sandboxes vivants et les suppressions récentes. |
| `GET /api/events` | Flux SSE : l'état complet au départ, puis chaque sandbox changé, entier. |
| `POST /api/sandboxes` | Créer : identifiant de demande, pool, anchor à restaurer (optionnel), réglages. |
| `POST /api/sandboxes/{nom}/stop` | Arrêter : capture, puis suppression. |
| `GET /api/sandboxes/{nom}/acp` | WebSocket : le relais ACP du consommateur. |
| `GET /api/anchors` | Les anchors stockés. |
| `GET /api/anchors/{id}/content` | Les octets d'un anchor. |

Chaque commande répond *acceptée* ou *refusée, avec la raison* : pool inconnu, quota
atteint, identifiant de demande déjà pris par une autre demande, sandbox inconnu,
arrêt déjà en cours.

Les réglages d'un sandbox (bail, inactivité, durée de tour) ont des bornes : de 60 à
600 s pour le bail, de 30 à 3 600 s pour les deux autres. Les défauts sont ceux du
[contrat Agent Sandbox](agent-sandbox.md#le-bail--un-filet-pas-une-décision).

## Les états d'un sandbox

| État | Sens | Ce qui le prouve |
| --- | --- | --- |
| **démarrage** | Claim créé, pas encore prêt. | `Ready` faux ; raison du claim, raison d'attente du Pod. |
| **connexion** | Claim prêt, bridge pas encore joint. | `Ready` vrai, pas de `hello`. |
| **restauration** | Anchor déposé, reprise en cours. | `PUT /anchor` puis `session/resume` en cours. |
| **prêt** | Bridge joint, adaptateur vivant, pas de tour. | `hello`. |
| **en tour** | `session/prompt` envoyé, réponse finale pas encore reçue. | Annotation `agora.bretagne.dev/turn`. |
| **incertain** | La fin du tour n'a pas pu être vue. | `gap` au rejeu, ou instance différente. |
| **perdu** | L'adaptateur est mort ou le processus a été remplacé. | `hello` ou `/info` ; instance différente de l'annotation. |
| **erreur** | Le claim n'aboutira pas. | Raison du claim, par exemple `WarmPoolNotFound`. |
| **arrêt** | Envois fermés : capture, puis suppression. | Décision du back-end. |

Un sandbox quitte la liste dès que sa suppression est acceptée. Une ligne de
suppression garde la raison et l'anchor.

## Le relais du consommateur

| Règle | Détail |
| --- | --- |
| Reçu par le consommateur | Les trames `{seq, acp}` du bridge, telles quelles ; `{local}`, les réponses du back-end lui-même (`initialize`, refus) ; des `{event}` d'état. |
| Reprise | `?after=N` rejoue ce que le back-end a encore en mémoire après N, avec `gap` s'il en manque. |
| `initialize` | Le back-end répond lui-même avec la réponse gardée par le bridge. |
| `session/prompt` | Refusé par une erreur JSON-RPC si le sandbox n'est pas prêt, si un tour est en cours, ou si l'arrêt est décidé. Sinon, PATCH du claim (début du tour, échéance), puis envoi. |
| Fin du tour | La réponse à ce `session/prompt`, résultat ou erreur. Le back-end note alors `idle-since`. |
| `session/new`, `session/load`, `session/resume` | Leur réponse fixe la session que l'anchor capturera. |
| Permissions | `session/request_permission` va au consommateur et attend sa réponse, même s'il est parti. |
| Identifiants | Les requêtes du back-end portent des identifiants `agora-…`, jamais numériques. |

## Quand le back-end supprime

| Raison | Déclencheur |
| --- | --- |
| Arrêt demandé | `POST …/stop` |
| Inactivité | Aucun tour depuis la durée d'inactivité. |
| Tour trop long | Début du tour + durée maximale dépassés. |
| Adaptateur perdu | `hello` ou `/info` disent l'adaptateur mort. |
| Processus remplacé | Le bridge répond avec une autre instance que celle notée sur le claim. |
| Démarrage trop long | Pas en service 5 minutes après la création, ou après le redémarrage du back-end. |
| Erreur | Le claim n'aboutira pas (`WarmPoolNotFound`…) : suppression après 1 minute. |

Séquence : fermer les envois, puis `session/cancel` si un tour est en cours, avec une
attente de sa fin de 20 s au plus. Ensuite, capturer l'anchor de la session, puis
envoyer le DELETE. Sans anchor possible (pas de session, fichier absent, bridge
injoignable), la suppression a lieu quand même et la raison est notée.

## Redémarrage du back-end

1. LIST des claims labellisés : c'est tout l'état.
2. Chaque claim prêt : connexion au bridge avec `after` = la position notée au début
   du tour en cours, sinon en direct.
3. Le rejeu contient la réponse finale : le tour se clôt normalement. Il y a un trou,
   ou l'instance a changé : le sandbox passe *incertain* ou *perdu*.
4. Le renouvellement reprend. Absent plus de 10 minutes, le back-end retrouve ses
   sandboxes expirés sans anchor.

## Restauration

Créer avec un anchor : le claim note `agora.bretagne.dev/restore-anchor`. Une fois
le bridge joint, le back-end dépose l'anchor (`PUT /anchor`). Il envoie ensuite
`session/resume` avec le `sessionId` de l'anchor et le workspace du `hello`, ou
`session/load` si l'agent n'annonce pas `sessionCapabilities.resume`. Enfin, il note
`agora.bretagne.dev/restored` et la session. Un échec laisse le sandbox en *erreur*,
sans nouvelle tentative.

## Le banc

Le banc est une page servie par le back-end, sur `agora-lab.bretagne.dev`, derrière
Pocket-ID. Ces routes n'existent que dans le banc.

| Route de banc | Effet |
| --- | --- |
| `POST /api/lab/sandboxes/{nom}/drop-bridge` | Coupe la connexion au bridge ; le back-end se reconnecte avec rejeu. |
| `POST /api/lab/sandboxes/{nom}/pause-renewal` | Arrête de renouveler ce claim, pour voir l'échéance de secours. |
| `POST /api/lab/sandboxes/{nom}/probe-auth` | Tente le bridge sans jeton, avec un jeton expiré, avec le jeton d'un autre sandbox. |
| `POST /api/lab/sandboxes/{nom}/delete-pod` | Supprime le Pod seul. |
| `POST /api/lab/restart` | Arrête le processus du back-end ; Kubernetes le relance. |

Le harness **mock** du banc est un agent ACP sans modèle. Selon le texte du prompt, il
répond en écho numéroté, dort, se tait, demande une permission, produit un outil ou
un long texte, ou meurt. Il écrit un vrai fichier natif et le relit à `session/resume` :
une restauration se vérifie en lui demandant ce qu'on lui a dit avant.

## Les cas à valider

Tous joués le 27 septembre sur g4, sous Kata, par `sandbox/scripts/live-cases.ts`
(branche `spike/sandbox-backend`) : **22 sur 22**. La page du banc offre les mêmes gestes à la main.

| # | Cas | Attendu | Mesuré |
| --- | --- | --- | --- |
| 1 | Créer depuis un pool chaud | Prêt en moins d'une seconde, lancement `warm`. | Prêt en 0,36 s, `warm`. |
| 2 | Créer au-delà du stock chaud | Prêt en quelques secondes, lancement `cold`. | Deux `cold` en 5,3 s, un `warm` en 0,44 s. |
| 3 | Créer deux fois avec le même identifiant | Même sandbox, un seul claim. | Même nom, un claim. |
| 4 | Créer sur un pool hors catalogue, ou au-delà du quota | Refusé, avec la raison. | 400 « pool hors catalogue », 429 « quota atteint : 4 sur 4 ». |
| 5 | Relais : `initialize`, `session/new`, prompt | Réponse d'`initialize` du bridge, trames numérotées, tour clos. | `initialize` local, positions 1 → 3, `end_turn`. |
| 6 | Second prompt pendant un tour | Refusé par une erreur JSON-RPC. | « refusé : un tour est déjà en cours ». |
| 7 | Annuler un tour | Fin `cancelled`, sandbox prêt. | Conforme. |
| 8 | Permission, consommateur parti puis revenu | La demande est rejouée, la réponse débloque le tour. | Conforme. |
| 9 | Consommateur déconnecté pendant un tour | Le tour continue ; la reprise avec `after` rend les trames manquées. | 7 trames rejouées, sans trou. |
| 10 | Connexion au bridge coupée pendant un tour | Reconnexion, rejeu, tour clos sans trou. | Rejeu depuis la position 18, tour clos. |
| 11 | Back-end redémarré pendant un tour | Tour retrouvé par l'annotation et clos par le rejeu. | Retrouvé *en tour*, clos `end_turn`. |
| 12 | Bail renouvelé | L'échéance avance chaque minute, en tour comme en attente. | +60 s hors tour. |
| 13 | Renouvellement suspendu | Le claim expire à l'échéance, sans anchor. | Disparu à l'échéance, sans anchor. |
| 14 | Inactivité | Capture, puis suppression ; anchor listé avec la raison. | Conforme (inactivité réglée à 30 s). |
| 15 | Tour trop long | Annulation, capture, suppression. | Conforme (tour réglé à 30 s). |
| 16 | Arrêter | Capture, suppression, disparition immédiate de la liste. | Anchor de 1 350 o. |
| 17 | Arrêter pendant un tour | Annulation, capture, suppression. | Conforme. |
| 18 | Restaurer un anchor | Nouveau sandbox, même session, l'agent se souvient. | Prêt en 0,39 s, même session, souvenir intact. |
| 19 | Adaptateur mort | Sandbox *perdu*, anchor capturé quand même, suppression. | Conforme. |
| 20 | Pod supprimé seul | Nouvelle instance détectée, sandbox *perdu*. | « processus remplacé ». |
| 21 | Bridge sans jeton, jeton expiré, jeton d'un autre sandbox | 401 à chaque fois. | 401 partout, jeton valide 200 / 101. |
| 22 | Harness réel (claude-code) | `initialize` et `session/new` réels, anchor capturé et restauré. | Sans credential, le prompt échoue (401). Anchor de 11 756 o restauré par `session/resume`. |

**À préciser :** le stockage des anchors dans la base d'Agora, et ce que le journal
fera des trames : il les dédupliquera par position.
