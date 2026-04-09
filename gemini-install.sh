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

# Fetch the live model list from the running bridge.
# Returns a JSON array of OpenClaw model entries, or an empty array on failure.
fetch_bridge_models() {
  curl -sf --max-time 5 "http://127.0.0.1:18790/v1beta/models" 2>/dev/null | node -e "
    const chunks = [];
    process.stdin.on('data', d => chunks.push(d));
    process.stdin.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const models = (body.models || []).map(m => ({
          id: m.name.replace('models/', ''),
          name: m.displayName || m.name.replace('models/', ''),
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.inputTokenLimit || 1048576,
          maxTokens: m.outputTokenLimit || 8192,
        }));
        if (models.length > 0) { process.stdout.write(JSON.stringify(models)); return; }
      } catch {}
      process.stdout.write('[]');
    });
  " 2>/dev/null
}

# Patch a per-agent models.json file: add/replace the gemini-local provider.
patch_models_json() {
  local file="$1"
  local models_json="$2"
  if [ ! -f "$file" ]; then return; fi
  MODELS_JSON="$models_json" node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$file', 'utf8'));
    if (!data.providers) data.providers = {};
    const models = JSON.parse(process.env.MODELS_JSON || '[]');
    data.providers['gemini-local'] = {
      baseUrl: 'http://127.0.0.1:18790/v1beta',
      apiKey: 'dummy',
      api: 'google-generative-ai',
      models,
    };
    fs.writeFileSync('$file', JSON.stringify(data, null, 2) + '\n');
    console.log('Patched: $file');
  "
}

# Patch openclaw.json: add/replace models.providers.gemini-local and agents.defaults.models.
patch_openclaw_json() {
  local file="$OPENCLAW_JSON"
  local models_json="$1"
  if [ ! -f "$file" ]; then
    echo "Skipping openclaw.json patch: file not found at $file"
    return
  fi
  MODELS_JSON="$models_json" node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$file', 'utf8'));
    const models = JSON.parse(process.env.MODELS_JSON || '[]');

    if (!data.models) data.models = {};
    if (!data.models.providers) data.models.providers = {};
    data.models.providers['gemini-local'] = {
      baseUrl: 'http://127.0.0.1:18790/v1beta',
      apiKey: 'dummy',
      api: 'google-generative-ai',
      models,
    };

    // Register each model in agents.defaults.models so it appears in the selector
    if (!data.agents) data.agents = {};
    if (!data.agents.defaults) data.agents.defaults = {};
    if (!data.agents.defaults.models) data.agents.defaults.models = {};
    for (const m of models) {
      data.agents.defaults.models['gemini-local/' + m.id] = {};
    }

    fs.writeFileSync('$file', JSON.stringify(data, null, 2) + '\n');
    console.log('Patched: ' + '$file' + ' (' + models.length + ' models: ' + models.map(m => m.id).join(', ') + ')');
  "
}

if [ -d "$OPENCLAW_DIR" ]; then
  echo ""
  echo "Patching OpenClaw configuration..."

  # Fetch live model list from the bridge (falls back to [] if bridge not reachable)
  BRIDGE_MODELS=$(fetch_bridge_models)
  if [ "$BRIDGE_MODELS" = "[]" ] || [ -z "$BRIDGE_MODELS" ]; then
    echo "Warning: could not fetch model list from bridge — using hardcoded fallback"
    BRIDGE_MODELS='[{"id":"gcli-3-flash","name":"Gemini 3 Flash (CLI)","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":1048576,"maxTokens":8192},{"id":"gcli-3.1-pro","name":"Gemini 3.1 Pro (CLI)","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":1048576,"maxTokens":8192}]'
  else
    echo "Fetched models from bridge: $(echo "$BRIDGE_MODELS" | node -e "const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(m.map(x=>x.id).join(', '))")"
  fi

  patch_openclaw_json "$BRIDGE_MODELS"

  # Patch all per-agent models.json files
  for models_json in "$OPENCLAW_DIR"/agents/*/agent/models.json; do
    patch_models_json "$models_json" "$BRIDGE_MODELS"
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
