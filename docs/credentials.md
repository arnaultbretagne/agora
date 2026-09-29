# Les credentials d'une exécution

Contrat à implémenter — agentgateway **1.5.0**, sur les exécutions (`executions.md`). La décision
et les options essayées sont dans l'ADR de la passerelle.

**Le sandbox ne contient aucun secret. Il sort par la passerelle d'Agora, qui vérifie chaque
requête contre les droits de l'exécution et pose le credential au passage.**

Un harness a besoin de credentials : Claude, GitHub. Ils n'entrent jamais dans le sandbox. Sa
seule sortie est la passerelle : elle termine TLS, décide si la requête est permise et pose
l'en-tête d'authentification de l'hôte. L'exécution ne détient qu'un **JWT court signé par
Agora**, qui liste ses droits. Agora le remet au bridge après le claim, ce qui garde le pool
chaud.

## Qui fait quoi ?

- **L'opérateur** range les credentials en Secret SOPS dans infra-k8s.
- **La passerelle** (agentgateway) garde les credentials, termine TLS avec sa propre autorité de
  certification, vérifie le JWT et les droits, et pose le credential de l'hôte.
- **Agora** compile les profils de l'exécution en droits, les signe et remet le jeton au
  bridge. Il ne voit aucun credential.
- **Le bridge** ouvre au harness un proxy sortant local et fait suivre chaque tunnel à la
  passerelle, avec le jeton.
- **infra-k8s** fournit aux sandboxes l'autorité de certification de la passerelle et ne les
  laisse sortir que vers elle.

## Pourquoi un proxy dans le bridge ?

L'adaptateur démarre dans le pool, avant tout claim : son environnement ne peut porter aucun
jeton. Passer le jeton par le claim force le démarrage à froid (voir
`executions.md`, « Décisions et options écartées »).

Le bridge lance donc l'adaptateur avec `HTTPS_PROXY` pointé sur un proxy à lui, en local,
qui refuse tout tant qu'aucun credential n'est branché. Agora branche le jeton plus tard, par
une route du bridge. Tout harness qui respecte `HTTPS_PROXY` en profite.

Le jeton reste dans la mémoire du bridge : ni dans l'environnement de l'adaptateur, ni sur
disque. L'agent peut emprunter la sortie, pas emporter le jeton, et le réseau ne le laisse
aller nulle part ailleurs.

## Le chemin d'une requête

| Étape | Qui | Quoi |
| --- | --- | --- |
| 1 | Adaptateur → bridge | `CONNECT api.github.com:443` sur `127.0.0.1`. |
| 2 | Bridge → passerelle | Le même `CONNECT` vers `gateway.agora-gateway.svc.cluster.local:3000`, avec `Proxy-Authorization: Bearer` et le JWT. La réponse revient telle quelle à l'adaptateur. |
| 3 | Passerelle | Répond 200, puis termine TLS avec un certificat signé par « Agora gateway CA ». |
| 4 | Adaptateur | Fait confiance à cette autorité par `NODE_EXTRA_CA_CERTS` et envoie sa requête. |
| 5 | Passerelle | Vérifie le JWT et les droits. Pose le credential de l'hôte à la place du `Authorization` reçu, garde les autres en-têtes, suit vers l'hôte. |

| Réponse | Sens |
| --- | --- |
| 503 du bridge, au `CONNECT` | Aucun credential branché sur cette exécution. |
| 502 du bridge, au `CONNECT` | Passerelle injoignable. |
| 401 de la passerelle | JWT absent, expiré ou signé par une autre clé. |
| 403 de la passerelle | Aucun droit de l'exécution ne couvre cet hôte, ce chemin et cette méthode. |
| 404 de la passerelle | Hôte sans route. |

## Le bridge

