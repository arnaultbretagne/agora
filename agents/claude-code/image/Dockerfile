# syntax=docker/dockerfile:1
#
# Builds the `claude-code` runtime definition's image (packages/agent-registry's
# CLAUDE_CODE_DEFINITION): `@agentclientprotocol/claude-agent-acp` (agents/claude-code/SPIKE.md's
# recommendation — no local ACP adapter), wrapped by agents/claude-code/src/bridge-server.ts behind
# the ACP bridge WebSocket listener a real Session Runtime Pod expects. `npm ci` at the repo root
# pulls the adapter's own optional platform-specific native `claude` binary (verified live in the
# spike: no separate harness install step, no runtime package install — docs/specs/09 "The
# immutable image MUST already contain the exact harness and ACP-adapter executables").
#
# Build context MUST be the repository root (npm workspaces need the whole tree):
#   docker build -f agents/claude-code/image/Dockerfile -t <tag> .

FROM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci
RUN node scripts/build-workspaces.mjs

FROM node:22-alpine
WORKDIR /repo
COPY --from=build /repo /repo
# Smoke-test presence only, no execution of the wrapped native CLI (which could attempt a
# network call this build environment has no egress for) — `--version` (no `--cli`) is the
# adapter's OWN version, read straight from its package.json, never spawning `claude` at all.
# npm workspaces hoist both to the monorepo root's node_modules, not the package's own (verified
# live: an earlier version of this Dockerfile assumed the un-hoisted path and failed the build).
RUN node /repo/node_modules/.bin/claude-agent-acp --version && \
    test -x /repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude
USER node
EXPOSE 8080
WORKDIR /repo/agents/claude-code
ENTRYPOINT ["node", "dist/src/bridge-server.js"]
