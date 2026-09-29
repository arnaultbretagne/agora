# Les credentials d'une exécution

Contrat à implémenter — agentgateway **1.5.0** et Agent Vault **0.39.3**, sur les exécutions
de [executions.md](executions.md).

**Le sandbox ne contient aucun secret. Il sort par un proxy de credentials, qui pose le
credential au passage.**

Un harness a besoin de credentials : Claude, GitHub. Ils n'entrent jamais dans le sandbox. La
seule sortie du sandbox est un proxy de credentials : il termine TLS, décide si la requête est
permise et pose l'en-tête d'authentification de l'hôte. L'exécution ne détient qu'un jeton
court qui ouvre ce proxy. Agora le produit et le remet au bridge après le claim, ce qui garde
le pool chaud.

Deux proxies ont été montés sur le même bridge :

- **la passerelle d'Agora** (agentgateway) : le jeton est un JWT signé par Agora qui liste les
  droits de l'exécution ; la passerelle vérifie chaque requête contre ces droits. Elle
  **compose** : « écriture sur A, lecture sur B » sur le même hôte ;
- **Agent Vault** : le jeton est une session `proxy` sur un vault ; tout ce que le vault
  contient est ouvert. Il ne compose pas.

## Qui fait quoi ?

- **L'opérateur** range les credentials : en Secret SOPS dans infra-k8s pour la passerelle,
  dans l'interface d'Agent Vault pour Agent Vault.
- **Le proxy de credentials** garde les credentials, termine TLS avec sa propre autorité de
  certification, décide, et pose le credential de l'hôte.
- **Agora** produit le jeton de l'exécution et le remet au bridge. Pour la passerelle, il signe
  des droits et ne voit aucun credential. Pour Agent Vault, il frappe une session avec un
  jeton d'agent `member`, qui peut aussi lire les credentials du vault.
- **Le bridge** ouvre au harness un proxy sortant local et fait suivre chaque tunnel au proxy
  de credentials, avec le jeton.
- **infra-k8s** fournit aux sandboxes les autorités de certification des proxies et ne les
  laisse sortir que vers eux.

## Pourquoi un proxy dans le bridge ?

L'adaptateur démarre dans le pool, avant tout claim : son environnement ne peut porter aucun
jeton. Passer le jeton par le claim force le démarrage à froid (voir
[executions.md](executions.md), « Décisions et options écartées »).

Le bridge lance donc l'adaptateur avec `HTTPS_PROXY` pointé sur un proxy à lui, en local,
qui refuse tout tant qu'aucun credential n'est branché. Agora branche le credential plus
tard, par une route du bridge. Tout harness qui respecte `HTTPS_PROXY` en profite.

Le jeton reste dans la mémoire du bridge : ni dans l'environnement de l'adaptateur, ni sur
disque. L'agent peut emprunter la sortie, pas emporter le jeton, et le réseau ne le laisse
aller nulle part ailleurs.

## Le chemin d'une requête

| Étape | Qui | Quoi |
| --- | --- | --- |
| 1 | Adaptateur → bridge | `CONNECT api.github.com:443` sur `127.0.0.1`. |
| 2 | Bridge → proxy | Le même `CONNECT` vers le proxy branché, avec `Proxy-Authorization: Bearer` et le jeton de l'exécution. La réponse revient telle quelle à l'adaptateur. |
| 3 | Proxy | Répond 200, puis termine TLS avec un certificat signé par son autorité. |
| 4 | Adaptateur | Fait confiance à cette autorité par `NODE_EXTRA_CA_CERTS` et envoie sa requête. |
| 5 | Proxy | Vérifie le jeton et, pour la passerelle, les droits. Pose le credential de l'hôte à la place du `Authorization` reçu, garde les autres en-têtes, suit vers l'hôte. |

| Réponse | Sens |
| --- | --- |
| 503 du bridge, au `CONNECT` | Aucun credential branché sur cette exécution. |
| 502 du bridge, au `CONNECT` | Proxy injoignable. |
| 401 de la passerelle | JWT absent, expiré ou signé par une autre clé. |
| 403 de la passerelle | Aucun droit de l'exécution ne couvre cet hôte, ce chemin et cette méthode. |
| 404 de la passerelle | Hôte sans route. |
| 407 d'Agent Vault, au `CONNECT` | Session inconnue ou expirée. |
| 403 d'Agent Vault | Aucun service du vault pour cet hôte. |

## Le bridge

