#!/usr/bin/env bash
# claude-uninstall.sh — Remove claude-bridge service, files, and OpenClaw config patches

set -e

systemctl --user stop claude-bridge.service 2>/dev/null || true
systemctl --user disable claude-bridge.service 2>/dev/null || true
systemctl --user daemon-reload

rm -f "$HOME/.local/bin/claude-bridge.mjs"
rm -f "$HOME/.config/systemd/user/claude-bridge.service"

echo "Uninstalled claude-bridge."

# --- Remove claude-local from OpenClaw config ---

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
    if (data.providers && data.providers['claude-local']) {
      delete data.providers['claude-local'];
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
    if (data.models?.providers?.['claude-local']) {
      delete data.models.providers['claude-local'];
      changed = true;
    }
    if (data.agents?.defaults?.models) {
      for (const key of Object.keys(data.agents.defaults.models)) {
        if (key.startsWith('claude-local/')) {
          delete data.agents.defaults.models[key];
          changed = true;
        }
      }
    }
    if (data.agents?.defaults?.model?.fallbacks) {
      const before = data.agents.defaults.model.fallbacks.length;
      data.agents.defaults.model.fallbacks = data.agents.defaults.model.fallbacks.filter(f => !f.startsWith('claude-local/'));
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

# --- Remove bridge entries from Hermes config ---

HERMES_CONFIG="$HOME/.hermes/config.yaml"
if [ -f "$HERMES_CONFIG" ] && python3 -c "import yaml" 2>/dev/null; then
  HERMES_CONFIG="$HERMES_CONFIG" python3 <<'PYEOF'
import os
import yaml

path = os.environ['HERMES_CONFIG']
with open(path) as f:
    data = yaml.safe_load(f) or {}
if not isinstance(data, dict):
    raise SystemExit(0)

managed = {'claude-local', 'ccli-sonnet', 'ccli-opus', 'ccli-haiku'}
providers = data.get('custom_providers')
if isinstance(providers, list):
    new = [p for p in providers if not (isinstance(p, dict) and p.get('name') in managed)]
    if len(new) != len(providers):
        data['custom_providers'] = new
        with open(path, 'w') as f:
            yaml.safe_dump(data, f, sort_keys=False, default_flow_style=False)
        print(f"Cleaned: {path}")
PYEOF
fi
