#!/usr/bin/env bash
# install.sh — Install gemini-bridge as a systemd user service
# Usage: bash install.sh

set -e

# Detect node path
NODE_BIN=$(which node 2>/dev/null || echo "")
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH. Install Node.js first (https://nodejs.org or nvm)."
  exit 1
fi
echo "Using node: $NODE_BIN"

# Install bridge script
mkdir -p "$HOME/.local/bin"
cp gemini-bridge.mjs "$HOME/.local/bin/gemini-bridge.mjs"
chmod +x "$HOME/.local/bin/gemini-bridge.mjs"
echo "Installed: $HOME/.local/bin/gemini-bridge.mjs"

# Install systemd service (substitute real node path)
mkdir -p "$HOME/.config/systemd/user"
sed "s|/home/wt/.nvm/versions/node/v24.13.1/bin/node|$NODE_BIN|g; s|/home/wt|$HOME|g" \
  gemini-bridge.service > "$HOME/.config/systemd/user/gemini-bridge.service"
echo "Installed: $HOME/.config/systemd/user/gemini-bridge.service"

# Enable and start
systemctl --user daemon-reload
systemctl --user enable gemini-bridge.service
systemctl --user start gemini-bridge.service

echo ""
echo "Waiting for ACP processes to initialize (~10s)..."
sleep 10

STATUS=$(curl -s http://127.0.0.1:18790/health 2>/dev/null || echo "")
if echo "$STATUS" | grep -q '"status":"ok"'; then
  echo "OK: bridge is running at http://127.0.0.1:18790"
  echo "$STATUS"
else
  echo "Bridge may still be initializing. Check: systemctl --user status gemini-bridge.service"
fi

echo ""
echo "Next: add the gemini-local provider to your openclaw.json (see openclaw-config-snippet.json)"