| Élément | Règle |
| --- | --- |
| `PUT /credentials` | Avec le jeton d'Agora. Le corps donne le proxy (`hôte:port`), le jeton et son expiration. Remplace le jeton précédent : les tunnels suivants prennent le nouveau, les tunnels ouverts continuent. |
| `GET /info`, champ `outbound` | Proxy, expiration, date du branchement, nombre de tunnels, nombre de refus, et pour chaque cible le nombre de tunnels et la dernière réponse au `CONNECT`. Jamais le jeton. |
| Environnement de l'adaptateur | `HTTPS_PROXY` et `https_proxy` sur `http://127.0.0.1:<port>`, `NO_PROXY` sur `localhost,127.0.0.1`. |
| Ce qui est relayé | `CONNECT` seulement. Une requête `http://` est refusée (501) : elle n'a aucun credential à porter. |

## Les profils et les droits

Une exécution reçoit une liste de **profils**. Agora les compile en **droits** : un hôte, une
expression régulière ancrée sur le chemin et la query, des méthodes. Le catalogue est dans le
code d'Agora (`packages/credentials`).

| Profil | Droits |
| --- | --- |
| `anthropic` | `api.anthropic.com`, tout. |
| `github:owner/repo:read` | API REST `/repos/owner/repo…` en `GET` et `HEAD` ; git `git-upload-pack` seulement (un clone fait aussi un `POST`). |
| `github:owner/repo:write` | API REST `/repos/owner/repo…`, toutes méthodes ; git `git-upload-pack` et `git-receive-pack`. |

Les droits sont additifs : n'importe quelle combinaison de profils se compose, sans entité par
combinaison. GraphQL (`/graphql`) n'est couvert par aucun profil : on ne peut pas y vérifier le
repo visé.

## Le jeton

Un JWT EdDSA signé par la clé d'Agora (Secret `grants-key`), `kid` `agora-grants-1`.

| Claim | Contenu |
| --- | --- |
| `iss`, `aud` | `agora`, `agora-gateway` : exigés par la passerelle. |
| `sub` | L'exécution (`agora <nom>`), écrit dans chaque ligne du journal. |
| `exp` | La durée demandée au branchement, de 60 s à 24 h. |
| `jti` | Un identifiant par jeton. |
| `grants` | Les droits compilés. |
| `profiles` | Les profils demandés, pour mémoire. |

La passerelle le lit dans le `Proxy-Authorization` du `CONNECT`, que chaque requête du tunnel
voit (`source.connectHeaders`), et le vérifie avec le JWKS de la ConfigMap `grants-jwks`.

## La passerelle

agentgateway en mode autonome, namespace `agora-gateway`, Service `gateway` port 3000
(`CONNECT`). Chaque tunnel vers le port 443 est terminé avec la CA « Agora gateway CA ».

Une seule règle d'autorisation, la même pour toutes les routes : le chemin ne contient ni `..`,
ni `.`, ni `%2e`, ni `%2f`, et un des droits du JWT couvre l'hôte, le chemin avec la query, et
la méthode. Si la règle échoue, la requête s'arrête à la passerelle ; sinon la passerelle pose le
credential de l'hôte.

| Route | Hôte | Credential posé |
| --- | --- | --- |
| `anthropic` | `api.anthropic.com` | `Authorization: Bearer` + le setup-token Claude de l'opérateur. |
| `github-api` | `api.github.com` | `Authorization: Bearer` + le PAT GitHub. |
| `github-git` | `github.com` | `Authorization: Basic` + `x-access-token:` et le PAT, en base64. |

Les credentials sont dans le Secret SOPS `upstream-credentials`, montés en fichiers. La
passerelle surveille ces fichiers : une rotation se fait par un commit, sans redémarrage.
Vérifié : un PAT remplacé a été rechargé environ une minute après la fusion, le temps que le
kubelet synchronise le Secret. Le PAT délimite le maximum, les repos qu'Agora peut toucher ; les
droits découpent ce maximum par exécution.

Chaque requête laisse une ligne de journal : exécution (`jwt.sub`), `jti`, méthode, hôte,
chemin, statut, et la raison d'un refus.

## Côté Agora

