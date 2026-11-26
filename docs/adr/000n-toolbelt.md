# ADR 000n — Toolbelt

- **Status:** proposed
- **Date:** 2026-11-26

## Context

- An agent works in a sandbox of its own: a Kata micro-VM with 1 CPU and 4 GiB, as uid 10001, root read-only, every
  capability dropped, PSA `restricted`; HOME (`/home/harness`) and `/tmp` share 8 GiB of scratch, gone with the
  machine.
- `apt` cannot run there, and what an agent installs at start is lost at each recycle and paid again at the next
  machine.
- The harness images carried Node 24, git and kubectl alone. The agents could not run curl, jq or Python, nor
  Agora's own `npm run check`, which needs PostgreSQL 17 and Playwright's Chromium, nor drive a browser.
- Four real harnesses (claude-code, codex, opencode, antigravity) need the same tools; `harnesses/` holds one folder
  per harness pool, and the CI builds an image for each.
- Everything goes out through the gateway, whose root is trusted by Node (`NODE_EXTRA_CA_CERTS`) and git
  (`GIT_SSL_CAINFO`). Chromium reads neither: on Linux it trusts the NSS database under HOME, which a fresh HOME
  does not hold.
- A branch's CI run must not write packages: only the base branch, or a run by hand, publishes an image.

## Decision

1. **One shared base image, `agora-toolbelt`** (`toolbelt/Dockerfile`, outside `harnesses/`), on
   `node:24-bookworm-slim`: the core CLIs, kubectl and the YAML tools, the C toolchain, CPython 3.13 with uv and
   ruff, Rust stable with clippy and rustfmt, SQLite, PostgreSQL 17, Playwright's Chromium and agent-browser.
2. **The four real harnesses are built on it** (`FROM ${TOOLBELT_IMAGE}`); the mock stays on
   `node:24-bookworm-slim`.
3. **The toolbelt is pinned like the rest.** Each file fetched from outside Debian's and PGDG's signed archives
   names its version and is checked against its sha256; the browser is the one apps/web's playwright names.
4. **Its inputs are each harness's inputs** (`scripts/inputs.ts`): a new toolbelt is a new image of each, and
   nothing else changes for the mock or the server. The toolbelt itself is never deployed nor proposed to
   infra-k8s.
5. **What the agent installs goes under HOME,** read first on `PATH`: `~/.local/bin` (npm's global prefix, uv's
   tools), `~/.cargo/bin` (`CARGO_HOME`). The toolchains themselves stay read-only (`RUSTUP_HOME=/opt/rustup`,
   `/opt/python`). The sandbox's rules do not change.
6. **The bridge trusts the gateway's root for Chromium at start:** when certutil is on `PATH` and the root exists,
   it creates `~/.pki/nssdb` and imports the root, idempotently; it also gives OpenSSL's clients `SSL_CERT_FILE`
   when the template does not. Without certutil or the root — the mock, a test machine — it does nothing.
7. **The CI builds the toolbelt first.** The base branch publishes it under its inputs' fingerprint, with
   provenance and SBOM, and builds the harnesses on that digest; a branch finds it there or builds it locally, and
   publishes nothing. Each build of it, and of each harness on it, runs `toolbelt/smoke.sh` as a sandbox runs it.

## Why

- One base image: the toolbelt's layers are pulled once per node and shared by every harness pool, where four
  copies of them would weigh four times as much in the registry and on each node.
- An agent can run `npm run check` in its sandbox, as the CI does, before it pushes: a PostgreSQL of its own in
  `/tmp`, the browser tests on the baked Chromium.
- Pinned versions and checksums keep the image trusted (ADR Harnesses: the image is trusted, the execution is
  not): a new tool version is a commit, read and reviewed like any other.
- HOME-first `PATH`: an agent's extra tool is a user-space install, with no relaxed rule and nothing written outside
  its scratch.
- The NSS database is per HOME, and HOME is a tmpfs: it can only be made at start, before the adapter, which is the
  bridge's. certutil's `-N` and `-A` are what the system's own tools would do.

## What we tried

| Option | Found | Dropped because |
| --- | --- | --- |
| The tools in each harness's Dockerfile | Four copies of the same steps and the same layers, already the case for git and kubectl. | Duplicated weight, and four places to keep in step. |
| A folder `harnesses/toolbelt/` | `harnesses/` gives one image, pool and catalogue entry per folder holding a Dockerfile. | It would be built, tried and proposed as a harness. |
| Installing at start | Read-only root, no `apt`; a download per machine. | Slow, lost at each recycle, and the image would no longer say what runs. |
| A writable root, or relaxed PSA | — | The sandbox's rules are the security boundary; out of the question. |
| Debian's Python 3.11 and `rustup` downloading its toolchain | Debian's Python is older than what projects require; rustup checks what it downloads against a manifest fetched at build time. | The toolbelt pins and checks each archive itself; rustup only links the toolchain installed from the checked tarballs. |
| Chromium trusting the root by a flag | `--ignore-certificate-errors` trusts everything. | It would trust any certificate, not the gateway's root. |

## Consequences

- The real harness images grow by the toolbelt's size, once per node; a change to the toolbelt rebuilds and
  redeploys the four harness images.
- New tool versions are bumped by hand in `toolbelt/Dockerfile`, with their new checksums; the Chromium revision
  follows apps/web's playwright.
- The CI holds a toolbelt job before the harness images; `.github/workflows/ci.yml` is the operator's to change.
- Chromium runs without its own sandbox (`--no-sandbox`): the micro-VM is the boundary.
- What an agent installs lasts as long as its machine.
