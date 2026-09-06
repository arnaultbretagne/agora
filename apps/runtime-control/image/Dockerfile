# syntax=docker/dockerfile:1
# runtime-control's image (S13). The one deployable that carries a Kubernetes token, and the only
# one that may create a Pod — which is a property of its ServiceAccount and RBAC
# (contracts/k8s/10-runtime-control-rbac.yaml), not of anything in this file.
#
# Build context is the REPOSITORY ROOT (npm workspaces — see apps/control-plane/image/Dockerfile).
#
#   docker build -f apps/runtime-control/image/Dockerfile -t agora-runtime-control .
FROM node:22-bookworm-slim AS workspace

WORKDIR /workspace
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

RUN groupadd --gid 10001 agora \
    && useradd --uid 10001 --gid agora --no-create-home --shell /usr/sbin/nologin agora

WORKDIR /workspace
COPY --from=workspace /workspace /workspace
WORKDIR /workspace/apps/runtime-control

USER 10001:10001
EXPOSE 8090
ENTRYPOINT ["node", "dist/src/main.js"]