| Élément | Règle |
| --- | --- |
| `PUT /credentials` | Avec le jeton d'Agora. Le corps donne le proxy (`hôte:port`), le jeton et son expiration. Remplace le credential précédent : les tunnels suivants prennent le nouveau, les tunnels ouverts continuent. |
| `GET /info`, champ `outbound` | Proxy, expiration, date du branchement, nombre de tunnels, nombre de refus, et pour chaque cible le nombre de tunnels et la dernière réponse du proxy au `CONNECT`. Jamais le jeton. |
| Environnement de l'adaptateur | `HTTPS_PROXY` et `https_proxy` sur `http://127.0.0.1:<port>`, `NO_PROXY` sur `localhost,127.0.0.1`. |
| Ce qui est relayé | `CONNECT` seulement. Une requête `http://` est refusée (501) : elle n'a aucun credential à porter. |

## La passerelle

agentgateway en mode autonome, namespace `agora-gateway`, Service `gateway` port 3000
(`CONNECT`). Chaque tunnel vers le port 443 est terminé avec la CA « Agora gateway CA ».

### Les profils et les droits

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

### Le jeton

Un JWT EdDSA signé par la clé d'Agora (Secret `grants-key` du banc), `kid` `agora-grants-1`.

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

### La règle

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
kubelet synchronise le Secret. Le PAT délimite le maximum, les repos qu'Agora peut toucher ; la
règle découpe ce maximum par exécution.

### Le journal

Chaque requête laisse une ligne : exécution (`jwt.sub`), `jti`, méthode, hôte, chemin, statut,
et la raison d'un refus.

## Agent Vault

Vault `default` :

| Élément | Valeur |
| --- | --- |
| Credential `CLAUDE_TOKEN` | Le setup-token Claude de l'opérateur (`sk-ant-oat01-…`). |
| Service `claude` | Hôte `api.anthropic.com`, Bearer, clé `CLAUDE_TOKEN`. |
| Agent `agent-lab` | Rôle d'instance `no-access`, rôle `member` sur `default`. Son jeton est dans le Secret `agent-vault` du namespace `agora-lab`. |

| Rôle sur un vault (0.39.3) | Frapper une session | Lire, poser, supprimer un credential | Modifier les services |
| --- | --- | --- | --- |
| `proxy` | non | non | non |
| `member` | oui | oui | non |
| `admin` | oui | oui | oui |

`member` est donc le minimum pour frapper, et il donne aussi accès aux credentials. Une
session couvre un vault entier ; les services ne distinguent ni les méthodes ni les
exécutions.

## Côté Agora

| Élément | Règle |
| --- | --- |
| `POST /api/executions/{nom}/credentials` | Corps : la source (`gateway` ou `agent-vault`, la première configurée par défaut), la durée en secondes (3 600 par défaut), les profils pour la passerelle. Agora produit le jeton puis le remet au bridge ; la réponse est le champ `outbound` du bridge. |
| Le jeton | Gardé nulle part : ni sur le claim, ni en mémoire après l'appel, ni dans le journal. |
| Après chaque tour | Agora relit le champ `outbound` du bridge : tunnels et réponses deviennent visibles dans l'état de l'exécution. |
| `GET /api/config` | Champ `credentials` : les sources offertes. |
| Configuration | `GATEWAY_PROXY`, `GRANTS_KEY_FILE` (et `GRANTS_KEY_ID`, `GRANTS_ISSUER`, `GRANTS_AUDIENCE`) pour la passerelle ; `AGENT_VAULT_API`, `AGENT_VAULT_PROXY`, `AGENT_VAULT_NAME`, `AGENT_VAULT_TOKEN_FILE` pour Agent Vault. Sans source, aucune exécution n'a de sortie. |

Aujourd'hui, le banc branche un credential à la main. Plus tard, Agora le fera à la création
de l'exécution.

L'image claude-code garde `CLAUDE_CODE_OAUTH_TOKEN=agora-placeholder`. Cette valeur ne sert
qu'à mettre la CLI en mode OAuth : elle envoie alors un Bearer et
`anthropic-beta: oauth-…`. Le proxy remplace le Bearer et laisse passer le reste.

## Ce que le template fournit, en plus

| Élément | Valeur |
| --- | --- |
| `NODE_EXTRA_CA_CERTS` | `/etc/agora/credential-proxy/ca.pem`, depuis la ConfigMap `credential-proxy-ca` : « Agent Vault Root CA » (jusqu'en 2036) et « Agora gateway CA » (jusqu'en 2028). |
| Sortie réseau | Le DNS, `gateway.agora-gateway` sur le port 3000 et `agent-vault-proxy` sur le port 14322. Plus rien vers Internet. |

En face, la passerelle n'accepte que les sandboxes et ne sort que sur le port 443 ; Agent
Vault accepte le port 14322 depuis les sandboxes et le port 14321 depuis le banc.

## Le modèle

Le modèle se choisit en ACP : `session/set_config_option` avec `configId` `model`, par
exemple `haiku`. Il s'envoie après `session/new` et avant le premier prompt, qui est le
premier appel facturé. Le banc le fait lui-même quand l'agent propose l'option.

## Décisions et options écartées

