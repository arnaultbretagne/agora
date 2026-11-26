# Harness image: the bridge in front of opencode's own ACP server (`opencode acp`), launched by Agent
# Sandbox in its pools. Built from the repository root:  docker build -f harnesses/opencode/Dockerfile .
# opencode 1.19.5, a Bun binary, on z.ai's Coding Plan. No credential: ZHIPU_API_KEY below is a
# marker the gateway replaces. Nothing is fetched at start: the model catalogue is in the image, and
# the configuration directory is read-only — a writable one makes opencode install a plugin from npm.
# The toolbelt it is built on (toolbelt/Dockerfile): the CI gives the one it built or published for the same inputs;
# by default the one `docker build -t agora-toolbelt -f toolbelt/Dockerfile .` tags.
ARG TOOLBELT_IMAGE=agora-toolbelt
# On the toolbelt (toolbelt/Dockerfile): git, kubectl and the rest of what an agent's sandbox carries.
FROM ${TOOLBELT_IMAGE}
WORKDIR /app
RUN NPM_CONFIG_PREFIX=/usr/local npm install --global --no-audit --no-fund opencode-linux-x64@1.19.5 \
    && npm cache clean --force \
    && /usr/local/lib/node_modules/opencode-linux-x64/bin/opencode --version
COPY harnesses/opencode/opencode.json /etc/agora/xdg/opencode/opencode.json
COPY harnesses/opencode/models.json /etc/agora/opencode-models.json
RUN printf 'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n' > /etc/agora/xdg/opencode/.gitignore
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/credentials/package.json packages/credentials/
COPY packages/executions/package.json packages/executions/
COPY packages/harness-bridge/package.json packages/harness-bridge/
COPY packages/mock-agent/package.json packages/mock-agent/
COPY packages/testkit/package.json packages/testkit/
RUN npm ci --omit=dev --workspace @agora/harness-bridge --no-audit --no-fund && npm cache clean --force
COPY packages/harness-bridge/src packages/harness-bridge/src
# The database lives in the native directory, which the bridge creates before the adapter starts and,
# since opencode opens it when it starts, restores by restarting it.
ENV HOME=/home/harness \
    BRIDGE_DRIVER=opencode \
    BRIDGE_ADAPTER='["/usr/local/lib/node_modules/opencode-linux-x64/bin/opencode","acp"]' \
    BRIDGE_WORKSPACE=/home/harness/work \
    BRIDGE_NATIVE_DIR=/home/harness/.local/share/opencode/agora \
    BRIDGE_RESTART_ON_ANCHOR=true \
    OPENCODE_DB=/home/harness/.local/share/opencode/agora/opencode.db \
    XDG_CONFIG_HOME=/etc/agora/xdg \
    OPENCODE_MODELS_PATH=/etc/agora/opencode-models.json \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_SHARE=true \
    OPENCODE_DISABLE_LSP_DOWNLOAD=true \
    ZHIPU_API_KEY=agora-placeholder \
    NODE_NO_WARNINGS=1
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/app/packages/harness-bridge/src/main.ts"]
