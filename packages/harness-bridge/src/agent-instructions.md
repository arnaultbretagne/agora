# Where you are

You are an agent running in an Agora execution: a short-lived machine of your own. Agora wrote
this file when the machine started, to tell you what you cannot see from here.

## Your files

- Your working directory, `/home/harness/work`, starts empty: clone what you need into it.
- Only your home (`/home/harness`) and `/tmp` are writable; everything else is read-only.
- The conversation outlives this machine; your files do not. The machine ends once the
  conversation has been quiet for a few minutes, and the next message starts on a new one: the
  same conversation, an empty working directory. Push your work — a branch — before you call a
  task done. If you find the working directory empty in the middle of a conversation, clone again.
- `/run/agora` and `/etc/agora` are Agora's plumbing: nothing there is for you.

## Your network

Everything you send goes out through a gateway. It lets through only the access you were given
and sets the credentials itself: you hold none and need none. There is no other way out.

- `403` with `authorization failed`: outside your access. It is not an outage, and no other
  address will get around it.
- `404` on `CONNECT`: a port other than 443. The gateway serves `https://` on port 443 only;
  `http://` is refused.
- `503`: the host cannot be reached — its name does not resolve, or it does not answer. Private
  addresses never answer.

## Your access

`~/.agora/access.json` holds the claims of the token you go out with, rewritten whenever the
token changes — which can happen between two messages: read it again before you rely on it.
Its `profiles` say what you may reach; its `grants` are the exact rules the gateway applies —
a host, an anchored regular expression on the path and query, the methods.

| Profile | You may |
| --- | --- |
| `github:OWNER/REPO:read` | `git clone` and `git fetch` `https://github.com/OWNER/REPO.git`; `GET` `https://api.github.com/repos/OWNER/REPO` and below. |
| `github:OWNER/REPO:write` | The same, plus `git push`, and every method under `https://api.github.com/repos/OWNER/REPO` — a pull request is `POST /repos/OWNER/REPO/pulls`. You act as `agora-contributor[bot]`. |
| `github:OWNER/REPO:review` | Clone, fetch, and every method under `https://api.github.com/repos/OWNER/REPO`, as `agora-reviewer[bot]`: review, comment on and approve pull requests — a review is `POST /repos/OWNER/REPO/pulls/N/reviews`. No `git push`, no merge. |
| `internet` | Any other `https://` host on port 443, with no credential: what anyone on the Internet may do there. On GitHub, what anyone may read: `git clone` and `git fetch` a public repository, `GET` on the REST API. Never a write or a push without the repository's profile. |
| `anthropic`, `zai`, `chatgpt` | Nothing for you to do: the model you run on. |

Without `internet`, nothing else on GitHub is open — not `/user`, not `/search`. GraphQL never
is, so the REST API is the way, and `gh` would fail. Writing to a repository missing from your
profiles — a push, a pull request, an issue — is out of your reach: say so instead of looking for
a way around.

## Your tools

Besides your own tools, the machine carries, all on `PATH` and all going out through the gateway:

- Node 24 and npm; git and git-lfs; curl, wget, openssl, jq, yq, ripgrep (`rg`), `fd`, tree, file,
  less, patch, rsync, zip, unzip, xz, bzip2, zstd, ps, lsof, bc, envsubst, shellcheck.
- kubectl, kustomize, kubeconform.
- gcc, make and pkg-config; Rust stable with cargo, clippy and rustfmt; Python 3.13 (`python3`), uv and
  ruff.
- sqlite3, and PostgreSQL 17: `initdb`, `pg_ctl`, `psql`.
- Chromium, Playwright's own (`PLAYWRIGHT_BROWSERS_PATH`), and `agent-browser` to drive it:
  `agent-browser open <url>`, then `snapshot` (the page as text, with refs to click and fill),
  `click @e2`, `fill @e3 "text"`, `screenshot /tmp/page.png`, and `close` when done;
  `agent-browser --help` for the rest. It trusts the gateway like everything else here.

A PostgreSQL of your own lives in `/tmp`, for as long as the machine does — for Agora's
`npm run check`, for instance:

```sh
initdb -D /tmp/pg -U postgres --auth=trust >/dev/null
pg_ctl -D /tmp/pg -l /tmp/pg.log -o "-k /tmp -c listen_addresses=127.0.0.1" -w start
export LOG_TEST_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres
```

Nothing outside your home and `/tmp` can change, and `apt` cannot run: what you install goes
under your home, which `PATH` already reads first, and is gone with the machine. `npm install -g`
and `uv tool install` put their commands in `~/.local/bin`, `cargo install` in `~/.cargo/bin`; an
executable you drop in `~/.local/bin` is found too. For a one-off, `npx <package>` and
`uvx <tool>` run a tool without installing it.

git already commits as `agora-contributor[bot]`. Merging a pull request into `main` is the
person's alone: GitHub refuses it to you.
