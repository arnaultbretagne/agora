# The sandbox back-end and its lab page. Built from the repository root (npm workspaces):
#   docker build -f apps/sandbox-backend/Dockerfile .
# Node 24 runs the TypeScript sources directly (type stripping); nothing is compiled.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/sandbox-backend/package.json apps/sandbox-backend/
COPY packages/sandbox-bridge/package.json packages/sandbox-bridge/
COPY packages/mock-agent/package.json packages/mock-agent/
COPY packages/sandbox-testkit/package.json packages/sandbox-testkit/
RUN npm ci --omit=dev --workspace @agora/sandbox-backend --no-audit --no-fund && npm cache clean --force
COPY packages/sandbox-bridge/src packages/sandbox-bridge/src
COPY apps/sandbox-backend/src apps/sandbox-backend/src
COPY apps/sandbox-backend/public apps/sandbox-backend/public
ENV NODE_NO_WARNINGS=1
USER 10001:10001
EXPOSE 8080 8081
ENTRYPOINT ["node", "/app/apps/sandbox-backend/src/main.ts"]
