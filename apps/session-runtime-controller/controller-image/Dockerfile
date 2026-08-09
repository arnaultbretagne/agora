# syntax=docker/dockerfile:1
#
# Builds the Session Runtime controller itself (apps/session-runtime-controller/src/main.ts).
# Verification-grade: used to run the controller AS A POD for live-cluster checks (e.g.
# plans/06-custody-and-resume.md's exit criterion, which needs a real Service DNS name a Session
# Runtime Pod can call back for custody restore). A durable production packaging/deploy story is a
# separate concern (infra repo), same split as agent-runtime/agora historically.
#
# Build context MUST be the repository root (npm workspaces need the whole tree):
#   docker build -f apps/session-runtime-controller/controller-image/Dockerfile -t <tag> .

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
WORKDIR /repo/apps/session-runtime-controller
ENTRYPOINT ["node", "dist/src/main.js"]
