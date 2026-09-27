# sandbox-bridge

Le côté image du contrat ([docs/backend.md](../../docs/backend.md), « L'image ») : le bridge
lance l'adaptateur ACP, l'initialise une fois, le relaie par un WebSocket numéroté et, au
SIGTERM, pousse les fichiers natifs du harness vers Agora.

| Dossier | Contenu |
| --- | --- |
| [src/](src/) | Le bridge, son point d'entrée, le jeton, l'anchor. |
| [test/](test/) | Le contrat de l'image, contre l'agent mock. |

Exports : `@agora/sandbox-bridge` (tout), `@agora/sandbox-bridge/token`, `@agora/sandbox-bridge/anchor`.
