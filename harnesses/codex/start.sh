#!/bin/sh
# The adapter's command (BRIDGE_ADAPTER): CODEX_HOME is on the Pod's emptyDir, where codex keeps its
# sessions and state; its placeholder login and its configuration come from the image.
set -eu
mkdir -p "$CODEX_HOME"
node /etc/agora/codex/placeholder-auth.mjs > "$CODEX_HOME/auth.json"
cp /etc/agora/codex/config.toml "$CODEX_HOME/config.toml"
exec /opt/codex/node_modules/.bin/codex-acp
