# agora image. Ships TWO things from the one product repo (ADR 0003):
#   1. the website (hub) — the container's runtime role;
#   2. a delivery copy of the channel plugin at /opt/agora — NOT run here, but
#      copied onto the runtime PVC by an initContainer in the agent pod, then
#      `claude plugin install`ed there (the channel executes in the runtime pod,
#      its code stays product-side; it is delivered as a plugin, never baked into
#      the agent-runtime image).
# Build context = repo root (server.js imports ../shared; the channel + marketplace
# manifest live at repo root too).

# --- stage: stage the channel plugin with its runtime deps ---
FROM node:20-bookworm-slim AS channel
WORKDIR /opt/agora/channel
COPY channel/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY channel/ ./
COPY .claude-plugin /opt/agora/.claude-plugin

# --- runtime: the hub ---
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8600
WORKDIR /app/website

# hub deps first (layer cache): only `ws` at runtime
COPY website/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# hub app + the shared protocol as a sibling (../shared/protocol.js)
COPY shared /app/shared
COPY website/server.js ./server.js
COPY website/lib ./lib
COPY website/public ./public

# the channel delivery (for the agent pod's initContainer to copy onto the PVC)
COPY --from=channel /opt/agora /opt/agora

# neutral conversation store (ADR 0005) lives on a mounted volume, not the image
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8600

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
