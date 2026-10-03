# harnesses

The harness images Agent Sandbox starts in its pools: each puts the bridge
(`packages/harness-bridge`) in front of an ACP adapter. Each folder produces its own image, built
from the root.

What differs between harnesses is declared by the image, not coded in the bridge: the adapter
(`BRIDGE_ADAPTER`), the native directory an anchor saves (`BRIDGE_NATIVE_DIR`), and whether the
adapter opens it at start and must be restarted to receive an anchor (`BRIDGE_RESTART_ON_ANCHOR`).

| Folder | Image | Harness |
| --- | --- | --- |
| `mock/` | `agora-harness-mock` | The lab's mock agent. |
| `claude-code/` | `agora-harness-claude-code` | claude-code 2.1.261 and claude-agent-acp 0.75.1, no credential in the image. |
| `opencode/` | `agora-harness-opencode` | opencode 1.18.34 and its own ACP server, on z.ai's Coding Plan; no credential in the image. |
| `codex/` | `agora-harness-codex` | codex 0.159.3 and codex-acp 2.1.1, on the ChatGPT subscription; a placeholder login in the image. |
