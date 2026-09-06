# syntax=docker/dockerfile:1
# The control plane's image (S13 — the first deployment). Both modes ship in it: the process picks
# `--api-only` or `--worker-only` from its arguments, so the API and the worker are the same
# artifact and cannot drift apart between a rollout and the next.
#
# Build context is the REPOSITORY ROOT, for the reason harnesses/claude-code/image/Dockerfile
# already documents at length: npm workspaces hoists dependencies into one root `node_modules` and
# symlinks `@agora/*` to their source directories, so a context rooted at this app could never
# resolve them.
#
#   docker build -f apps/control-plane/image/Dockerfile -t agora-control-plane .
FROM node:22-bookworm-slim AS workspace

WORKDIR /workspace
COPY . .
# The root's own hand-ordered `build`, never `--workspaces --if-present`: that one does not
# reliably order workspace builds, which CI caught the first time this repository tried it.
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

# Numeric and non-root: the kubelet's `runAsNonRoot` check reads the UID, and a named account is
# not proof to it (S6 field-findings §4). 10001 matches every PodSpec in deploy/base.
RUN groupadd --gid 10001 agora \
    && useradd --uid 10001 --gid agora --no-create-home --shell /usr/sbin/nologin agora

WORKDIR /workspace
COPY --from=workspace /workspace /workspace
WORKDIR /workspace/apps/control-plane

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "dist/src/main.js"]
