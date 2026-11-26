#!/bin/sh
# The adapter's command (BRIDGE_ADAPTER). opencode reads its global configuration from
# ${XDG_CONFIG_HOME:-$HOME/.config}/opencode, and installs @opencode-ai/plugin from npm into that directory
# whenever it can write there. So ~/.config/opencode is a link to the image's read-only directory, made anew
# at each start, and XDG_CONFIG_HOME stays unset: for opencode and for everything it starts, which keeps its
# own configuration under ~/.config — Chromium its profile and crash reports.
set -eu
mkdir -p "$HOME/.config"
rm -rf "$HOME/.config/opencode"
ln -s /etc/agora/opencode/config "$HOME/.config/opencode"
exec /usr/local/lib/node_modules/opencode-linux-x64/bin/opencode acp
