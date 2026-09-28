# Les exécutions

Contrat à implémenter — Agent Sandbox **v1.0.3**, runtime **Kata**.

**Agora demande un sandbox, échange en ACP et fixe son échéance.
Agent Sandbox alloue les ressources et les détruit.**

Une **exécution** est un harness qui tourne dans un sandbox obtenu d'Agent Sandbox. Agora
ne crée aucun sandbox : il demande l'exécution, lui parle en ACP, fixe son échéance, reçoit
son anchor et peut la reprendre depuis un anchor. Ce document réunit l'interface avec Agent
Sandbox, le contrat de l'image, ce que fait Agora, les décisions prises et les cas validés.

## Qui fait quoi ?

- **Agora** construit les images complètes ACP + WebSocket et consomme les claims.
- **infra-k8s** configure les templates, pools par image versionnée, Kata, réseau et ressources.
- **Agent Sandbox** entretient le stock chaud, attribue les sandboxes, expose leur état et les détruit.
- **Le bridge**, dans l'image, lance l'adaptateur ACP, le relaie sans le lire et pousse
  l'anchor quand le Pod se termine.
- **Agora** (paquet `packages/executions`) crée les claims, relaie ACP en suivant les
  tours, ré-arme l'échéance pendant un tour et stocke les anchors. Il ne supprime jamais rien.

Le processus ACP et le serveur WS démarrent dans le pool. Chaque attribution déclenche
son réapprovisionnement ; un sandbox utilisé n'est jamais remis en stock.

Aucun stockage persistant dans un sandbox. Ce que l'agent veut garder, il le pousse
lui-même : du code, une note. Ce qu'Agora garde, c'est l'anchor.

## Agent Sandbox

### Les quatre opérations

| Opération | Agora envoie à Kubernetes | Agora récupère |
| --- | --- | --- |
| **Obtenir** | POST d'un `SandboxClaim` : pool via `spec.warmPoolRef.name`, échéance via `spec.lifecycle.shutdownTime`. | Identité du claim. Allocation chaude ou création à froid. |
| **Observer** | LIST / WATCH des claims. | Conditions `Ready` / `Finished`, `status.sandbox.name` et `status.sandbox.serviceFQDN`. |
| **Renouveler** | PATCH de `spec.lifecycle.shutdownTime`. | Échéance acceptée, absolue, en UTC. |
| **Arrêter** | Rien : Agora cesse de renouveler. | Suppression par l'infrastructure à l'échéance. |

Les claims utilisent `spec.lifecycle.shutdownPolicy: DeleteForeground`.
Les templates activent `service: true` ; port et chemin WS sont définis avec le pool.
Après `Ready=True`, le backend rejoint le Service et établit ACP avec les autorisations
nécessaires. **Le claim précède la connexion WS ; Ready seul ne prouve pas qu'ACP est exécutable.**

L'UI affiche le démarrage, puis la disponibilité ou l'erreur. À l'arrêt, Agora ferme
l'accès et cesse de renouveler ; le sandbox disparaît à l'échéance, sans attente utilisateur.

Le nom du claim vient de la demande : `sbx-` + les 10 premiers caractères hexadécimaux
du SHA-256 de l'identifiant de demande.

### Un bail de 10 minutes, un tour de 1 heure maximum

| Paramètre retenu | Valeur initiale |
| --- | --- |
| Durée du bail | **10 minutes** |
| Renouvellement pendant un tour | **Chaque minute** |
| Durée maximale d'un tour | **1 heure** |

À la création : expiration à `maintenant + 10 min`.
Avant le prompt : enregistrer le début du tour et faire accepter son échéance.
Pendant le tour : renouveler avec

```text
shutdownTime = min(maintenant + 10 min, début du tour + 1 h)
```

Le tour reste ouvert jusqu'à la réponse finale de `session/prompt`. Le renouvellement
continue pendant un outil silencieux ou navigateur fermé. Le début du tour est conservé
après redémarrage ; ni événements ACP ni reconnexions ne repoussent la limite d'une heure.

À la limite, l'infrastructure déclenche la destruction avec le délai de terminaison
du template Kubernetes, sans grâce ACP supplémentaire.

**Entre deux tours :** après une fin confirmée avant expiration, accorder 10 minutes
sans renouvellement. Un nouveau prompt relance le bail si le sandbox est encore utilisable.

### Les cas limites

