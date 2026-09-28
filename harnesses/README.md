# harnesses

Les images de harness, qu'Agent Sandbox lance dans ses pools : chacune met le bridge
([packages/harness-bridge](../packages/harness-bridge/)) devant un adaptateur ACP. Chaque dossier
produit sa propre image, construite depuis la racine.

| Dossier | Image | Harness |
| --- | --- | --- |
| [mock/](mock/) | `agora-harness-mock` | L'agent mock du banc. |
| [claude-code/](claude-code/) | `agora-harness-claude-code` | claude-code 2.1.261 et claude-agent-acp 0.75.1, sans credential. |
