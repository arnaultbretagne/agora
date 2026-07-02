# agora website (the hub) image. Pure Node — no build step; the channel is NOT
# built here (it ships as a plugin, ADR 0003). Build context = repo root, so we
# can copy both website/ and its sibling shared/ (server.js imports ../shared).
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8600
WORKDIR /app/website

# deps first (layer cache): only `ws` at runtime
COPY website/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# app + the shared protocol as a sibling (../shared/protocol.js)
COPY shared /app/shared
COPY website/server.js ./server.js
COPY website/lib ./lib
COPY website/public ./public

# neutral conversation store (ADR 0005) lives on a mounted volume, not the image
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8600

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