- **Retry :** conserver le nom de claim de la demande et vérifier son UID avant mutation.
- **Arrêt ou expiration :** aucun renouvellement tardif ne doit les annuler.
- **Coupure ACP :** récupération bornée par l'échéance accordée, sans renvoi automatique du prompt.
- **Nettoyage :** l'expiration ne prouve pas l'arrêt physique immédiat.
- **Chaud ou froid :** `warm` veut dire pris dans le pool, même si ce Sandbox démarre
  encore. `cold` n'arrive que si le pool n'a plus rien.
- **Réseau d'une VM Kata :** les réponses du proxy DNS de Cilium n'y arrivent pas. Aucune
  règle FQDN pour les sandboxes : du DNS simple, et des plages d'adresses.
- **Horloge d'une VM Kata :** l'image invitée lance chrony vers les serveurs NTS d'Ubuntu
  (TCP 4460), que la politique réseau rejette en boucle. Synchro désactivée
  (`systemd.mask=chrony.service` dans les paramètres noyau de Kata) : l'heure vient de
  kvm-clock, qui suit l'hôte.

## L'image

### Démarrage, dans le pool

1. Créer le workspace fixe `/home/harness/work`.
2. Lancer l'adaptateur par son entrée *bin*, stdio en pipes.
3. Envoyer `initialize` une seule fois (`fs` et `terminal` à *non*), garder la réponse.
4. Répondre prêt sur `/healthz`.

Tout cela se passe avant le claim, sans utilisateur ni credential. codex refuse un second
`initialize` : Agora ne le renvoie jamais et sert la réponse gardée par le bridge.

### Les routes du bridge

Port **8080**. Toutes les routes sauf `/healthz` exigent le jeton d'Agora.

| Route | Rôle |
| --- | --- |
| `GET /healthz` | 200 si l'adaptateur vit et a répondu à `initialize`, 503 sinon. C'est la readiness du Pod. |
| `GET /info` | Instance, Pod, workspace, réponse d'`initialize`, état de l'adaptateur, dernière position. |
| `GET /acp` | WebSocket : le relais ACP. |
| `PUT /anchor` | Restaure un anchor avant la reprise de la session. |

Le jeton est signé **Ed25519** par Agora, nomme le sandbox visé et expire après
**60 secondes**. Le bridge le vérifie avec la clé publique d'Agora et compare le nom à
celui de son propre Pod : le sandbox ne contient aucun secret. En plus, la NetworkPolicy
n'admet en entrée qu'Agora.

### Le relais

| Règle | Détail |
| --- | --- |
| Un seul client | La connexion la plus récente gagne ; l'ancienne est fermée (4000). Toutes les connexions ACP numérotent leurs requêtes depuis 0 : deux clients se voleraient leurs réponses. |
| Premier message | `hello` : instance, Pod, workspace, réponse d'`initialize`, état de l'adaptateur, rejeu et `gap`. |
| Vers le client | Chaque ligne de l'adaptateur devient `{seq, acp}` : `seq` croît pour l'instance, `acp` est la ligne brute. |
| Vers l'adaptateur | Chaque message texte du client est une ligne ACP brute. |
| Sans client | Les lignes sont gardées : les 2 000 dernières, 16 Mio au plus. |
| Rejeu | `?after=N` rejoue ce qui suit la position N, avec `gap` s'il en manque. |

Si l'adaptateur meurt, le bridge reste vivant : `/healthz` passe à 503, `hello` et `/info`
donnent le code de sortie, et l'anchor partira avec le Pod.

### La fin du Pod et l'anchor

À l'échéance, Agent Sandbox supprime le claim, puis son Sandbox et son Pod. Le bridge
reçoit SIGTERM et dispose du délai de terminaison du template, **30 secondes** :

1. fermer le relais et refuser toute nouvelle connexion ;
2. arrêter l'adaptateur : SIGTERM, puis SIGKILL après 5 secondes ;
3. lire en bloc les fichiers natifs du harness, stables entre deux lectures à 250 ms d'écart ;
4. les pousser vers Agora, trois essais au plus ;
5. sortir.

Agora ne tire rien et ne surveille pas la mort du Pod. Sans fichier natif (aucune
session ouverte), le bridge pousse un anchor vide.

L'anchor reprend le travail S9 : les fichiers natifs du harness, et rien d'autre, ni
`.claude.json`, ni fichier d'authentification, ni réglage global
(`harnesses/claude-code/src/driver.ts`, `docs/field-findings.md` §2.2 sur `main`).

