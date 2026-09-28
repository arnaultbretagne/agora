# Les credentials d'une exécution

Contrat à implémenter — Agent Vault **0.39.3**, sur les exécutions de
[executions.md](executions.md).

**Le sandbox ne contient aucun secret. Il sort par Agent Vault, qui pose le credential
au passage.**

Un harness a besoin de credentials : Claude aujourd'hui, GitHub demain. Ils sont rangés dans
Agent Vault et n'entrent jamais dans le sandbox. La seule sortie du sandbox est le proxy
d'Agent Vault : il termine TLS, reconnaît l'hôte visé parmi les services du vault et pose
l'en-tête d'authentification. Ce que l'exécution détient, c'est une **session proxy** : un
jeton qui n'ouvre que ce proxy, pour un seul vault, pour une durée limitée. Agora la frappe et
la remet au bridge après le claim, ce qui garde le pool chaud.

## Qui fait quoi ?

- **L'opérateur** range les credentials et les services dans le vault, depuis l'interface
  d'Agent Vault, et y crée l'agent d'Agora.
- **Agent Vault** garde les credentials, termine TLS avec sa propre autorité de
  certification et pose le credential du service qui correspond à l'hôte.
- **Agora** détient un jeton d'agent, rôle `member` sur le vault : le seul rôle qui frappe
  des sessions. Ce rôle permet aussi de lire, poser et supprimer les credentials du vault :
  ce jeton reste chez Agora, jamais dans un sandbox. Pour une exécution, Agora frappe une
  session `proxy` et la remet au bridge.
- **Le bridge** ouvre au harness un proxy sortant local et fait suivre chaque tunnel au proxy
  d'Agent Vault avec le jeton de la session.
- **infra-k8s** fournit l'autorité de certification d'Agent Vault aux sandboxes et ne les
  laisse sortir que vers le proxy d'Agent Vault.

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
| 1 | Adaptateur → bridge | `CONNECT api.anthropic.com:443` sur `127.0.0.1`. |
| 2 | Bridge → Agent Vault | Le même `CONNECT` vers `agent-vault-proxy.agent-vault.svc.cluster.local:14322`, avec `Proxy-Authorization: Bearer` et le jeton de la session. La réponse revient telle quelle à l'adaptateur. |
| 3 | Agent Vault | Retrouve le vault de la session, répond 200, puis termine TLS avec un certificat signé par « Agent Vault Root CA ». |
| 4 | Adaptateur | Fait confiance à cette autorité par `NODE_EXTRA_CA_CERTS` et envoie sa requête. |
| 5 | Agent Vault | Reconnaît l'hôte : service `claude`, hôte `api.anthropic.com`, Bearer sur `CLAUDE_TOKEN`. Remplace `Authorization`, garde les autres en-têtes, suit vers Anthropic. |

| Réponse au `CONNECT` | Sens |
| --- | --- |
| 503 du bridge | Aucun credential branché sur cette exécution. |
| 502 du bridge | Proxy d'Agent Vault injoignable. |
| 407 d'Agent Vault | Session inconnue ou expirée. |
| 403 d'Agent Vault, après TLS | Aucun service du vault pour cet hôte. |

## Le bridge

| Élément | Règle |
| --- | --- |
| `PUT /credentials` | Avec le jeton d'Agora. Le corps donne le proxy (`hôte:port`), le jeton de session et son expiration. Remplace le credential précédent : les tunnels suivants prennent le nouveau, les tunnels ouverts continuent. |
| `GET /info`, champ `outbound` | Proxy, expiration, date du branchement, nombre de tunnels, nombre de refus, et pour chaque cible le nombre de tunnels et la dernière réponse du proxy. Jamais le jeton. |
| Environnement de l'adaptateur | `HTTPS_PROXY` et `https_proxy` sur `http://127.0.0.1:<port>`, `NO_PROXY` sur `localhost,127.0.0.1`. |
| Ce qui est relayé | `CONNECT` seulement. Une requête `http://` est refusée (501) : elle n'a aucun credential à porter. |

## Côté Agora

