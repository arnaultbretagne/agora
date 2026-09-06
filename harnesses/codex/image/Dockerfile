# S10 — everything at build time (ADR 0006: complete harness images, nothing installed at startup).
# Same shape as harnesses/claude-code/image/Dockerfile, and for the same reasons; the differences are
# the adapter it pins and the egress it needs.
#
# Build context is the REPOSITORY ROOT (npm workspaces hoists dependencies into one root
# node_modules and symlinks @agora/* to their source directories):
# `docker build -f harnesses/codex/image/Dockerfile .` from the repo root.
FROM node:22-bookworm-slim AS workspace

WORKDIR /workspace
COPY . .
# The root's own hand-ordered `build`, not `--workspaces --if-present`: the latter does not reliably
# order workspace builds, which CI caught for claude-code's image before this one existed.
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS adapter

WORKDIR /adapter
# Pinned exact version. `@openai/codex` arrives as this adapter's own dependency — pinning the
# adapter pins the CLI it was tested against, which is the point of a complete image.
RUN npm install --global @agentclientprotocol/codex-acp@1.10.0 && npm cache clean --force

# Fail the build, not a running Pod, if the adapter cannot even report its own version. The bin
# entry, never the bare specifier: resolving the package lands on the library main, which exits
# without serving ACP (the trap claude-code's README records; it applies here identically).
RUN node "$(npm root -g)/@agentclientprotocol/codex-acp/dist/index.js" --version \
    && test -d "$(npm root -g)/@openai/codex"

FROM node:22-bookworm-slim

RUN groupadd --gid 10001 harness \
    && useradd --uid 10001 --gid harness --no-create-home --shell /usr/sbin/nologin harness

COPY --from=adapter /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN chmod +x /usr/local/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js

# The whole built workspace: its node_modules/@agora/* symlinks only resolve with packages/apps/
# harnesses present at the matching relative paths.
# TODO(S11 hardening): prune to this harness's dependency closure; correctness first.
WORKDIR /workspace
COPY --from=workspace /workspace /workspace
WORKDIR /workspace/harnesses/codex

USER harness:harness
ENTRYPOINT ["node", "dist/src/launch.js"]
