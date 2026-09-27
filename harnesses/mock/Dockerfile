# Sandbox image: the bridge in front of the lab's mock agent. Built from the repository root:
#   docker build -f harnesses/mock/Dockerfile .
# Everything is in the image (docs/backend.md, "L'image"): nothing is fetched when a sandbox starts.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/sandbox-backend/package.json apps/sandbox-backend/
COPY packages/sandbox-bridge/package.json packages/sandbox-bridge/
COPY packages/mock-agent/package.json packages/mock-agent/
COPY packages/sandbox-testkit/package.json packages/sandbox-testkit/
RUN npm ci --omit=dev --workspace @agora/mock-agent --no-audit --no-fund && npm cache clean --force
COPY packages/sandbox-bridge/src packages/sandbox-bridge/src
COPY packages/mock-agent/src packages/mock-agent/src
ENV HOME=/home/harness \
    BRIDGE_DRIVER=mock \
    BRIDGE_ADAPTER='["node","/app/packages/mock-agent/src/agent.ts"]' \
    BRIDGE_WORKSPACE=/home/harness/work \
    NODE_NO_WARNINGS=1
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/app/packages/sandbox-bridge/src/main.ts"]
