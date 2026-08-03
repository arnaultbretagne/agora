# syntax=docker/dockerfile:1
#
# Builds FAKE_AGENT_DEFINITION's image (packages/agent-registry/src/fake-definition.ts):
# `@agora/acp`'s deterministic fake Agent, wrapped by
# apps/session-runtime-controller/src/fake-agent-server.ts behind the ACP bridge WebSocket listener
# a real Session Runtime Pod expects. Test-only — plans/04's non-goal is explicit ("No real
# Claude/Codex integration"), so this image is never security-reviewed the way a real Agent image
# would be (docs/specs/09 "Verify the pinned image already contains the declared harness and ACP
# adapter versions").
#
# Build context MUST be the repository root (npm workspaces need the whole tree):
#   docker build -f apps/session-runtime-controller/fake-agent-image/Dockerfile -t <tag> .

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
WORKDIR /repo/apps/session-runtime-controller
ENTRYPOINT ["node", "dist/src/fake-agent-server.js"]
