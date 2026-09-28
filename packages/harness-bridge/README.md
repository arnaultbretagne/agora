# harness-bridge

Le côté image du contrat ([docs/executions.md](../../docs/executions.md), « L'image ») : le bridge
lance l'adaptateur ACP, l'initialise une fois, le relaie par un WebSocket numéroté et, au
SIGTERM, pousse les fichiers natifs du harness vers Agora. L'adaptateur ne sort que par le proxy
sortant du bridge, qui ne s'ouvre qu'une fois un credential branché par Agora
([docs/credentials.md](../../docs/credentials.md)).

| Dossier | Contenu |
| --- | --- |
| [src/](src/) | Le bridge, son point d'entrée, le jeton, l'anchor, le proxy sortant. |
| [test/](test/) | Le contrat de l'image, contre l'agent mock ; le proxy sortant contre un faux proxy de credentials. |

Exports : `@agora/harness-bridge` (tout), `@agora/harness-bridge/token`, `@agora/harness-bridge/anchor`.