| Harness | Dossier natif, sauvegardé en bloc | Reprise |
| --- | --- | --- |
| claude-code | `$HOME/.claude/projects/<slug du workspace>/` | `session/resume` |
| codex | `$HOME/.codex/sessions/` | `session/resume` — à porter |
| mock (banc) | `$HOME/.mock-agent/sessions/<slug du workspace>/` | `session/resume` ou `session/load` |

Le slug est celui de claude-code : chaque caractère hors `[A-Za-z0-9-]` devient `-`.
C'est pourquoi le workspace est le même chemin dans toutes les images.

| Geste | Règle |
| --- | --- |
| **Poussée** | `POST` vers `AGORA_ANCHOR_URL`. Le corps liste chaque fichier : chemin relatif au dossier natif, checksum sha256, contenu. 32 Mio au plus. |
| **Identité du Pod** | `Authorization: Bearer` + le jeton de ServiceAccount projeté par le kubelet (audience `agora-anchors`, 10 minutes, renouvelé jusque dans la VM Kata), relu à chaque poussée. |
| **Restauration** | `PUT /anchor` avec le même corps. Chaque fichier est écrit à côté, relu, comparé, puis renommé. L'adaptateur lit le fichier au `session/resume`, pas au démarrage : un Pod du pool, déjà lancé, peut le recevoir. |

### Ce que le template fournit

| Élément | Valeur |
| --- | --- |
| `runtimeClassName` | `kata` |
| `service` | `true` |
| `restartPolicy` | `Never` |
| `terminationGracePeriodSeconds` | 30 |
| `POD_NAME` | downward API, `metadata.name` : le nom attendu dans le jeton d'Agora |
| `BRIDGE_PUBLIC_KEY` | clé publique d'Agora, depuis la ConfigMap `agora-bridge-key` |
| `AGORA_ANCHOR_URL` | la route de réception des anchors d'Agora |
| Jeton projeté | volume `serviceAccountToken`, audience `agora-anchors`, monté sur `/var/run/agora/token` |
| Readiness | `GET /healthz` sur le port 8080 |
| Ressources | 50m CPU et 512 Mio réservés, 1 CPU et 1 Gio au plus : un sandbox au repos consomme ~1m, et le nœud n'a que 6 cœurs. |
| `HOME` | `emptyDir` monté sur `/home/harness` |
| Utilisateur | 10001, racine en lecture seule, aucune capacité |

Un template et un pool par image, nommés d'après son digest. Changer d'image, c'est un
nouveau template et un nouveau pool, jamais une modification en place.

## Côté Agora

### L'API

| Route | Rôle |
| --- | --- |
| `GET /api/pools` | Le catalogue : les `SandboxWarmPool` portant le label `agora.bretagne.dev/harness`. |
| `GET /api/executions` | Les exécutions vivantes et les fins récentes. |
| `GET /api/events` | Flux SSE : l'état complet au départ, puis chaque exécution changée, entière. |
| `POST /api/executions` | Créer : identifiant de demande, pool, anchor à restaurer (optionnel), réglages. |
| `POST /api/executions/{nom}/stop` | Arrêter : fermer les envois, annuler le tour, cesser de renouveler. |
| `GET /api/executions/{nom}/acp` | WebSocket : le relais ACP du consommateur. |
| `GET /api/anchors` | Les anchors stockés. |
| `GET /api/anchors/{id}/content` | Le contenu d'un anchor. |
| `POST /anchors`, port **8081** | Recevoir l'anchor poussé par un Pod. Seul port ouvert aux sandboxes. |

Chaque commande répond *acceptée* ou *refusée, avec la raison*. Les réglages d'une exécution
ont des bornes : de 60 à 600 s pour le bail, de 30 à 3 600 s pour la durée d'un tour.

### L'échéance

| Moment | `shutdownTime` |
| --- | --- |
| Création | maintenant + bail |
| Prompt admis | Un seul PATCH : début du tour et maintenant + bail. S'il échoue, le prompt est refusé. |
| Chaque minute d'un tour | min(maintenant + bail, début du tour + durée maximale) |
| Fin du tour confirmée | maintenant + bail, puis plus rien jusqu'au prompt suivant |
| Arrêt demandé | Plus rien ; `session/cancel` si un tour est en cours |
| Adaptateur perdu, processus remplacé | Plus rien |

