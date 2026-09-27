# harnesses

Les images de sandbox : chacune met le bridge ([packages/sandbox-bridge](../packages/sandbox-bridge/))
devant un adaptateur ACP. Chaque dossier produit sa propre image, construite depuis la racine.

| Dossier | Image | Harness |
| --- | --- | --- |
| [mock/](mock/) | `agora-sandbox-mock` | L'agent mock du banc. |
| [claude-code/](claude-code/) | `agora-sandbox-claude-code` | claude-code 2.1.261 et claude-agent-acp 0.75.1, sans credential. |
