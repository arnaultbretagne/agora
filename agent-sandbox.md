# Interface Agora ↔ Agent Sandbox

Contrat de départ à implémenter — Agent Sandbox **v1.0.3**.

**Agora demande un sandbox, échange en ACP et fixe son échéance.
Agent Sandbox alloue les ressources et les détruit.**

## Qui fait quoi ?

- **Agora** construit les images complètes ACP + WebSocket et consomme les claims.
- **infra-k8s** configure les templates, pools par image versionnée, Kata, réseau et ressources.
- **Agent Sandbox** entretient le stock chaud, attribue les sandboxes, expose leur état et les détruit.

Le processus ACP et le serveur WS démarrent dans le pool. Chaque attribution déclenche
son réapprovisionnement ; un sandbox utilisé n'est jamais remis en stock.

## Les quatre opérations

| Opération | Agora envoie à Kubernetes | Agora récupère |
| --- | --- | --- |
| **Obtenir** | POST d'un `SandboxClaim` : pool via `spec.warmPoolRef.name`, échéance via `spec.lifecycle.shutdownTime`. | Identité du claim. Allocation chaude ou création à froid. |
| **Observer** | LIST / WATCH des claims. | Conditions `Ready` / `Finished`, `status.sandbox.name` et `status.sandbox.serviceFQDN`. |
| **Renouveler** | PATCH de `spec.lifecycle.shutdownTime`. | Échéance acceptée, absolue, en UTC. |
| **Arrêter** | DELETE du claim, propagation `Foreground`. | Suppression acceptée ; nettoyage par l'infrastructure. |

Les claims utilisent `spec.lifecycle.shutdownPolicy: DeleteForeground`.
Les templates activent `service: true` ; port et chemin WS sont définis avec le pool.
Après `Ready=True`, le backend rejoint le Service et établit ACP avec les autorisations
nécessaires. **Le claim précède la connexion WS ; Ready seul ne prouve pas qu'ACP est exécutable.**

L'UI affiche le démarrage, puis la disponibilité ou l'erreur. À l'arrêt, Agora ferme
l'accès et retire le sandbox dès que la suppression est acceptée, sans attente utilisateur.

## Un bail de 10 minutes, un tour de 1 heure maximum

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

**Proposition à valider entre deux tours :** après une fin confirmée avant expiration,
accorder 10 minutes sans renouvellement. Un nouveau prompt relance le bail si le sandbox
est encore utilisable.

## Les cas limites

- **Retry :** conserver le nom de claim de la demande et vérifier son UID avant mutation.
- **Arrêt ou expiration :** aucun renouvellement tardif ne doit les annuler.
- **Coupure ACP :** récupération bornée par l'échéance accordée, sans renvoi automatique du prompt.
- **Nettoyage :** acceptation du DELETE et expiration ne prouvent pas l'arrêt physique immédiat.

**À préciser :** accès WS et autorisations, conservation entre les tours, stockage,
tâches détachées et reprise après perte du processus.

Référence API : [SandboxClaim v1.0.3](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/extensions/api/v1beta1/sandboxclaim_types.go).
Les mesures Kata sont dans `docs/agent-sandbox-evaluation.md` du dépôt `infra-k8s`.
