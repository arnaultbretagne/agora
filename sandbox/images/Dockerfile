# Les trois images du banc, construites depuis sandbox/ (le contexte) : le bridge avec l'agent mock,
# le bridge avec claude-code, et le back-end. Tout est posé au build (sandbox-image.md) : rien n'est
# téléchargé au démarrage d'un sandbox. Node 24 exécute le TypeScript directement (type stripping).
# Les digests sont épinglés par la CI qui publie ; ce fichier épingle des versions.
FROM node:24-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
# Numérique et non-root : le kubelet refuse un nom de compte comme preuve de non-root.
RUN groupadd --gid 10001 harness && useradd --uid 10001 --gid harness --home-dir /home/harness --no-create-home --shell /usr/sbin/nologin harness

# ---------------------------------------------------------------- sandbox : bridge + agent mock
FROM base AS mock
ENV HOME=/home/harness \
    BRIDGE_DRIVER=mock \
    BRIDGE_ADAPTER='["node","/app/src/mock-agent/main.ts"]' \
    BRIDGE_WORKSPACE=/home/harness/work \
    NODE_NO_WARNINGS=1
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/app/src/bridge/main.ts"]

# ---------------------------------------------------------------- sandbox : bridge + claude-code
FROM base AS claude-code
# Versions exactes, celles mesurées par S8/S9 (harnesses/claude-code sur main).
RUN npm install --global --no-audit --no-fund \
      @anthropic-ai/claude-code@2.1.261 \
      @agentclientprotocol/claude-agent-acp@0.75.1 \
    && npm cache clean --force \
    && claude --version \
    && node /usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --cli --version
# Le jeton est un marqueur sans aucune autorité : il fait choisir le mode OAuth au CLI (S13). Les
# credentials du harness restent hors du contrat de l'image.
ENV HOME=/home/harness \
    BRIDGE_DRIVER=claude-code \
    BRIDGE_ADAPTER='["node","/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"]' \
    BRIDGE_WORKSPACE=/home/harness/work \
    CLAUDE_CODE_OAUTH_TOKEN=agora-placeholder \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    NODE_NO_WARNINGS=1
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/app/src/bridge/main.ts"]

# ---------------------------------------------------------------- le back-end et la page du banc
FROM base AS backend
ENV NODE_NO_WARNINGS=1
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/app/src/backend/main.ts"]
