# antigravity

Image `agora-harness-antigravity`: the bridge in front of the Antigravity CLI 1.5.13 (`agy`, Google's
native binary) and its own ACP server, `agy acp`, on the cluster's own Google login through the gateway
(profile `antigravity`, `docs/specs/credentials.md`, "Antigravity"). No credential in the image.

| File | Role |
| --- | --- |
| `Dockerfile` | agy 1.5.13 from the tarball its installer's manifest names for `linux_amd64`, checked against its sha256 and its sha512; git; kubectl 1.36.5. |
| `start.sh` | The adapter's command: writes the placeholder login into `$HOME/.gemini/antigravity-cli/`, then runs `agy acp --disable-telemetry --dangerously-skip-permissions`. |
| `placeholder-token.json` | The one placeholder file: agy's token store, `antigravity-oauth-token`, as agy itself writes it on a login, with values that are no credential. `access_token` `agora-placeholder`, which the gateway replaces; `refresh_token` `agora-placeholder`, which nothing spends; `expiry` 2099-01-01, so agy never refreshes; `auth_method` `consumer`, a Google account's login. |

With no D-Bus session bus, as in a Pod, agy keeps its login in that file rather than a keyring. On agy
1.5.13, measured against a local stand-in for Google on 2026-11-20: with this file alone, `session/new`
and `authenticate` (`oauth-personal`) succeed without opening a browser, every request carries
`Authorization: Bearer agora-placeholder`, a 401 from Google ends the turn with no refresh and no
browser, and the file is left unchanged. An `expiry` in the past makes agy refresh at
`oauth2.googleapis.com`, which has no route: it would fail.

| Setting | Why |
| --- | --- |
| `--disable-telemetry` | Telemetry goes to `play.googleapis.com/log` with the Bearer; the profile opens no route there. |
| `--dangerously-skip-permissions` | Full access (`docs/specs/assistant-ui.md`, "The mode and other settings"). agy's ACP modes are `default`, `accept-edits`, `auto` and `plan`; `auto`, the widest, still asks before what it deems irreversible, so the pool declares no mode. The Session still reports `default`. Measured on agy 1.5.13 against a local stand-in for Google on 2026-11-25: a shell command, a `rm -rf` and a read outside the workspace each ask once without it, never with it. |
| `AGY_CLI_DISABLE_AUTO_UPDATE=1` | agy updates itself in the background; the image is the version. |

The template sets `SSL_CERT_FILE` to the gateway's root — agy is a Go binary and does not read
`NODE_EXTRA_CA_CERTS`. Native directory saved: `$HOME/.gemini/antigravity-cli/conversations/`, one
SQLite file per conversation, read at `session/resume` while agy runs; the token file stays outside it.

git is in the image, for the agent's repositories: it reaches GitHub through the gateway, whose
root it trusts by `GIT_SSL_CAINFO`, which the template sets.

`docker build -f harnesses/antigravity/Dockerfile .` from the root.
