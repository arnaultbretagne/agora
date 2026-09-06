# S8 — everything at build time (ADR 0006: complete harness images, nothing installed at startup).
# Digests are pinned by the CI build step that publishes this image; this Dockerfile itself pins
# versions, not digests, since a Dockerfile FROM line cannot self-reference its own build output.
#
# Build context is the REPOSITORY ROOT, not this directory — npm workspaces hoists every
# workspace's dependencies into one root node_modules and symlinks @agora/* packages to their
# source directories (node_modules/@agora/acp -> ../../packages/acp); a harness-directory-only
# context could never resolve those symlinks. `docker build -f harnesses/claude-code/image/Dockerfile .`
# from the repo root (see .dockerignore for what that context excludes: .git, existing node_modules/
# dist since this stage rebuilds both fresh, docs, coverage).
FROM node:22-bookworm-slim AS workspace

WORKDIR /workspace
COPY . .
# `npm run build` (the root's own script), NOT `--workspaces --if-present` directly: the latter
# does not reliably topologically order workspace builds (@agora/testkit's own .d.ts must exist
# before packages whose TEST files import it can type-check) — the root script hand-orders exactly
# that, and every other build in this repo (CI's own `verify` job included) already goes through it.
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS adapter

WORKDIR /adapter
# Pinned exact versions — bumping either is a reviewed change, never a floating range.
RUN npm install --global \
    @anthropic-ai/claude-code@2.1.261 \
    @agentclientprotocol/claude-agent-acp@0.75.1 \
    && npm cache clean --force

# Fail the build, not a running Pod, if either binary cannot even report its own version
# (field-findings §2.2: resolving the bare package specifier silently lands on the library
# entrypoint instead of the bin — this assertion is exactly what would have caught that live).
RUN claude --version \
    && node "$(npm root -g)/@agentclientprotocol/claude-agent-acp/dist/index.js" --cli --version

FROM node:22-bookworm-slim

# Numeric, non-root — kubelet rejects a named account as proof of non-root (S6 field-findings §4).
RUN groupadd --gid 10001 harness \
    && useradd --uid 10001 --gid harness --no-create-home --shell /usr/sbin/nologin harness

COPY --from=adapter /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=adapter /usr/local/bin/claude /usr/local/bin/claude
RUN ln -s /usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js /usr/local/bin/claude-agent-acp \
    && chmod +x /usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js

# The whole built workspace, not just this one package's dist — its node_modules/@agora/* symlinks
# only resolve with packages/apps/harnesses actually present at the matching relative paths.
# TODO(S11 hardening): prune this to exactly this harness's dependency closure; correctness first.
WORKDIR /workspace
COPY --from=workspace /workspace /workspace
WORKDIR /workspace/harnesses/claude-code

USER harness:harness
ENTRYPOINT ["node", "dist/src/launch.js"]
