# packages

Le code partagé, sans identité de déploiement.

| Dossier | Paquet | Rôle |
| --- | --- | --- |
| [credentials/](credentials/) | `@agora/credentials` | Les credentials d'une exécution : la session proxy Agent Vault frappée par Agora. |
| [executions/](executions/) | `@agora/executions` | Les exécutions d'Agora : claims, échéance, relais ACP, anchors, remise d'un credential au bridge. |
| [harness-bridge/](harness-bridge/) | `@agora/harness-bridge` | Le bridge devant le harness dans l'image, le jeton d'Agora, le format de l'anchor. |
| [mock-agent/](mock-agent/) | `@agora/mock-agent` | L'agent ACP sans modèle du banc. |
| [testkit/](testkit/) | `@agora/testkit` | Outils de test : un bridge avec l'agent mock en local, un client WebSocket. |
