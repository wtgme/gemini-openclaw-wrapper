#!/usr/bin/env bash
# install.sh — Install gemini-bridge as a systemd user service and configure OpenClaw
# Usage: bash install.sh

set -e

# Detect node path
NODE_BIN=$(which node 2>/dev/null || echo "")
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH. Install Node.js first (https://nodejs.org or nvm)."
  exit 1
fi
NODE_DIR=$(dirname "$NODE_BIN")

echo "Using node: $NODE_BIN"
echo "Using node dir: $NODE_DIR"
echo "Using home: $HOME"

# Install bridge script
mkdir -p "$HOME/.local/bin"
cp gemini-bridge.mjs "$HOME/.local/bin/gemini-bridge.mjs"
chmod +x "$HOME/.local/bin/gemini-bridge.mjs"
echo "Installed: $HOME/.local/bin/gemini-bridge.mjs"

# Install systemd service (substitute placeholders)
mkdir -p "$HOME/.config/systemd/user"
sed "s|{{NODE_BIN}}|$NODE_BIN|g; s|{{NODE_DIR}}|$NODE_DIR|g; s|{{HOME}}|$HOME|g" \
  gemini-bridge.service > "$HOME/.config/systemd/user/gemini-bridge.service"
echo "Installed: $HOME/.config/systemd/user/gemini-bridge.service"

# Enable and start bridge
systemctl --user daemon-reload
systemctl --user enable gemini-bridge.service
systemctl --user restart gemini-bridge.service

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

# --- Patch OpenClaw config ---

OPENCLAW_DIR="$HOME/.openclaw"
OPENCLAW_JSON="$OPENCLAW_DIR/openclaw.json"

# The gemini-local provider block to inject into models.json files
GEMINI_LOCAL_PROVIDER='{
      "baseUrl": "http://127.0.0.1:18790/v1beta",
      "apiKey": "dummy",
      "api": "google-generative-ai",
      "models": [
        {
          "id": "gcli-3-flash",
          "name": "Gemini 3 Flash (Wrapper)",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 1048576,
          "maxTokens": 8192
        },
        {
          "id": "gcli-3.1-pro",
          "name": "Gemini 3.1 Pro (Wrapper)",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 1048576,
          "maxTokens": 8192
        }
      ]
    }'

# Patch a models.json file: add/replace the gemini-local provider using node
patch_models_json() {
  local file="$1"
  if [ ! -f "$file" ]; then return; fi
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$file', 'utf8'));
    if (!data.providers) data.providers = {};
    data.providers['gemini-local'] = $GEMINI_LOCAL_PROVIDER;
    fs.writeFileSync('$file', JSON.stringify(data, null, 2) + '\n');
    console.log('Patched: $file');
  "
}

# Patch openclaw.json: add/replace models.providers.gemini-local
patch_openclaw_json() {
  local file="$OPENCLAW_JSON"
  if [ ! -f "$file" ]; then
    echo "Skipping openclaw.json patch: file not found at $file"
    return
  fi
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$file', 'utf8'));

    // Ensure models.providers.gemini-local exists with correct models
    if (!data.models) data.models = {};
    if (!data.models.providers) data.models.providers = {};
    data.models.providers['gemini-local'] = {
      baseUrl: 'http://127.0.0.1:18790/v1beta',
      apiKey: 'dummy',
      api: 'google-generative-ai',
      models: [
        { id: 'gcli-3-flash', name: 'Gemini 3 Flash (Wrapper)', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 8192 },
        { id: 'gcli-3.1-pro', name: 'Gemini 3.1 Pro (Wrapper)', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 8192 }
      ]
    };

    // Ensure agents.defaults.models includes our models
    if (!data.agents) data.agents = {};
    if (!data.agents.defaults) data.agents.defaults = {};
    if (!data.agents.defaults.models) data.agents.defaults.models = {};
    data.agents.defaults.models['gemini-local/gcli-3-flash'] = {};
    data.agents.defaults.models['gemini-local/gcli-3.1-pro'] = {};

    fs.writeFileSync('$file', JSON.stringify(data, null, 2) + '\n');
    console.log('Patched: $file');
  "
}

if [ -d "$OPENCLAW_DIR" ]; then
  echo ""
  echo "Patching OpenClaw configuration..."

  patch_openclaw_json

  # Patch all per-agent models.json files
  for models_json in "$OPENCLAW_DIR"/agents/*/agent/models.json; do
    patch_models_json "$models_json"
  done

  # Restart OpenClaw to pick up changes
  if systemctl --user is-active --quiet openclaw-gateway 2>/dev/null; then
    systemctl --user restart openclaw-gateway
    echo "Restarted: openclaw-gateway"
  fi
else
  echo ""
  echo "OpenClaw not found at $OPENCLAW_DIR — skipping config patch."
  echo "To configure manually, see openclaw-config-snippet.json"
fi
