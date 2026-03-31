#!/usr/bin/env bash
# claude-install.sh — Install claude-bridge as a systemd user service and configure OpenClaw
# Usage: bash claude-install.sh

set -e

# Detect node path
NODE_BIN=$(which node 2>/dev/null || echo "")
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH. Install Node.js first (https://nodejs.org or nvm)."
  exit 1
fi
NODE_DIR=$(dirname "$NODE_BIN")

# Check claude CLI is available
CLAUDE_BIN=$(which claude 2>/dev/null || echo "")
if [ -z "$CLAUDE_BIN" ]; then
  echo "ERROR: claude not found in PATH. Install Claude Code CLI first."
  exit 1
fi

echo "Using node: $NODE_BIN"
echo "Using claude: $CLAUDE_BIN"
echo "Using home: $HOME"

# Install bridge script
mkdir -p "$HOME/.local/bin"
cp claude-bridge.mjs "$HOME/.local/bin/claude-bridge.mjs"
chmod +x "$HOME/.local/bin/claude-bridge.mjs"
echo "Installed: $HOME/.local/bin/claude-bridge.mjs"

# Install systemd service (substitute placeholders)
mkdir -p "$HOME/.config/systemd/user"
sed "s|{{NODE_BIN}}|$NODE_BIN|g; s|{{NODE_DIR}}|$NODE_DIR|g; s|{{HOME}}|$HOME|g" \
  claude-bridge.service > "$HOME/.config/systemd/user/claude-bridge.service"
echo "Installed: $HOME/.config/systemd/user/claude-bridge.service"

# Enable and start bridge
systemctl --user daemon-reload
systemctl --user enable claude-bridge.service
systemctl --user restart claude-bridge.service

echo ""
echo "Waiting for bridge to start (~3s)..."
sleep 3

STATUS=$(curl -s http://127.0.0.1:18791/health 2>/dev/null || echo "")
if echo "$STATUS" | grep -q '"status":"ok"'; then
  echo "OK: bridge is running at http://127.0.0.1:18791"
  echo "$STATUS"
else
  echo "Bridge may still be starting. Check: systemctl --user status claude-bridge.service"
fi

# --- Patch OpenClaw config ---

OPENCLAW_DIR="$HOME/.openclaw"
OPENCLAW_JSON="$OPENCLAW_DIR/openclaw.json"

CLAUDE_LOCAL_PROVIDER='{
      "baseUrl": "http://127.0.0.1:18791/v1",
      "apiKey": "dummy",
      "api": "anthropic-messages",
      "models": [
        {
          "id": "ccli-sonnet",
          "name": "Claude Sonnet (CLI Bridge)",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 16384
        },
        {
          "id": "ccli-opus",
          "name": "Claude Opus (CLI Bridge)",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 16384
        },
        {
          "id": "ccli-haiku",
          "name": "Claude Haiku (CLI Bridge)",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 8192
        }
      ]
    }'

# Patch a models.json file: add/replace the claude-local provider using node
patch_models_json() {
  local file="$1"
  if [ ! -f "$file" ]; then return; fi
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$file', 'utf8'));
    if (!data.providers) data.providers = {};
    data.providers['claude-local'] = $CLAUDE_LOCAL_PROVIDER;
    fs.writeFileSync('$file', JSON.stringify(data, null, 2) + '\n');
    console.log('Patched: $file');
  "
}

# Patch openclaw.json: add/replace models.providers.claude-local
patch_openclaw_json() {
  local file="$OPENCLAW_JSON"
  if [ ! -f "$file" ]; then
    echo "Skipping openclaw.json patch: file not found at $file"
    return
  fi
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$file', 'utf8'));

    // Ensure models.providers.claude-local exists with correct models
    if (!data.models) data.models = {};
    if (!data.models.providers) data.models.providers = {};
    data.models.providers['claude-local'] = {
      baseUrl: 'http://127.0.0.1:18791/v1',
      apiKey: 'dummy',
      api: 'anthropic-messages',
      models: [
        { id: 'ccli-sonnet', name: 'Claude Sonnet (CLI Bridge)', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 },
        { id: 'ccli-opus', name: 'Claude Opus (CLI Bridge)', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 },
        { id: 'ccli-haiku', name: 'Claude Haiku (CLI Bridge)', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }
      ]
    };

    // Ensure agents.defaults.models includes our models
    if (!data.agents) data.agents = {};
    if (!data.agents.defaults) data.agents.defaults = {};
    if (!data.agents.defaults.models) data.agents.defaults.models = {};
    data.agents.defaults.models['claude-local/ccli-sonnet'] = {};
    data.agents.defaults.models['claude-local/ccli-opus'] = {};
    data.agents.defaults.models['claude-local/ccli-haiku'] = {};

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
  echo "To configure manually, see claude-openclaw-config-snippet.json"
fi
