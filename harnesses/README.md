# harnesses

The harness images Agent Sandbox starts in its pools: each puts the bridge
(`packages/harness-bridge`) in front of an ACP adapter. Each folder produces its own image, built
from the root.

| Folder | Image | Harness |
| --- | --- | --- |
| `mock/` | `agora-harness-mock` | The lab's mock agent. |
| `claude-code/` | `agora-harness-claude-code` | claude-code 2.1.261 and claude-agent-acp 0.75.1, no credential in the image. |
