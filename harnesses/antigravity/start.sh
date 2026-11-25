#!/bin/sh
# The adapter's command (BRIDGE_ADAPTER): agy keeps its state under $HOME/.gemini/antigravity-cli, on the
# Pod's own HOME; its placeholder login comes from the image. Its sessions are in conversations/ below it,
# the native directory; the token file stays outside it.
set -eu
dir="$HOME/.gemini/antigravity-cli"
mkdir -p "$dir/conversations"
umask 077
cp /etc/agora/antigravity/placeholder-token.json "$dir/antigravity-oauth-token"
# No telemetry: play.googleapis.com is no route of the profile, and it would carry the Bearer.
# Full access, as every pool: none of agy's ACP modes gives it (`auto` still asks).
exec /opt/antigravity/agy acp --disable-telemetry --dangerously-skip-permissions
