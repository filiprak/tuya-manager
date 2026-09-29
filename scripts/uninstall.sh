#!/usr/bin/env bash
# Undo scripts/install.sh: stop the background service and remove the extension.
set -euo pipefail

UUID="tuya-led@localhost"
SERVICE="tuya-manager.service"
OFF_SERVICE="tuya-led-off.service"
ON_SERVICE="tuya-led-on.service"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
UNIT="$HOME/.config/systemd/user/$SERVICE"

if command -v gnome-extensions >/dev/null 2>&1; then
  echo "==> disabling GNOME extension ($UUID)"
  gnome-extensions disable "$UUID" || true
  echo "==> uninstalling GNOME extension ($UUID)"
  gnome-extensions uninstall "$UUID" || true
fi
if [ -d "$EXT_DIR" ]; then
  echo "==> removing leftover $EXT_DIR"
  rm -rf "$EXT_DIR"
fi

if [ -f "$UNIT" ]; then
  echo "==> stopping background service ($SERVICE)"
  systemctl --user disable --now "$SERVICE" || true
  rm -f "$UNIT"
  systemctl --user daemon-reload || true
fi

OFF_UNIT="$HOME/.config/systemd/user/$OFF_SERVICE"
if [ -f "$OFF_UNIT" ]; then
  echo "==> removing shutdown hook ($OFF_SERVICE)"
  systemctl --user disable --now "$OFF_SERVICE" || true
  rm -f "$OFF_UNIT"
  systemctl --user daemon-reload || true
fi

ON_UNIT="$HOME/.config/systemd/user/$ON_SERVICE"
if [ -f "$ON_UNIT" ]; then
  echo "==> removing boot hook ($ON_SERVICE)"
  systemctl --user disable --now "$ON_SERVICE" || true
  rm -f "$ON_UNIT"
  systemctl --user daemon-reload || true
fi

echo
echo "done. repo data (devices.json cache) was left untouched."
echo "If the LED toggle is still visible, re-login (Wayland) or restart GNOME Shell (X11: Alt+F2, r)."
