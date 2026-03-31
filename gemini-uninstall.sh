#!/usr/bin/env bash
# uninstall.sh — Remove gemini-bridge service, files, and OpenClaw config patches

set -e

systemctl --user stop gemini-bridge.service 2>/dev/null || true
systemctl --user disable gemini-bridge.service 2>/dev/null || true
systemctl --user daemon-reload

rm -f "$HOME/.local/bin/gemini-bridge.mjs"
rm -f "$HOME/.config/systemd/user/gemini-bridge.service"

echo "Uninstalled gemini-bridge."

# --- Remove gemini-local from OpenClaw config ---

OPENCLAW_DIR="$HOME/.openclaw"
OPENCLAW_JSON="$OPENCLAW_DIR/openclaw.json"

NODE_BIN=$(which node 2>/dev/null || echo "")
if [ -z "$NODE_BIN" ]; then
  echo "Note: node not found, skipping OpenClaw config cleanup."
  exit 0
fi

remove_from_models_json() {
  local file="$1"
  if [ ! -f "$file" ]; then return; fi
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$file', 'utf8'));
    if (data.providers && data.providers['gemini-local']) {
      delete data.providers['gemini-local'];
      fs.writeFileSync('$file', JSON.stringify(data, null, 2) + '\n');
      console.log('Cleaned: $file');
    }
  "
}

remove_from_openclaw_json() {
  local file="$OPENCLAW_JSON"
  if [ ! -f "$file" ]; then return; fi
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$file', 'utf8'));
    let changed = false;
    if (data.models?.providers?.['gemini-local']) {
      delete data.models.providers['gemini-local'];
      changed = true;
    }
    if (data.agents?.defaults?.models) {
      for (const key of Object.keys(data.agents.defaults.models)) {
        if (key.startsWith('gemini-local/')) {
          delete data.agents.defaults.models[key];
          changed = true;
        }
      }
    }
    if (data.agents?.defaults?.model?.fallbacks) {
      const before = data.agents.defaults.model.fallbacks.length;
      data.agents.defaults.model.fallbacks = data.agents.defaults.model.fallbacks.filter(f => !f.startsWith('gemini-local/'));
      if (data.agents.defaults.model.fallbacks.length !== before) changed = true;
    }
    if (changed) {
      fs.writeFileSync('$file', JSON.stringify(data, null, 2) + '\n');
      console.log('Cleaned: $file');
    }
  "
}

if [ -d "$OPENCLAW_DIR" ]; then
  remove_from_openclaw_json
  for models_json in "$OPENCLAW_DIR"/agents/*/agent/models.json; do
    remove_from_models_json "$models_json"
  done
  if systemctl --user is-active --quiet openclaw-gateway 2>/dev/null; then
    systemctl --user restart openclaw-gateway
    echo "Restarted: openclaw-gateway"
  fi
fi
