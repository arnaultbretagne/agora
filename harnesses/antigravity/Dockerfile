# Harness image: the bridge in front of the Antigravity CLI's own ACP server (`agy acp`), launched by Agent
# Sandbox in its pools. Built from the repository root:  docker build -f harnesses/antigravity/Dockerfile .
# agy@1.5.13, Google's native binary, on the cluster's own Google login through the gateway (profile
# `antigravity`). No credential: the token file written at start is a placeholder (placeholder-token.json).

# The toolbelt it is built on (toolbelt/Dockerfile): the CI gives the one it built or published for the same inputs;
# by default the one `docker build -t agora-toolbelt -f toolbelt/Dockerfile .` tags.
ARG TOOLBELT_IMAGE=agora-toolbelt

# The release the installer's manifest names for linux_amd64 (antigravity-cli-auto-updater…/manifests),
# checked against its sha256 here and its sha512 as the manifest gives it.
FROM node:24-bookworm-slim AS agy
ADD --checksum=sha256:7fa9cc6df0d09562693d637c406a86c1b0f52ab3364714b1fd2d79cc6060d4b2 \
    https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/linux-x64/cli_linux_x64.tar.gz /tmp/agy.tar.gz
RUN echo '014b37387703acab1f47cd532c8bb60167a6a3537b0f9891de03f1b1ffa9614307bc83c4b2f7551273b0877d722716b0cd9e26782f6b2a50705db4f05e18c68f  /tmp/agy.tar.gz' | sha512sum -c - \
    && mkdir /out && tar -xzf /tmp/agy.tar.gz -C /out antigravity

# On the toolbelt (toolbelt/Dockerfile): git, kubectl and the rest of what an agent's sandbox carries.
FROM ${TOOLBELT_IMAGE}
# agy needs glibc alone (libc, libm, libpthread, libdl, librt, libresolv), which the base image has.
COPY --from=agy /out/antigravity /opt/antigravity/agy
RUN test "$(HOME=/tmp/agy-version /opt/antigravity/agy --version)" = 1.5.13 && rm -rf /tmp/agy-version
COPY harnesses/antigravity/placeholder-token.json harnesses/antigravity/start.sh /etc/agora/antigravity/
WORKDIR /app
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
# The sessions agy resumes are its conversations, one SQLite file each, read at session/resume while it runs:
# no restart onto an anchor. The token file stays outside them. No self-update: the image is the version.
ENV HOME=/home/harness \
    BRIDGE_DRIVER=antigravity \
    BRIDGE_ADAPTER='["/etc/agora/antigravity/start.sh"]' \
    BRIDGE_WORKSPACE=/home/harness/work \
    BRIDGE_NATIVE_DIR=/home/harness/.gemini/antigravity-cli/conversations \
    AGY_CLI_DISABLE_AUTO_UPDATE=1 \
    NODE_NO_WARNINGS=1
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/app/packages/harness-bridge/src/main.ts"]
