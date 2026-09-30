# The lab: Agora's executions (packages/executions) and the page that exercises them. Built from the
# repository root (npm workspaces):  docker build -f apps/lab/Dockerfile .
# Node 24 runs the TypeScript sources directly (type stripping); nothing is compiled.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/lab/package.json apps/lab/
COPY packages/credentials/package.json packages/credentials/
COPY packages/executions/package.json packages/executions/
COPY packages/log/package.json packages/log/
COPY packages/harness-bridge/package.json packages/harness-bridge/
COPY packages/mock-agent/package.json packages/mock-agent/
COPY packages/testkit/package.json packages/testkit/
RUN npm ci --omit=dev --workspace @agora/lab --no-audit --no-fund && npm cache clean --force
COPY packages/harness-bridge/src packages/harness-bridge/src
COPY packages/credentials/src packages/credentials/src
COPY packages/executions/src packages/executions/src
COPY packages/log/src packages/log/src
COPY packages/log/sql packages/log/sql
COPY packages/log/scripts packages/log/scripts
COPY apps/lab/src apps/lab/src
COPY apps/lab/public apps/lab/public
ENV NODE_NO_WARNINGS=1
USER 10001:10001
EXPOSE 8080 8081
ENTRYPOINT ["node", "/app/apps/lab/src/main.ts"]