### Les états d'une exécution

| État | Sens | Ce qui le prouve |
| --- | --- | --- |
| **démarrage** | Claim créé, pas encore prêt. | `Ready` faux ; raison du claim, raison d'attente du Pod. |
| **connexion** | Claim prêt, bridge pas encore joint. | `Ready` vrai, pas de `hello`. |
| **restauration** | Anchor déposé, reprise en cours. | `PUT /anchor` puis `session/resume` en cours. |
| **prêt** | Bridge joint, adaptateur vivant, pas de tour. | `hello`. |
| **en tour** | `session/prompt` envoyé, réponse finale pas encore reçue. | Annotation du tour sur le claim. |
| **incertain** | La fin du tour n'a pas pu être vue. | `gap` au rejeu. |
| **perdu** | L'adaptateur est mort ou le processus a été remplacé. | `hello` ; instance différente de celle notée. |
| **arrêté** | Envois fermés, plus de renouvellement. | Annotation d'arrêt sur le claim. |
| **erreur** | Le claim n'aboutira pas. | Raison du claim, par exemple `WarmPoolNotFound`. |
| **fin de vie** | L'infrastructure supprime le claim ; l'anchor est attendu. | `deletionTimestamp` sur le claim. |

L'exécution quitte la liste quand son anchor est reçu ou quand son claim a disparu ; la
ligne de fin garde l'anchor, ou la raison de son absence.

### Le relais du consommateur

Le consommateur est demain le journal d'Agora, aujourd'hui le banc.

| Règle | Détail |
| --- | --- |
| Reçu | Les trames `{seq, acp}` du bridge ; `{local}`, les réponses d'Agora lui-même (`initialize`, refus) ; des `{event}` d'état. |
| Reprise | `?after=N` rejoue ce qu'Agora a encore en mémoire après N, avec `gap` s'il en manque. |
| `session/prompt` | Refusé par une erreur JSON-RPC si l'exécution n'est pas prête, si un tour est en cours, ou si elle est arrêtée. |
| Session | La réponse de `session/new`, `session/load` ou `session/resume` fixe la session qu'un anchor reprendra. |
| Permissions | `session/request_permission` va au consommateur et attend sa réponse, même s'il est parti. |
| Identifiants | Les requêtes d'Agora portent des identifiants `agora-…`, jamais numériques. |

### La réception d'un anchor

Agora fait valider le jeton projeté par l'API Kubernetes (`TokenReview`, audience
`agora-anchors`), en tire le namespace et le Pod, retrouve le claim de ce Pod et stocke
l'anchor avec la session notée sur le claim. Un jeton refusé : 401 ; un Pod sans claim :
404 ; rien n'est stocké. Sans poussée avant la disparition du claim, la fin est notée
sans anchor. Le stockage est un volume du banc ; la base d'Agora ensuite.

### Ce qu'Agora écrit sur le claim

Le claim porte tout ce qu'il faut pour reprendre après un redémarrage d'Agora.

| Clé | Contenu |
| --- | --- |
| label `app.kubernetes.io/managed-by` | `agora` : ce qu'Agora liste et surveille |
| label `agora.bretagne.dev/pool` | le pool demandé |
| `agora.bretagne.dev/request-id` | l'identifiant de demande |
| `agora.bretagne.dev/limits` | bail et durée de tour de cette exécution |
| `agora.bretagne.dev/restore-anchor`, `…/restored` | l'anchor à restaurer, puis la date de reprise |
| `agora.bretagne.dev/instance` | l'instance de bridge vue à la première connexion |
| `agora.bretagne.dev/session-id` | la session qu'un anchor reprendra |
| `agora.bretagne.dev/turn` | le tour en cours : début, identifiant de la requête, position du bridge |
| `agora.bretagne.dev/idle-since` | la fin du dernier tour |
| `agora.bretagne.dev/stopped` | l'arrêt demandé, et sa date |

Au redémarrage : LIST des claims labellisés, puis connexion à chaque bridge avec `after`
= la position notée au début du tour en cours. Le rejeu contient la réponse finale : le
tour se clôt. Un trou : *incertain*. Une autre instance : *perdu*.

### Restauration

Créer avec un anchor. Une fois le bridge joint, Agora dépose l'anchor (`PUT /anchor`)
puis envoie `session/resume`, ou `session/load` si l'agent n'annonce pas
`sessionCapabilities.resume`. Un échec laisse l'exécution en *erreur*.

