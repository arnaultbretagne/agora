# test

| Fichier | Rôle |
| --- | --- |
| `backend.test.ts` | Le contrat du back-end, contre de vrais bridges qui font tourner l'agent mock. |
| `fake-kube.ts` | Une API Kubernetes en mémoire qui joue aussi le contrôleur d'Agent Sandbox : à l'échéance, elle supprime le claim et termine le Pod, qui pousse son anchor. |

`npm test -w @agora/sandbox-backend`
