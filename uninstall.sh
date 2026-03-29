#!/usr/bin/env bash
# uninstall.sh — Remove gemini-bridge service and files

set -e

systemctl --user stop gemini-bridge.service 2>/dev/null || true
systemctl --user disable gemini-bridge.service 2>/dev/null || true
systemctl --user daemon-reload

rm -f "$HOME/.local/bin/gemini-bridge.mjs"
rm -f "$HOME/.config/systemd/user/gemini-bridge.service"

echo "Uninstalled gemini-bridge."
