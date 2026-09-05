# syntax=docker/dockerfile:1
# Build context is the repository root (npm workspaces):
#   docker build -f apps/web/image/Dockerfile -t agora-web .
FROM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci && npm run build -w @agora/web

FROM node:22-alpine
WORKDIR /repo/apps/web
COPY --from=build /repo/apps/web/package.json ./package.json
COPY --from=build /repo/apps/web/public ./public
COPY --from=build /repo/apps/web/dist/src ./dist/src
COPY --from=build /repo/apps/web/dist/client ./dist/client
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/src/main.js"]
