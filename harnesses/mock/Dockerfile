# Harness image: the bridge in front of the lab's mock agent, launched by Agent Sandbox in its pools.
# Built from the repository root:  docker build -f harnesses/mock/Dockerfile .
# Everything is in the image (docs/executions.md, "The image"): nothing is fetched when it starts.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/lab/package.json apps/lab/
COPY packages/credentials/package.json packages/credentials/
COPY packages/executions/package.json packages/executions/
COPY packages/harness-bridge/package.json packages/harness-bridge/
COPY packages/mock-agent/package.json packages/mock-agent/
COPY packages/testkit/package.json packages/testkit/
RUN npm ci --omit=dev --workspace @agora/mock-agent --no-audit --no-fund && npm cache clean --force
COPY packages/harness-bridge/src packages/harness-bridge/src
COPY packages/mock-agent/src packages/mock-agent/src
ENV HOME=/home/harness \
    BRIDGE_DRIVER=mock \
    BRIDGE_ADAPTER='["node","/app/packages/mock-agent/src/agent.ts"]' \
    BRIDGE_WORKSPACE=/home/harness/work \
    NODE_NO_WARNINGS=1
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/app/packages/harness-bridge/src/main.ts"]
