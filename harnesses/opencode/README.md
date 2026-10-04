# opencode

Image `agora-harness-opencode`: the bridge in front of opencode's own ACP server (`opencode acp`),
opencode 1.18.34, on z.ai's Coding Plan (`zai-coding-plan`, glm-5.3 by default). No credential in
the image: `ZHIPU_API_KEY` is a marker the gateway replaces, for the pool's base profile `zai`
(`docs/specs/credentials.md`).

| File | Role |
| --- | --- |
| `Dockerfile` | The image. Everything opencode reads is fixed there: catalogue, configuration, database path. |
| `opencode.json` | The configuration, in a read-only directory (`XDG_CONFIG_HOME`): default and small model. A writable one makes opencode install `@opencode-ai/plugin` from npm at every start. |
| `models.json` | The `zai-coding-plan` entry of opencode's model catalogue (`models.opencode.ai/api.json`, 2026-10-02). Without it opencode fetches the catalogue at start; it bundles none. |

Native directory saved: `$HOME/.local/share/opencode/agora/`, the SQLite database (`OPENCODE_DB`).
opencode opens it when it starts, so the image declares `BRIDGE_RESTART_ON_ANCHOR`: placing an
anchor restarts it (`docs/specs/executions.md`).

git is in the image, for the agent's repositories: it reaches GitHub through the gateway, whose
root it trusts by `GIT_SSL_CAINFO`, which the template sets.

`docker build -f harnesses/opencode/Dockerfile .` from the root.
