# Contrat de l'image d'un sandbox

Contrat à implémenter — une image par harness, construite par Agora.

**L'image démarre l'adaptateur ACP, l'initialise une fois et le relaie à Agora par un
WebSocket. Au SIGTERM, elle arrête l'adaptateur et pousse l'anchor vers Agora.**

Suite de [l'interface Agora ↔ Agent Sandbox](agent-sandbox.md).

## Qui fait quoi ?

- **Agora** construit l'image : adaptateur ACP épinglé, bridge, dossier natif du harness.
- **infra-k8s** la référence par digest dans un template et fournit ce que le template exige.
- **Le bridge** lance l'adaptateur, relaie ses lignes sans les lire, pousse l'anchor à la
  fin du Pod et restaure celui qu'Agora lui dépose.

## Démarrage, dans le pool

1. Créer le workspace fixe `/home/harness/work`.
2. Lancer l'adaptateur par son entrée *bin*, stdio en pipes.
3. Envoyer `initialize` une seule fois (`fs` et `terminal` à *non*), garder la réponse.
4. Répondre prêt sur `/healthz`.

Tout cela se passe avant le claim, sans utilisateur ni credential. codex refuse un second
`initialize` : le back-end ne le renvoie jamais et sert la réponse gardée par le bridge.

## Les routes

Port **8080**. Toutes les routes sauf `/healthz` exigent le jeton d'Agora.

| Route | Rôle |
| --- | --- |
| `GET /healthz` | 200 si l'adaptateur vit et a répondu à `initialize`, 503 sinon. C'est la readiness du Pod. |
| `GET /info` | Instance, Pod, workspace, réponse d'`initialize`, état de l'adaptateur, dernière position. |
| `GET /acp` | WebSocket : le relais ACP. |
| `PUT /anchor` | Restaure un anchor avant la reprise de la session. |

## Qui peut parler au bridge

`Authorization: Bearer <jeton>`, signé **Ed25519** par Agora. Le jeton nomme le sandbox
visé et expire après **60 secondes**. Le bridge le vérifie avec la clé publique d'Agora et
compare le nom à celui de son propre Pod. En plus, la NetworkPolicy n'admet en entrée que
le back-end d'Agora.

## Le relais

| Règle | Détail |
| --- | --- |
| Un seul client | La connexion la plus récente gagne ; l'ancienne est fermée (4000). Toutes les connexions ACP numérotent leurs requêtes depuis 0 : deux clients se voleraient leurs réponses. |
| Premier message | `hello` : instance, Pod, workspace, réponse d'`initialize`, état de l'adaptateur, rejeu et `gap`. |
| Vers le client | Chaque ligne de l'adaptateur devient `{seq, acp}` : `seq` croît pour l'instance, `acp` est la ligne brute. |
| Vers l'adaptateur | Chaque message texte du client est une ligne ACP brute. |
| Sans client | Les lignes sont gardées : les 2 000 dernières, 16 Mio au plus. |
| Rejeu | `?after=N` rejoue ce qui suit la position N, avec `gap` s'il en manque. |

Si l'adaptateur meurt, le bridge reste vivant : `/healthz` passe à 503, `hello` et `/info`
donnent le code de sortie, et l'anchor partira au SIGTERM.

## À la fin du Pod

À l'échéance, l'infrastructure supprime le Pod : le bridge reçoit SIGTERM et dispose du
délai de grâce du template, 30 secondes.

1. Fermer le relais et refuser toute nouvelle connexion.
2. Arrêter l'adaptateur : SIGTERM, puis SIGKILL après 5 secondes.
3. Lire en bloc les fichiers natifs du harness, stables entre deux lectures à 250 ms d'écart.
4. Les pousser vers Agora, trois essais au plus.
5. Sortir.

Sans aucun fichier natif (aucune session ouverte), le bridge pousse un anchor vide :
Agora sait ainsi qu'il n'y avait rien à garder.

## L'anchor

Le travail S9 est repris : les fichiers natifs du harness, et rien d'autre. Ni
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
| **Identité du Pod** | `Authorization: Bearer` + le jeton de ServiceAccount projeté par le kubelet (audience `agora-anchors`, 10 minutes, renouvelé par le kubelet jusque dans la VM Kata), relu à chaque poussée. |
| **Restauration** | `PUT /anchor` avec le même corps. Chaque fichier est écrit à côté, relu, comparé, puis renommé. L'adaptateur lit le fichier au `session/resume`, pas au démarrage : un Pod du pool, déjà lancé, peut le recevoir. |

## Ce que le template fournit

| Élément | Valeur |
| --- | --- |
| `POD_NAME` | downward API, `metadata.name` : le nom attendu dans le jeton d'Agora |
| `BRIDGE_PUBLIC_KEY` | clé publique d'Agora, depuis la ConfigMap `agora-bridge-key` |
| `AGORA_ANCHOR_URL` | la route de réception des anchors d'Agora |
| Jeton projeté | volume `serviceAccountToken`, audience `agora-anchors`, monté sur `/var/run/agora/token` |
| Port | 8080 |
| Readiness | `GET /healthz` |
| `HOME` | `emptyDir` monté sur `/home/harness` |
| Utilisateur | 10001, racine en lecture seule, aucune capacité |
| `terminationGracePeriodSeconds` | 30 |

**À préciser :** les credentials du harness (Agent Vault), le dossier natif de codex.