| Élément | Règle |
| --- | --- |
| `POST /api/executions/{nom}/credentials` | Corps : la durée de la session, en secondes, 3 600 par défaut, de 300 à 7 jours (les bornes d'Agent Vault). Agora frappe la session puis la remet au bridge ; la réponse est le champ `outbound` du bridge. |
| Frappe | `POST /v1/sessions` d'Agent Vault avec le jeton d'agent : vault, rôle `proxy`, durée, libellé `agora <nom>`. |
| Le jeton | Gardé nulle part : ni sur le claim, ni en mémoire après l'appel, ni dans le journal. |
| Après chaque tour | Agora relit le champ `outbound` du bridge : tunnels et réponses deviennent visibles dans l'état de l'exécution. |
| `GET /api/config` | Champ `credentials` : le vault et le proxy, ou rien. |
| Configuration | `AGENT_VAULT_API`, `AGENT_VAULT_PROXY`, `AGENT_VAULT_NAME`, `AGENT_VAULT_TOKEN_FILE`. Sans `AGENT_VAULT_API`, aucune exécution n'a de sortie. |

Aujourd'hui, le banc branche un credential à la main. Plus tard, Agora le fera à la création
de l'exécution.

## Dans Agent Vault

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

`member` est donc le minimum pour frapper, et il donne aussi accès aux credentials. Le
vault d'Agora ne devrait contenir que ce dont ses exécutions ont besoin.

L'image claude-code garde `CLAUDE_CODE_OAUTH_TOKEN=agora-placeholder`. Cette valeur ne sert
qu'à mettre la CLI en mode OAuth : elle envoie alors un Bearer et
`anthropic-beta: oauth-…`. Agent Vault remplace le Bearer et laisse passer le reste.

## Ce que le template fournit, en plus

| Élément | Valeur |
| --- | --- |
| `NODE_EXTRA_CA_CERTS` | `/etc/agora/credential-proxy/ca.pem`, depuis la ConfigMap `agent-vault-ca` (autorité d'Agent Vault, valide jusqu'en 2036). |
| Sortie réseau | Le DNS, et `agent-vault-proxy` sur le port 14322. Plus rien vers Internet. |

En face, Agent Vault accepte le port 14322 depuis `agora-sandboxes`, et le port 14321
depuis le banc.

## Le modèle

Le modèle se choisit en ACP : `session/set_config_option` avec `configId` `model`, par
exemple `haiku`. Il s'envoie après `session/new` et avant le premier prompt, qui est le
premier appel facturé. Le banc le fait lui-même quand l'agent propose l'option.

## Décisions et options écartées

| Sujet | Retenu |
| --- | --- |
| **Où vit le credential** | Dans Agent Vault ; son proxy le pose au passage. Jamais dans le sandbox. |
| **Identité de l'exécution** | Une session `proxy` par exécution, frappée par Agora. |
| **Remise** | Après le claim, au bridge, en mémoire. |
| **Sortie** | Le proxy local du bridge ; `HTTPS_PROXY` de l'adaptateur y pointe dès le démarrage. |

| Écarté | Pourquoi |
| --- | --- |
| Jeton dans l'environnement du claim | Force le démarrage à froid et écrit un secret dans la spec du sandbox. |
| Relancer l'adaptateur après le claim, jeton en environnement | Perd l'`initialize` fait dans le pool, et l'agent lit son environnement. |
| `_meta.claudeCode.options.env` au `session/new` | Propre à claude-code, et le jeton atterrit dans l'environnement de la CLI, lisible par les outils de l'agent. |
| Jeton d'agent dans le sandbox | Un jeton `member` ouvrirait les credentials au sandbox. Un jeton d'agent `proxy`, remis à chaque exécution, n'ouvrirait que le proxy, mais il serait durable et commun à toutes les exécutions : une fuite vaudrait jusqu'à sa rotation, et le journal d'Agent Vault ne distinguerait plus les exécutions. |
| Sortie directe vers Anthropic | Ce qui sort sans passer par le vault échappe à son journal et à sa politique. |

## Les cas à valider

Suite des cas d'[executions.md](executions.md), joués le 28 septembre sur g4 sous Kata, par
`apps/lab/scripts/live-cases.ts`.

| # | Cas | Attendu | Mesuré |
| --- | --- | --- | --- |
| 23 | Sortir sans credential | `/fetch` du mock : `CONNECT` refusé, 503 ; un refus compté. | 503 du bridge, un refus compté. |
| 24 | Credential branché, chaîne seule | `/fetch https://api.anthropic.com/v1/models` du mock : une réponse d'Anthropic, ni 403 d'Agent Vault, ni erreur TLS. | 400 d'Anthropic (« anthropic-version: header is required ») : TLS accepté, Bearer injecté ; tunnel → 200. |
| 25 | Credential branché, harness réel | claude-code en `haiku` : vraie réponse du modèle, fin `end_turn`, `api.anthropic.com:443` → 200. | « pomme » en 1,8 à 2,3 s, `end_turn`, modèle `claude-haiku-4-5-20251001`, 5 tunnels. Journal d'Agent Vault : service `claude`, clé `CLAUDE_TOKEN`, deux `POST /v1/messages` en 200. Avant le branchement, deux sorties tentées par le Pod du pool, refusées par le bridge. |

Avec les cas 1 à 22 rejoués sur les nouvelles images, la suite passe entière. Une fois, la
dernière réponse du proxy notée pour `api.anthropic.com:443` était un 407 alors que toutes les
requêtes avaient abouti : probablement une connexion ouverte puis abandonnée par la CLI.

**À préciser :** compter les réponses du proxy par statut, pas seulement la dernière ;
composer plusieurs profils (une session par vault, choisie selon l'hôte) ; brancher à la
création et renouveler la session quand l'échéance la dépasse ; révoquer la session à la fin de l'exécution (aujourd'hui, elle expire) ; la
confiance TLS de codex, qui n'est pas en Node ; les autres hôtes, un service par hôte dans
le vault.
