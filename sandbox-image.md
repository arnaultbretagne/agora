# Contrat de l'image d'un sandbox

Contrat à implémenter — une image par harness, construite par Agora.

**L'image démarre l'adaptateur ACP et l'initialise une fois. Elle l'expose à Agora
seul, par un WebSocket numéroté, et par deux routes pour l'anchor. Le bridge relaie
ACP sans l'interpréter.**

Suite de [l'interface Agora ↔ Agent Sandbox](agent-sandbox.md).

## Qui fait quoi ?

- **Agora** construit l'image : adaptateur ACP épinglé, bridge, driver d'anchor du harness.
- **infra-k8s** la référence par digest dans un template et fournit ce que le template exige.
- **Le bridge** lance l'adaptateur, numérote ses lignes, les relaie, capture et restaure
  l'anchor. Il ne lit jamais le contenu ACP.

## Démarrage, dans le pool

1. Créer le workspace fixe `/home/harness/work`.
2. Lancer l'adaptateur par son entrée *bin*, stdio en pipes.
3. Envoyer `initialize` une seule fois (`fs` et `terminal` à *non*), garder la réponse.
4. Répondre prêt sur `/healthz`.

Tout cela se passe avant le claim, sans utilisateur ni credential. `initialize` est
une poignée de main du processus : codex refuse la seconde. Le back-end ne la renvoie
donc jamais : il donne à ses clients la réponse gardée par le bridge.

## Les routes

Port **8080**. Toutes les routes sauf `/healthz` exigent le jeton.

| Route | Rôle |
| --- | --- |
| `GET /healthz` | 200 si l'adaptateur vit et a répondu à `initialize`, 503 sinon. C'est la readiness du Pod. |
| `GET /info` | Instance, Pod, workspace, réponse d'`initialize`, état de l'adaptateur, dernière position. |
| `GET /acp` | WebSocket : le relais ACP. |
| `GET /anchor?sessionId=…` | Capture l'anchor de cette session. |
| `PUT /anchor` | Restaure un anchor. |

## Qui peut parler au bridge

`Authorization: Bearer <jeton>`. Le jeton est signé **Ed25519** par Agora. Il nomme
le sandbox visé et expire après **60 secondes**. Le bridge le vérifie avec la clé
publique d'Agora, puis compare le nom à celui de son propre Pod. Un jeton pour un
autre sandbox, expiré ou mal signé est refusé en 401.

La clé publique n'est pas un secret : **le sandbox ne contient aucun secret.** En plus
du jeton, la NetworkPolicy n'admet en entrée que le back-end d'Agora.

## Le relais

| Règle | Détail |
| --- | --- |
| Un seul client | La connexion la plus récente gagne ; l'ancienne est fermée (code 4000). Toutes les connexions ACP numérotent leurs requêtes depuis 0 : deux clients se voleraient leurs réponses. |
| Premier message | `hello` : instance, Pod, workspace, réponse d'`initialize`, état de l'adaptateur, première position rejouée, et `gap` si des lignes demandées sont perdues. |
| Vers le client | Chaque ligne de l'adaptateur devient `{seq, acp}` : `seq` strictement croissant pour l'instance, `acp` la ligne brute, jamais réinterprétée. |
| Vers l'adaptateur | Chaque message texte du client est une ligne ACP brute. Un message binaire ferme la connexion. |
| Sans client | Les lignes sont gardées : les 2 000 dernières, 16 Mio au plus. |
| Rejeu | `?after=N` rejoue tout ce qui suit la position N, puis passe au direct. N trop ancien : on rejoue ce qui reste, avec `gap`. Sans `after`, pas de rejeu. |

La position `(instance, seq)` identifie chaque trame. Un redémarrage d'Agora pendant
un tour se rattrape en rejouant depuis la position notée au début du tour.

## Si l'adaptateur meurt

Le bridge reste vivant. `/healthz` passe à 503, `hello` et `/info` donnent le code
de sortie, et le WebSocket est fermé (1011). **`/anchor` répond encore** : Agora
capture ce que le harness avait écrit, puis supprime le sandbox.

Si le bridge lui-même meurt, le Pod s'arrête (`restartPolicy: Never`) et l'anchor
est perdu.

## L'anchor

Le travail S9 est repris tel quel : un seul fichier natif par session, capturé et
restauré à l'octet près. Le driver de chaque harness sait où est ce fichier
(`harnesses/claude-code/src/driver.ts`, `docs/field-findings.md` §2.2 sur `main`).

| Harness | Fichier natif | Reprise |
| --- | --- | --- |
| claude-code | `$HOME/.claude/projects/<slug du workspace>/<sessionId>.jsonl` | `session/resume` |
| codex | `$HOME/.codex/sessions/<a>/<m>/<j>/rollout-<horodatage>-<sessionId>.jsonl` | `session/resume` — driver à porter |
| mock (banc) | `$HOME/.mock-agent/sessions/<slug du workspace>/<sessionId>.jsonl` | `session/resume` ou `session/load` |

Le slug est celui de claude-code : chaque caractère hors `[A-Za-z0-9-]` devient `-`.
C'est pourquoi le workspace est le même chemin dans toutes les images.

| Geste | Règle |
| --- | --- |
| **Capture** | Le fichier doit rester identique entre deux lectures à 250 ms d'écart, dans un budget de 10 s. Sinon, 409 avec la raison. Pas de fichier (session encore vide) : 404. Au-delà de 32 Mio : 409. Réponse : les octets, avec `x-anchor-format`, `x-anchor-checksum` (sha256) et `x-anchor-session`. |
| **Restauration** | Le driver lit le `sessionId` dans le contenu : une seule valeur, sinon 409. Il écrit à côté, relit, compare le checksum, puis renomme. Réponse : chemin, taille, checksum, `sessionId`. |
| **Exclusions** | Rien d'autre n'est capturé : ni `.claude.json`, ni fichier d'authentification, ni réglage global. |

L'adaptateur lit le fichier au moment de `session/resume`, pas à son démarrage : un Pod
du pool, déjà lancé, peut donc recevoir un anchor.

## Ce que le template fournit

| Élément | Valeur |
| --- | --- |
| `POD_NAME` | downward API, `metadata.name` : le nom attendu dans le jeton |
| `BRIDGE_PUBLIC_KEY` | clé publique d'Agora, depuis la ConfigMap `agora-bridge-key` |
| Port | 8080 |
| Readiness | `GET /healthz` |
| `HOME` | `emptyDir` monté sur `/home/harness` |
| Utilisateur | 10001, racine en lecture seule, aucune capacité, pas de jeton de ServiceAccount |
| `terminationGracePeriodSeconds` | 5 |

**À préciser :** les credentials du harness (Agent Vault) restent hors de ce contrat,
et le driver codex est à porter.