### Les droits

| Ressource (`agora-sandboxes`) | Verbes |
| --- | --- |
| `sandboxclaims` | get, list, watch, create, patch |
| `sandboxwarmpools`, `sandboxtemplates`, `sandboxes`, `pods` | get, list, watch |
| `tokenreviews` (cluster) | create |

Un quota de namespace borne les ressources ; Agora borne en plus le nombre
d'exécutions actives, un pool n'étant pas une limite de concurrence. Une exécution arrêtée compte
jusqu'à sa destruction.

## Le banc

Le déployable `apps/lab` monte le paquet `executions` et sert une page sur `agora-lab.bretagne.dev`, derrière Pocket-ID (groupe
admin). Elle crée des sandboxes, relaie ACP à la main, montre échéances, anchors et fins,
et offre trois gestes réservés au banc :

| Route | Effet |
| --- | --- |
| `POST /api/lab/executions/{nom}/drop-bridge` | Coupe la connexion au bridge ; Agora se reconnecte avec rejeu. |
| `POST /api/lab/executions/{nom}/probe-auth` | Tente le bridge sans jeton, avec un jeton expiré, pour un autre sandbox, signé par une autre clé. |
| `POST /api/lab/restart` | Arrête le processus du banc ; Kubernetes le relance. |

Le harness **mock** est un agent ACP sans modèle. Selon le texte du prompt, il répond en
écho numéroté, dort, se tait, demande une permission, produit un outil ou un long texte,
ou meurt. Il écrit un vrai fichier natif et le relit à `session/resume`.

## Décisions et options écartées

Proposées le 27 septembre 2026.

| Sujet | Retenu |
| --- | --- |
| **Exécution** | Agent Sandbox : un `SandboxClaim` par demande, pris dans un pool chaud. |
| **Isolation** | Kata : une VM par Pod, RuntimeClass `kata`. |
| **Durée de vie** | Agora fixe `shutdownTime`, le ré-arme pendant un tour, accorde un bail après. |
| **Destruction** | Seulement par l'infrastructure, à l'échéance. |
| **Anchor** | Les fichiers natifs du harness, en bloc, poussés par le Pod à sa fin. |
| **Identité du Pod** | Jeton de ServiceAccount projeté, vérifié par `TokenReview`. |
| **Accès au bridge** | Le Service du Sandbox, jeton Ed25519 d'Agora lié au nom du Pod. |
| **État d'Agora** | Écrit sur le claim. |

| Écarté | Pourquoi |
| --- | --- |
| Agora supprime claims ou Pods | Un seul acteur détruit : l'infrastructure. Pas de reaper, pas de droit `delete`. |
| Contrôleur de Pods ou reaper maison | Agent Sandbox le fait déjà. |
| Volume persistant (PVC) dans le sandbox | Contraire au principe, et un PVC sur le claim force le démarrage à froid. |
| Renouveler entre deux tours | Le bail accordé après le tour suffit ; ensuite l'infrastructure reprend la ressource. |
| Agora tire l'anchor pendant la grâce | Course entre son WATCH et la mort du Pod ; le Pod sait seul quand il meurt. |
| Sauvegarde à chaque tour | L'anchor ne sert qu'à la fin du Pod ; avant, le sandbox vivant fait foi. |
| Le Pod écrit dans la base d'Agora | Aucun identifiant de base dans un sandbox non fiable. |
| Secret ou identité injectés par le claim | Force le démarrage à froid et met un secret dans le sandbox. |
| Joindre le Pod par son IP | Le Service est la brique native ; le Pod n'a plus à être joint pendant sa grâce. |
| Règles réseau par nom de domaine | Les réponses du proxy DNS de Cilium n'arrivent pas dans une VM Kata. |
| gVisor pour ces sandboxes | Kata retenu après l'évaluation du 22 septembre. |
| Router amont d'Agent Sandbox | Agora relaie lui-même le WebSocket. |

Conséquences : un arrêt libère la ressource au plus un bail plus tard ; si Agora est
injoignable pendant la grâce, le sandbox part sans anchor ; un tour ne dépasse pas une
heure ; reprendre depuis un anchor ouvre une nouvelle session et repaie tout le contexte.

## Les cas à valider

