# Harness image: the bridge in front of codex's ACP adapter (codex-acp, which runs `codex app-server`),
# launched by Agent Sandbox in its pools. Built from the repository root:
#   docker build -f harnesses/codex/Dockerfile .
# codex-acp 2.1.1 and codex 0.159.3 (package.json), on the operator's ChatGPT subscription through the
# gateway. No credential: the auth.json written at start is a placeholder (placeholder-auth.mjs).
FROM node:24-bookworm-slim
WORKDIR /opt/codex
COPY harnesses/codex/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force \
    && test -x node_modules/.bin/codex-acp \
    && test "$(node -p "require('/opt/codex/node_modules/@openai/codex/package.json').version")" = 0.159.3
COPY harnesses/codex/config.toml harnesses/codex/placeholder-auth.mjs harnesses/codex/start.sh /etc/agora/codex/
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/lab/package.json apps/lab/
COPY packages/credentials/package.json packages/credentials/
COPY packages/executions/package.json packages/executions/
COPY packages/harness-bridge/package.json packages/harness-bridge/
COPY packages/mock-agent/package.json packages/mock-agent/
COPY packages/testkit/package.json packages/testkit/
RUN npm ci --omit=dev --workspace @agora/harness-bridge --no-audit --no-fund && npm cache clean --force
COPY packages/harness-bridge/src packages/harness-bridge/src
# The sessions codex resumes are its rollouts, read at session/resume: no restart onto an anchor.
# auth.json stays outside them, in CODEX_HOME.
ENV HOME=/home/harness \
    CODEX_HOME=/home/harness/.codex \
    BRIDGE_DRIVER=codex \
    BRIDGE_ADAPTER='["/etc/agora/codex/start.sh"]' \
    BRIDGE_WORKSPACE=/home/harness/work \
    BRIDGE_NATIVE_DIR=/home/harness/.codex/sessions \
    NODE_NO_WARNINGS=1
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/app/packages/harness-bridge/src/main.ts"]
