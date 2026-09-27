# executions

Ce que fait Agora pour une exécution ([docs/executions.md](../../docs/executions.md), « Côté
Agora ») : demander le sandbox à Agent Sandbox (un `SandboxClaim`), joindre son bridge par le
Service, relayer ACP en suivant les tours, ré-armer l'échéance pendant un tour, recevoir
l'anchor que le Pod pousse, et reprendre une exécution depuis un anchor. Il ne crée ni ne
supprime aucun sandbox.

| Dossier | Contenu |
| --- | --- |
| [src/](src/) | Le gestionnaire, le client Kubernetes, le stockage des anchors, l'API. |
| [test/](test/) | Le contrat, contre de vrais bridges et une API Kubernetes simulée. |

Monté aujourd'hui par [apps/lab](../../apps/lab/), demain par le serveur d'Agora.