Joués le 27 septembre sur g4, sous Kata, par `apps/lab/scripts/live-cases.ts` :
**22 sur 22**. Les cas d'échéance utilisent un bail de 60 s,
ré-armé trois fois par bail.

| # | Cas | Attendu | Mesuré |
| --- | --- | --- | --- |
| 1 | Créer depuis un pool chaud | Prêt en moins d'une seconde, lancement `warm`. | Prêt en 0,29 s, `warm`. |
| 2 | Créer au-delà du stock chaud | Prêt en quelques secondes : `cold`, ou `warm` sur un Sandbox du pool encore en démarrage. | Un `warm` en 0,55 s, puis deux `cold` en 3,8 et 4,9 s ; au passage précédent, deux `warm` en 2,9 s. |
| 3 | Créer deux fois avec le même identifiant | Même exécution, un seul claim. | Même nom, un seul claim. |
| 4 | Pool hors catalogue, quota atteint | Refusé, avec la raison. | 400 « pool hors catalogue » ; 429 « quota atteint : 6 exécutions actives sur 6 ». |
| 5 | Relais : `initialize`, `session/new`, prompt | Réponse d'`initialize` du bridge, trames numérotées, tour clos. | `initialize` local, positions 1 → 3, `end_turn`. |
| 6 | Second prompt pendant un tour | Refusé par une erreur JSON-RPC. | « refusé : un tour est déjà en cours ». |
| 7 | Annuler un tour | Fin `cancelled`, exécution prête. | `cancelled`, exécution prête. |
| 8 | Permission, consommateur parti puis revenu | La demande est rejouée, la réponse débloque le tour. | Demande rejouée, tour clos. |
| 9 | Consommateur déconnecté pendant un tour | Le tour continue ; la reprise rend les trames manquées. | 7 trames rejouées, sans trou. |
| 10 | Connexion au bridge coupée pendant un tour | Reconnexion, rejeu, tour clos sans trou. | Rejeu depuis la position 18, tour clos. |
| 11 | Agora redémarré pendant un tour | Tour retrouvé par l'annotation et clos par le rejeu. | Tour retrouvé *en tour* au redémarrage, clos `end_turn`. |
| 12 | Échéance pendant un tour | Avance chaque minute, sans dépasser début + durée maximale. | Échéance repoussée pendant le tour, sous la limite. |
| 13 | Fin de tour | Échéance à maintenant + bail, puis plus aucun renouvellement. | Échéance fixée à la fin du tour, inchangée 25 s après. |
| 14 | Échéance atteinte entre deux tours | Détruit par l'infrastructure ; l'anchor arrive pendant la grâce. | Détruit par Agent Sandbox ; anchor poussé (1 fichier). |
| 15 | Tour trop long | Détruit à début + durée maximale ; l'anchor arrive. | Détruit à début + 30 s ; anchor poussé. |
| 16 | Arrêter | Plus de renouvellement, destruction à l'échéance, anchor reçu. | *Arrêté*, détruit à l'échéance ; anchor avec le texte du tour. |
| 17 | Arrêter pendant un tour | Tour annulé, puis comme 16. | Tour `cancelled`, détruit à l'échéance ; anchor poussé. |
| 18 | Restaurer un anchor | Nouvelle exécution, même session, l'agent se souvient. | Prêt en 0,37 s, session reprise, souvenir intact. |
| 19 | Adaptateur mort | *Perdu*, plus de renouvellement ; l'anchor part quand même avec le Pod. | *Perdu* ; anchor poussé malgré l'adaptateur mort. |
| 20 | Bridge sans jeton, expiré, pour un autre sandbox, autre clé | 401 à chaque fois. | 401 partout ; jeton valide 200 / 101. |
| 21 | Poussée d'anchor sans jeton projeté valide | 401, rien n'est stocké. | 401 sans jeton, 401 avec un faux. |
| 22 | Harness réel (claude-code) | `initialize` et `session/new` réels ; anchor poussé et restauré. | 401 d'Anthropic au prompt ; anchor de 11 915 o poussé, restauré par `session/resume`. |

**À préciser :** credentials des harnesses (Agent Vault), stockage des anchors en base,
dossier natif de codex, tâches détachées, reprise après perte du processus.

Références : [SandboxClaim v1.0.3](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/extensions/api/v1beta1/sandboxclaim_types.go) ;
mesures Kata dans `docs/agent-sandbox-evaluation.md` du dépôt `infra-k8s`.
