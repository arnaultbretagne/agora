# syntax=docker/dockerfile:1
#
# Builds apps/web (packages/agent-registry style split: verification-grade image, same as
# apps/session-runtime-controller/controller-image/Dockerfile already established — durable
# packaging lives here, in the product repo, not a separate infra-only build).
#
# Build context MUST be the repository root (npm workspaces need the whole tree):
#   docker build -f apps/web/image/Dockerfile -t <tag> .

FROM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci
RUN node scripts/build-workspaces.mjs

FROM node:22-alpine
WORKDIR /repo
COPY --from=build /repo /repo
USER node
EXPOSE 8080
WORKDIR /repo/apps/web
ENTRYPOINT ["node", "dist/src/main.js"]
