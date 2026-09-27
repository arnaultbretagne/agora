# Interface Agora ↔ Agent Sandbox

Contrat à implémenter — Agent Sandbox **v1.0.3**, runtime **Kata**.

**Agora demande un sandbox, le garde en vie tant qu'il sert, sauvegarde son anchor,
puis le supprime lui-même. Agent Sandbox alloue, applique une échéance de secours
et détruit.**

Suite de ce contrat : [l'image et son bridge](sandbox-image.md) et
[l'API du back-end](sandbox-backend.md).

## Qui fait quoi ?

- **Agora** construit les images, crée, renouvelle et supprime les claims, décide
  quand un sandbox doit disparaître et capture son anchor juste avant.
- **infra-k8s** fournit la RuntimeClass `kata`, le namespace `agora-sandboxes`, les
  templates et pools par image épinglée, le réseau, les quotas et les droits d'Agora.
- **Agent Sandbox** entretient le stock chaud, attribue, expose l'état, applique
  l'échéance et détruit.

Aucun stockage persistant dans un sandbox : le workspace est un `emptyDir`. Ce que
l'agent veut garder, il le pousse lui-même (code, note). Ce qu'Agora garde, c'est
l'anchor : les fichiers natifs du harness, sauvegardés en bloc avant la suppression.

## Le catalogue

Agora ne propose et n'accepte que les `SandboxWarmPool` du namespace `agora-sandboxes`
portant le label `agora.bretagne.dev/harness`. Un pool pointe un template ; un template
fixe une image par digest. Changer d'image, c'est un nouveau template et un nouveau pool
au nom versionné, jamais une modification en place.

| Template | Valeur |
| --- | --- |
| `runtimeClassName` | `kata` |
| `restartPolicy` | `Never` : une perte du bridge reste visible |
| Stockage | `emptyDir` seulement, jamais de `volumeClaimTemplates` |
| `networkPolicyManagement` | `Unmanaged` : le réseau est celui d'infra-k8s |
| `service` | absent : Agora joint le Pod par `status.sandbox.podIPs` |
| Le reste | exigé par [le contrat de l'image](sandbox-image.md#ce-que-le-template-fournit) |

Le claim ne porte jamais `env` ni `volumeClaimTemplates` : ces champs forcent un
démarrage à froid. Tout ce qui est propre à une demande passe par le bridge après
attribution.

## Les quatre opérations

| Opération | Agora envoie à Kubernetes | Agora récupère |
| --- | --- | --- |
| **Obtenir** | POST d'un `SandboxClaim` nommé `sbx-` + les 10 premiers caractères hexadécimaux du SHA-256 de l'identifiant de demande. Pool via `spec.warmPoolRef.name`, échéance via `spec.lifecycle.shutdownTime`, `shutdownPolicy: DeleteForeground`. | Le claim. Sur 409, Agora relit : même `agora.bretagne.dev/request-id`, même sandbox ; sinon refus. |
| **Observer** | LIST puis WATCH des claims labellisés, reprise au `resourceVersion`, nouveau LIST sur 410. GET du `Sandbox` et du Pod pour le diagnostic. | Condition `Ready` et sa raison, `status.sandbox.name`, `status.sandbox.podIPs`, label `agents.x-k8s.io/launch-type` du Sandbox, raison d'attente du conteneur. |
| **Renouveler** | PATCH merge de `spec.lifecycle.shutdownTime`, avec précondition sur l'UID. | Échéance acceptée, absolue, en UTC. |
| **Supprimer** | DELETE du claim, `propagationPolicy: Foreground`, précondition sur l'UID. | Suppression acceptée ; nettoyage par l'infrastructure. |

Pour Agora, le sandbox disparaît dès que la suppression est acceptée. Personne n'attend
l'arrêt physique.

## Ce qu'Agora écrit sur le claim

Le claim porte tout ce dont Agora a besoin pour reprendre après son propre redémarrage.
Agora ne garde aucun autre état sur les sandboxes vivants.

| Clé | Sorte | Contenu |
| --- | --- | --- |
| `app.kubernetes.io/managed-by` | label | `agora-sandbox-backend` : ce qu'Agora liste et surveille |
| `agora.bretagne.dev/pool` | label | le pool demandé |
| `agora.bretagne.dev/request-id` | annotation | l'identifiant de demande, pour l'idempotence |
| `agora.bretagne.dev/limits` | annotation | bail, inactivité et durée de tour appliqués à ce sandbox |
| `agora.bretagne.dev/restore-anchor` | annotation | l'anchor à restaurer ; `agora.bretagne.dev/restored` une fois fait |
| `agora.bretagne.dev/instance` | annotation | l'instance de bridge vue à la première connexion |
| `agora.bretagne.dev/session-id` | annotation | la session ACP en cours, celle que l'anchor capturera |
| `agora.bretagne.dev/turn` | annotation | le tour en cours : début, identifiant de la requête, position du bridge au départ |
| `agora.bretagne.dev/idle-since` | annotation | la fin du dernier tour, ou la mise en service |

Les labels du claim ne sont pas propagés au Pod : l'allowlist de domaines du contrôleur
ne les concerne pas.

## Le bail : un filet, pas une décision

| Paramètre | Valeur initiale |
| --- | --- |
| Échéance de secours | **maintenant + 10 minutes** |
| Renouvellement | **chaque minute**, tant qu'Agora tient le sandbox, en tour comme en attente |
| Inactivité avant suppression | **1 heure** sans tour |
| Durée maximale d'un tour | **1 heure** |

**C'est Agora qui supprime, et toujours après avoir capturé l'anchor.** Il supprime
sur arrêt demandé, après l'inactivité, quand un tour dépasse sa durée, ou quand
l'adaptateur est perdu. Garder le sandbox entre deux tours préserve le contexte vivant
et son cache : restaurer un anchor ouvre une nouvelle session et repaie tout le contexte.

L'échéance de secours ne tombe que si Agora cesse de renouveler pendant 10 minutes.
Le sandbox disparaît alors **sans anchor** : c'est accepté, c'est le nettoyage des
ressources dont Agora a perdu la trace.

Avant d'envoyer `session/prompt`, un seul PATCH écrit le début du tour et repousse
l'échéance. S'il échoue, le prompt est refusé. Ni les événements ACP ni les
reconnexions ne repoussent la limite d'une heure du tour.

## Les cas limites

- **Retry de création :** même nom, même claim ; toute mutation vérifie l'UID, car le
  même nom peut désigner plus tard un autre objet.
- **Arrêt en cours :** aucun renouvellement tardif ; le PATCH porte la précondition
  d'UID et n'est plus envoyé dès que la suppression est décidée.
- **Pod supprimé seul :** le contrôleur en recrée un. L'instance du bridge change,
  Agora déclare le sandbox perdu : le contexte vivant n'existe plus.
- **Nettoyage :** une suppression acceptée ne prouve pas l'arrêt physique immédiat.

## Les droits d'Agora

| Ressource (`agora-sandboxes`) | Verbes |
| --- | --- |
| `sandboxclaims` | get, list, watch, create, patch, delete |
| `sandboxwarmpools`, `sandboxtemplates`, `sandboxes` | get, list, watch |
| `pods` | get, list, watch (diagnostic) |

Un quota de namespace borne les ressources ; Agora borne en plus le nombre de sandboxes
actifs, puisqu'un pool n'est pas une limite de concurrence.

**À préciser :** la valeur d'inactivité (1 heure proposée), une admission qui borne
pools et échéances côté cluster, et le passage des autres namespaces `untrusted-compute`
de gVisor à Kata.

Référence API : [SandboxClaim v1.0.3](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/extensions/api/v1beta1/sandboxclaim_types.go).
Les mesures Kata sont dans `docs/agent-sandbox-evaluation.md` du dépôt `infra-k8s`.