| Élément | Règle |
| --- | --- |
| `POST /api/executions/{nom}/credentials` | Corps : les profils, la durée en secondes (3 600 par défaut). Agora compile et signe, puis remet le jeton au bridge ; la réponse est le champ `outbound` du bridge. |
| Le jeton | Gardé nulle part : ni sur le claim, ni en mémoire après l'appel, ni dans le journal. |
| Après chaque tour | Agora relit le champ `outbound` du bridge : tunnels et réponses deviennent visibles dans l'état de l'exécution. |
| `GET /api/config` | Champ `credentials` : la passerelle et les profils connus, ou rien. |
| Configuration | `GATEWAY_PROXY`, `GRANTS_KEY_FILE`, et `GRANTS_KEY_ID`, `GRANTS_ISSUER`, `GRANTS_AUDIENCE`. Sans `GATEWAY_PROXY`, aucune exécution n'a de sortie. |

Aujourd'hui, le banc branche un credential à la main. Plus tard, Agora le fera à la création
de l'exécution.

L'image claude-code garde `CLAUDE_CODE_OAUTH_TOKEN=agora-placeholder`. Cette valeur ne sert
qu'à mettre la CLI en mode OAuth : elle envoie alors un Bearer et
`anthropic-beta: oauth-…`. La passerelle remplace le Bearer et laisse passer le reste.

## Ce que le template fournit, en plus

| Élément | Valeur |
| --- | --- |
| `NODE_EXTRA_CA_CERTS` | `/etc/agora/credential-proxy/ca.pem`, depuis la ConfigMap `credential-proxy-ca` : « Agora gateway CA », valide jusqu'en 2028. |
| Sortie réseau | Le DNS, et `gateway.agora-gateway` sur le port 3000. Plus rien vers Internet. |

En face, la passerelle n'accepte que les sandboxes et ne sort que sur le port 443.

## Le modèle

Le modèle se choisit en ACP : `session/set_config_option` avec `configId` `model`, par
exemple `haiku`. Il s'envoie après `session/new` et avant le premier prompt, qui est le
premier appel facturé. Le banc le fait lui-même quand l'agent propose l'option.

## Les cas à valider

Suite des cas d'`executions.md`, joués les 28 et 29 septembre sur g4 sous Kata, par
`apps/lab/scripts/live-cases.ts`. Pour GitHub, un PAT à grain fin limité à deux repos jetables,
en écriture sur les deux : un refus ne peut venir que de la passerelle.

| # | Cas | Attendu | Mesuré |
| --- | --- | --- | --- |
| 23 | Sortir sans credential | `/fetch` du mock : `CONNECT` refusé, 503 ; un refus compté. | 503 du bridge, un refus compté. Avant tout branchement, les sorties tentées par le Pod du pool sont aussi refusées. |
| 24 | Chaîne seule | Profil `anthropic`, `/fetch https://api.anthropic.com/v1/models` du mock : une réponse d'Anthropic, ni 403 de la passerelle, ni erreur TLS. | 400 d'Anthropic (« anthropic-version: header is required ») : TLS accepté, Bearer posé par la passerelle ; tunnel → 200. |
| 25 | Harness réel | Profil `anthropic`, claude-code en `haiku` : vraie réponse du modèle. | « Paris. » en 2,3 s, `end_turn` ; journal de la passerelle : deux `POST /v1/messages` en 200 sous le nom de l'exécution. |
| 26 | Composition | Profils `github:A:write` et `github:B:read`. A : lecture, écriture, push ; B : lecture et fetch, pas d'écriture ni de push ; C, GraphQL : refusés. | A : lecture 200, écriture 201, push 200 ; B : lecture 200, fetch 200 ; B écriture, B push, C, GraphQL : 403 de la passerelle. Vérifié dans GitHub : le fichier créé existe sur A, pas sur B. |

Hors banc, contre la même configuration : JWT absent, expiré ou étranger → 401 ; chemins
piégés (`..`, `.`, `%2e`, `%2f`) → 403 ; hôte sans route → 404.

**À préciser :** brancher à la création et renouveler le jeton quand l'échéance le dépasse, un
JWT ne se révoquant pas avant son expiration ; compter les réponses au `CONNECT` par statut, pas
seulement la dernière ; la confiance TLS de git (libcurl ne lit pas `NODE_EXTRA_CA_CERTS`) et de
codex, qui ne sont pas en Node ; un accès GraphQL en lecture.
