# The server: the execution mechanics (packages/executions), the log (packages/log), the client
# (apps/web) and the test page. Built from the repository root (npm workspaces):
#   docker build -f apps/server/Dockerfile .
# Node 24 runs the server's TypeScript sources directly (type stripping); only the client is built.

# The client: built with Vite, only its files go on.
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/credentials/package.json packages/credentials/
COPY packages/executions/package.json packages/executions/
COPY packages/log/package.json packages/log/
COPY packages/harness-bridge/package.json packages/harness-bridge/
COPY packages/mock-agent/package.json packages/mock-agent/
COPY packages/testkit/package.json packages/testkit/
RUN npm ci --workspace @agora/web --include=dev --no-audit --no-fund && npm cache clean --force
COPY apps/web apps/web
RUN npm run build -w @agora/web

FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/credentials/package.json packages/credentials/
COPY packages/executions/package.json packages/executions/
COPY packages/log/package.json packages/log/
COPY packages/harness-bridge/package.json packages/harness-bridge/
COPY packages/mock-agent/package.json packages/mock-agent/
COPY packages/testkit/package.json packages/testkit/
RUN npm ci --omit=dev --workspace @agora/server --no-audit --no-fund && npm cache clean --force
COPY packages/harness-bridge/src packages/harness-bridge/src
COPY packages/credentials/src packages/credentials/src
COPY packages/executions/src packages/executions/src
COPY packages/log/src packages/log/src
COPY packages/log/sql packages/log/sql
COPY packages/log/scripts packages/log/scripts
COPY apps/server/src apps/server/src
COPY apps/server/public apps/server/public
COPY --from=web /app/apps/web/dist apps/web/dist
ENV NODE_NO_WARNINGS=1
USER 10001:10001
EXPOSE 8080 8081
ENTRYPOINT ["node", "/app/apps/server/src/main.ts"]
