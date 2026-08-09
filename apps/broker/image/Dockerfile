# syntax=docker/dockerfile:1
#
# Builds apps/broker — the OneCLI-backed capability broker (P08), same verification-grade-image-
# lives-in-the-product-repo pattern as apps/session-runtime-controller/controller-image/Dockerfile.
#
# Build context MUST be the repository root (npm workspaces need the whole tree):
#   docker build -f apps/broker/image/Dockerfile -t <tag> .

FROM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci
RUN node scripts/build-workspaces.mjs

FROM node:22-alpine
WORKDIR /repo
COPY --from=build /repo /repo
USER node
EXPOSE 8443
EXPOSE 8444
WORKDIR /repo/apps/broker
ENTRYPOINT ["node", "dist/src/main.js"]
