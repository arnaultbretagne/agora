# ADR — Le back-end des sandboxes

Proposée le 27 septembre 2026, à valider.

**Agent Sandbox fait vivre et mourir les sandboxes ; Agora ne fait que fixer leur
échéance. Le Pod pousse lui-même son anchor en partant.**

Détail : [interface Agent Sandbox](agent-sandbox.md), [contrat de l'image](sandbox-image.md),
[API du back-end](sandbox-backend.md).

## Contexte

Agora exécute des harnesses ACP dans des sandboxes et garde leur historique. La refonte
confie l'exécution à Agent Sandbox et les credentials à Agent Vault ([design](design.md)).
Il restait à fixer comment Agora obtient un sandbox, le garde le temps d'un travail,
le laisse partir, et ce qu'il en conserve.

## Décisions

| Sujet | Retenu |
| --- | --- |
| **Exécution** | Agent Sandbox v1.0.3 : un `SandboxClaim` par demande, pris dans un pool chaud. Un template et un pool par image, nommés d'après son digest. |
| **Isolation** | Kata : une VM par Pod, RuntimeClass `kata`. |
| **Stockage dans le sandbox** | Aucun volume persistant. Ce que l'agent veut garder, il le pousse lui-même : du code, une note. |
| **Durée de vie** | Agora fixe `shutdownTime` et le ré-arme chaque minute pendant un tour : min(maintenant + 10 min, début du tour + 1 h). Après un tour, 10 minutes sans renouvellement. |
| **Destruction** | Seulement par l'infrastructure, à l'échéance. Arrêter, c'est cesser de renouveler. |
| **Anchor** | Les fichiers natifs du harness, en bloc, et rien d'autre. Sauvés une seule fois : à la fin du Pod. |
| **Sauvegarde** | Poussée par le Pod au SIGTERM, dans les 30 s de grâce. Il s'identifie par un jeton de ServiceAccount projeté, vérifié par `TokenReview`. Agora stocke. |
| **Reprise** | Nouveau sandbox, dépôt de l'anchor, puis `session/resume` du harness. |
| **Accès au sandbox** | Le back-end joint le Pod par son IP, avec un jeton Ed25519 signé par Agora et lié au nom du Pod. Aucun secret dans le sandbox. |
| **Relais ACP** | Un seul client par bridge. Lignes numérotées et gardées pour rejouer après une coupure ou un redémarrage d'Agora. |
| **État d'Agora** | Écrit sur le claim (tour en cours, session, instance…) : un redémarrage relit Kubernetes et reprend. |

## Écarté

| Option | Pourquoi |
| --- | --- |
| Agora supprime les claims ou les Pods | Un seul acteur détruit : l'infrastructure, à l'échéance. Agora n'a ni reaper ni droit `delete`. |
| Contrôleur de Pods ou reaper maison | Agent Sandbox le fait déjà. |
| Volume persistant (PVC) dans le sandbox | Contraire au principe, et un PVC sur le claim force le démarrage à froid. |
| Garder le sandbox au-delà de 10 minutes après un tour | Le bail suffit ; au-delà, l'infrastructure reprend la ressource et l'anchor la continuité. |
| Agora tire l'anchor pendant la grâce | Course entre le WATCH d'Agora et la mort du Pod. Le Pod sait seul quand il meurt. |
| Sauvegarde à chaque tour | L'anchor ne sert qu'avant la destruction ; le reste du temps, le sandbox vivant fait foi. |
| Le Pod écrit directement dans la base d'Agora | Un sandbox non fiable ne reçoit aucun identifiant de base. Il pousse vers une route d'Agora. |
| Secret ou identité injectés par le claim (`env`) | Force le démarrage à froid et met un secret dans le sandbox. |
| Service headless pour joindre le bridge | Il ne résout que les Pods prêts. L'IP du Pod est dans le statut du claim. |
| Règles réseau par nom de domaine (FQDN Cilium) | Dans une VM Kata, les réponses du proxy DNS de Cilium n'arrivent pas. Du DNS simple et des plages d'adresses. |
| gVisor (`sandboxed`) pour ces sandboxes | Kata retenu après l'évaluation du 22 septembre. gVisor reste pour les autres namespaces. |
| Router amont d'Agent Sandbox | Pas nécessaire : le back-end relaie lui-même le WebSocket. |

## Conséquences

- Un arrêt libère la ressource à l'échéance en cours, au plus 10 minutes plus tard.
- Si Agora est injoignable pendant la grâce, le sandbox part sans anchor.
- Un tour ne peut pas dépasser une heure : à la limite, l'infrastructure le coupe.
- Les sandboxes ont une seule sortie réseau vers Agora : la route de réception des anchors.
- Reprendre depuis un anchor ouvre une nouvelle session native et repaie tout le contexte.

**À préciser :** credentials des harnesses (Agent Vault), stockage des anchors en base,
dossier natif de codex, tâches détachées.
