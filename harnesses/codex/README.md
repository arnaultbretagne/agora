# codex

Image `agora-harness-codex`: the bridge in front of codex-acp 2.1.1, which runs `codex app-server`
(codex 0.159.3), on the operator's ChatGPT subscription through the gateway (profile `chatgpt`,
`docs/specs/credentials.md`). No credential in the image.

| File | Role |
| --- | --- |
| `package.json` | What the image installs: codex-acp, and codex pinned under it (`overrides`). Not a workspace of the repository. |
| `start.sh` | The adapter's command: writes the placeholder login and copies the configuration into `CODEX_HOME`, on the Pod's emptyDir, then runs codex-acp. |
| `placeholder-auth.mjs` | codex's `auth.json` in ChatGPT mode: unsigned JWTs, a refresh token that is not one, a last refresh in the future so codex never tries. The account id (`CODEX_ACCOUNT_ID`, set by the template) is the workspace codex selects: without it, opening a Session fails. |
| `config.toml` | ChatGPT over HTTPS (WebSockets do not cross the gateway), and nothing beyond the profile: plugins, apps and analytics off. |

The template sets `SSL_CERT_FILE` to the gateway's root — codex is a Rust binary and does not read
`NODE_EXTRA_CA_CERTS` — and `CODEX_ACCOUNT_ID`. Native directory saved:
`$HOME/.codex/sessions/`, its rollouts, read at `session/resume`; `auth.json` stays outside it.

git is in the image, for the agent's repositories: it reaches GitHub through the gateway, whose
root it trusts by `GIT_SSL_CAINFO`, which the template sets.

`docker build -f harnesses/codex/Dockerfile .` from the root.
