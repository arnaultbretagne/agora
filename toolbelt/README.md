# toolbelt

`agora-toolbelt`, the shared base image of the real harnesses (claude-code, codex, opencode, antigravity): what an
agent's sandbox carries besides its harness. It is no harness: not a folder of `harnesses/`, never deployed, never
proposed to infra-k8s. The CI builds it first, publishes it from the base branch under its inputs' fingerprint
(`scripts/inputs.ts agora-toolbelt`), and gives it to each harness as `TOOLBELT_IMAGE`. A harness built on it counts
its inputs as its own: a new toolbelt is a new image of each.

| What | Where |
| --- | --- |
| git, git-lfs, curl, wget, openssl, jq, ripgrep, fd (`fdfind` too), tree, file, less, patch, rsync, zip, unzip, xz, bzip2, zstd, procps, psmisc, lsof, bc, envsubst, shellcheck | Debian 12 |
| gcc, make (`build-essential`), pkg-config | Debian 12 |
| sqlite3, certutil (`libnss3-tools`), fontconfig and the fonts and libraries Chromium needs | Debian 12 |
| PostgreSQL 17, server and client; no cluster | PGDG, `/usr/lib/postgresql/17/bin` |
| kubectl 1.36.5, yq 4.54.3, kustomize 5.8.3, kubeconform 0.8.0, uv and uvx 0.13.10, ruff 0.17.6, agent-browser 0.45.0 | `/usr/local/bin` |
| CPython 3.13.18 (python-build-standalone 20261124) | `/opt/python` |
| Rust 1.100.0, cargo, clippy, rustfmt; rustup 1.29.3 with that toolchain linked as its default | `/opt/rust`, `RUSTUP_HOME=/opt/rustup`, `/opt/cargo/bin` |
| Chromium and Chromium headless shell 153.0.8010.12, revision 1243, playwright 1.63.0's | `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` |

Each file fetched from outside Debian's and PGDG's signed archives is pinned to a version and checked against its
sha256 (`ADD --checksum`); archives are unpacked in a stage of their own, so none stays in a layer.

## In the sandbox

The root is read-only, HOME (`/home/harness`) and `/tmp` are scratch, the user is 10001:10001 (`harness` in
`/etc/passwd`, which initdb and psql look up), with no capability.

| Need | How |
| --- | --- |
| A command of one's own | `~/.local/bin` and `~/.cargo/bin` come first on `PATH`. `NPM_CONFIG_PREFIX=/home/harness/.local` (`npm install -g`), `UV_TOOL_BIN_DIR=/home/harness/.local/bin` (`uv tool install`), `CARGO_HOME=/home/harness/.cargo` (`cargo install`). An image built on the toolbelt installs its own global npm packages with `NPM_CONFIG_PREFIX=/usr/local`. |
| PostgreSQL | `initdb -D /tmp/pg -U postgres --auth=trust`, then `pg_ctl -D /tmp/pg -l /tmp/pg.log -o "-k /tmp -c listen_addresses=127.0.0.1" -w start`: Debian's default socket directory is not writable. |
| A browser | `agent-browser`, on the Chromium above (`AGENT_BROWSER_EXECUTABLE_PATH`), without Chromium's sandbox (`AGENT_BROWSER_ARGS`), which needs a user namespace the sandbox does not give. |
| The gateway's root | The bridge, at start: `SSL_CERT_FILE` for OpenSSL's clients when the template does not set it, and `~/.pki/nssdb` for Chromium (`packages/harness-bridge`, `trust.ts`). |

## Tried

`toolbelt/smoke.sh <image>` runs the image as a sandbox does — `--user 10001:10001 --read-only --cap-drop ALL`,
HOME and `/tmp` on tmpfs — and tries each tool: the CLIs answer; a Rust binary is compiled, linked and run in `/tmp`
with `RUSTUP_HOME` read-only and `CARGO_HOME` under HOME; PostgreSQL 17 starts, answers and stops in `/tmp`;
certutil creates `~/.pki/nssdb` and lists a test root; agent-browser opens a page served on `127.0.0.1`, finds its
text in a snapshot, saves a PNG screenshot and closes; an executable in `~/.local/bin` is found on `PATH`. The CI runs
it on the toolbelt and on each harness built on it. Docker's `--tmpfs` is `noexec` unless told otherwise, the
sandbox's HOME and `/tmp` are not: the script mounts them `exec`.

```sh
docker build -t agora-toolbelt -f toolbelt/Dockerfile .
toolbelt/smoke.sh agora-toolbelt
docker build -t agora-harness-claude-code -f harnesses/claude-code/Dockerfile .   # TOOLBELT_IMAGE=agora-toolbelt
```
