# S8 — everything at build time (ADR 0006: complete harness images, nothing installed at startup).
# Digests are pinned by the CI build step that publishes this image; this Dockerfile itself pins
# versions, not digests, since a Dockerfile FROM line cannot self-reference its own build output.
FROM node:22-bookworm-slim AS build

WORKDIR /build
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

COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=build /usr/local/bin/claude /usr/local/bin/claude
RUN ln -s /usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js /usr/local/bin/claude-agent-acp \
    && chmod +x /usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js

WORKDIR /app
COPY dist/ ./dist/
COPY package.json ./
# node_modules of THIS package (ws, @agora/acp) — installed at image build, never at Pod startup.
COPY node_modules/ ./node_modules/

USER harness:harness
ENTRYPOINT ["node", "dist/src/launch.js"]
