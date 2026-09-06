# syntax=docker/dockerfile:1
# The Broker's image (S13): the owner API and the egress relay in one process (ADR 0001 — one
# deployable), holding the OneCLI control key and every Agent bearer, and reading Pods read-only to
# resolve a connecting Pod's identity from its source IP (P10).
#
# Build context is the REPOSITORY ROOT (npm workspaces — see apps/control-plane/image/Dockerfile).
#
#   docker build -f apps/broker/image/Dockerfile -t agora-broker .
FROM node:22-bookworm-slim AS workspace

WORKDIR /workspace
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

RUN groupadd --gid 10001 agora \
    && useradd --uid 10001 --gid agora --no-create-home --shell /usr/sbin/nologin agora

WORKDIR /workspace
COPY --from=workspace /workspace /workspace
WORKDIR /workspace/apps/broker

USER 10001:10001
EXPOSE 8091 8444
ENTRYPOINT ["node", "dist/src/main.js"]