| Sujet | Retenu |
| --- | --- |
| **Où vit le credential** | Dans le proxy de credentials, jamais dans le sandbox. |
| **Identité de l'exécution** | Un jeton court par exécution, produit par Agora. |
| **Remise** | Après le claim, au bridge, en mémoire. |
| **Sortie** | Le proxy local du bridge ; `HTTPS_PROXY` de l'adaptateur y pointe dès le démarrage. |
| **Composition** | Par la policy, pas par le credential : des droits signés par Agora, vérifiés requête par requête ; un credential large par hôte. |

| Écarté | Pourquoi |
| --- | --- |
| Jeton dans l'environnement du claim | Force le démarrage à froid et écrit un secret dans la spec du sandbox. |
| Relancer l'adaptateur après le claim, jeton en environnement | Perd l'`initialize` fait dans le pool, et l'agent lit son environnement. |
| `_meta.claudeCode.options.env` au `session/new` | Propre à claude-code, et le jeton atterrit dans l'environnement de la CLI, lisible par les outils de l'agent. |
| Jeton d'agent Agent Vault dans le sandbox | Un jeton `member` ouvrirait les credentials au sandbox. Un jeton `proxy` durable serait commun à toutes les exécutions : une fuite vaudrait jusqu'à sa rotation. |
| Un vault par combinaison de droits | Le nombre de vaults exploserait ; et deux vaults ne se combinent pas sur un même hôte. |
| Un credential court émis par exécution (jeton d'installation d'une GitHub App) | De l'état et du nettoyage dans Agora pour chaque exécution ; la policy suffit. |
| OneCLI v2 | Un jeton permanent par agent, sans expiration ; le projet est devenu une plateforme d'agents hébergés. |
| Sortie directe vers Anthropic ou GitHub | Ce qui sort sans passer par le proxy échappe à son journal et à sa policy. |

## Les cas à valider

Suite des cas d'[executions.md](executions.md), joués les 28 et 29 septembre sur g4 sous
Kata, par `apps/lab/scripts/live-cases.ts`. Pour GitHub, un PAT à grain fin limité à deux
repos jetables, en écriture sur les deux : un refus ne peut venir que de la passerelle.

| # | Cas | Attendu | Mesuré |
| --- | --- | --- | --- |
| 23 | Sortir sans credential | `/fetch` du mock : `CONNECT` refusé, 503 ; un refus compté. | 503 du bridge, un refus compté. |
| 24 | Agent Vault, chaîne seule | `/fetch https://api.anthropic.com/v1/models` du mock : une réponse d'Anthropic, ni 403 d'Agent Vault, ni erreur TLS. | 400 d'Anthropic (« anthropic-version: header is required ») : TLS accepté, Bearer injecté ; tunnel → 200. |
| 25 | Agent Vault, harness réel | claude-code en `haiku` : vraie réponse du modèle, fin `end_turn`. | « Paris. » en 1,5 à 2,3 s, `end_turn`, modèle `claude-haiku-4-5-20251001`, 5 tunnels. Journal d'Agent Vault : service `claude`, clé `CLAUDE_TOKEN`, deux `POST /v1/messages` en 200. Avant le branchement, deux sorties tentées par le Pod du pool, refusées par le bridge. |
| 26 | Passerelle, harness réel | Profil `anthropic`, claude-code en `haiku` : vraie réponse du modèle. | « Paris. » en 2,3 s, `end_turn` ; journal de la passerelle : deux `POST /v1/messages` en 200 sous le nom de l'exécution. |
| 27 | Passerelle, composition | Profils `github:A:write` et `github:B:read`. A : lecture, écriture, push ; B : lecture et fetch, pas d'écriture ni de push ; C, GraphQL : refusés. | A : lecture 200, écriture 201, push 200 ; B : lecture 200, fetch 200 ; B écriture, B push, C, GraphQL : 403 de la passerelle. Vérifié dans GitHub : le fichier créé existe sur A, pas sur B. |

Hors banc, contre la même configuration : JWT absent, expiré ou étranger → 401 ; chemins
piégés (`..`, `.`, `%2e`, `%2f`) → 403 ; hôte sans route → 404.

À deux reprises, la dernière réponse notée par le bridge pour Agent Vault était un 407 alors
que toutes les requêtes avaient abouti : probablement une connexion ouverte puis abandonnée
par la CLI.

**À préciser :** la passerelle ou Agent Vault, à trancher ; compter les réponses des proxies par statut, pas seulement la dernière ; brancher à la
création et renouveler le jeton quand l'échéance le dépasse, le JWT ne se révoquant pas avant
son expiration ; la confiance TLS de git (libcurl ne lit pas `NODE_EXTRA_CA_CERTS`) et de
codex, qui ne sont pas en Node ; un accès GraphQL en lecture.
