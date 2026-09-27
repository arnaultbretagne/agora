# Sandbox image: the bridge in front of claude-code's ACP adapter. Built from the repository root:
#   docker build -f harnesses/claude-code/Dockerfile .
# Exact versions, the ones measured by S8/S9 of the previous implementation (harnesses/claude-code
# on main). No credential: the token below is a marker that only selects the CLI's OAuth mode.
FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global --no-audit --no-fund \
      @anthropic-ai/claude-code@2.1.261 \
      @agentclientprotocol/claude-agent-acp@0.75.1 \
    && npm cache clean --force \
    && claude --version \
    && node /usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --cli --version
COPY package.json package-lock.json ./
COPY apps/sandbox-backend/package.json apps/sandbox-backend/
COPY packages/sandbox-bridge/package.json packages/sandbox-bridge/
COPY packages/mock-agent/package.json packages/mock-agent/
COPY packages/sandbox-testkit/package.json packages/sandbox-testkit/
RUN npm ci --omit=dev --workspace @agora/sandbox-bridge --no-audit --no-fund && npm cache clean --force
COPY packages/sandbox-bridge/src packages/sandbox-bridge/src
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
ENTRYPOINT ["node", "/app/packages/sandbox-bridge/src/main.ts"]
