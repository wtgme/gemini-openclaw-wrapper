#!/usr/bin/env bash
# install.sh — Install available CLI bridges as systemd user services and configure OpenClaw
# Installs gemini-bridge if `gemini` CLI is found, claude-bridge if `claude` CLI is found.
# Usage: bash install.sh

set -e

INSTALLED=()
SKIPPED=()

# Detect node
NODE_BIN=$(which node 2>/dev/null || echo "")
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH. Install Node.js first (https://nodejs.org or nvm)."
  exit 1
fi

echo "Using node: $NODE_BIN"
echo "Using home: $HOME"
echo ""

# Install gemini-bridge if gemini CLI is available
if which gemini &>/dev/null; then
  echo "=== Installing gemini-bridge ==="
  bash "$(dirname "$0")/gemini-install.sh"
  INSTALLED+=("gemini-bridge")
  echo ""
else
  echo "Skipping gemini-bridge: gemini CLI not found (install it and re-run to add later)."
  SKIPPED+=("gemini-bridge")
  echo ""
fi

# Install claude-bridge if claude CLI is available
if which claude &>/dev/null; then
  echo "=== Installing claude-bridge ==="
  bash "$(dirname "$0")/claude-install.sh"
  INSTALLED+=("claude-bridge")
  echo ""
else
  echo "Skipping claude-bridge: claude CLI not found (install it and re-run to add later)."
  SKIPPED+=("claude-bridge")
  echo ""
fi

# Summary
echo "=============================="
if [ ${#INSTALLED[@]} -gt 0 ]; then
  echo "Installed: ${INSTALLED[*]}"
fi
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "Skipped:   ${SKIPPED[*]}"
fi
if [ ${#INSTALLED[@]} -eq 0 ]; then
  echo "Nothing installed — neither gemini nor claude CLI was found in PATH."
  exit 1
fi
