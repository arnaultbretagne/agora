# syntax=docker/dockerfile:1
#
# Builds the `codex` runtime definition's image (packages/agent-registry's CODEX_DEFINITION):
# `@agentclientprotocol/codex-acp` (agents/codex/SPIKE.md's recommendation — no local ACP adapter),
# wrapped by agents/codex/src/bridge-server.ts behind the ACP bridge WebSocket listener a real
# Session Runtime Pod expects. `npm ci` at the repo root pulls the adapter's own optional
# platform-specific native `codex` binary (verified live in the spike: no separate harness install
# step, no runtime package install — docs/specs/09 "The immutable image MUST already contain the
# exact harness and ACP-adapter executables").
#
# Build context MUST be the repository root (npm workspaces need the whole tree):
#   docker build -f agents/codex/image/Dockerfile -t <tag> .

FROM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci
RUN node scripts/build-workspaces.mjs

FROM node:22-alpine
WORKDIR /repo
COPY --from=build /repo /repo
# Smoke-test presence only, no execution of the wrapped native binary (which could attempt a
# network call this build environment has no egress for) — `--version` is the adapter's OWN
# version, read straight from its package.json, never spawning `codex` at all (verified live: same
# behavior confirmed against the spike's own scratch install before writing this Dockerfile).
# npm workspaces hoist both to the monorepo root's node_modules, not the package's own — same
# gotcha `agents/claude-code`'s own Dockerfile already documents.
RUN node /repo/node_modules/.bin/codex-acp --version && \
    test -x /repo/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
USER node
EXPOSE 8080
WORKDIR /repo/agents/codex
ENTRYPOINT ["node", "dist/src/bridge-server.js"]
