#!/usr/bin/env bash
# Install tuya-manager: build the server, run it as a background user service,
# and install + enable the GNOME Quick Settings toggle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="tuya-led@localhost"
SERVICE="tuya-manager.service"
PORT="${PORT:-9751}"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
UNIT_DIR="$HOME/.config/systemd/user"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need node
need pnpm
need glib-compile-schemas

echo "==> building server ($ROOT)"
pnpm --dir "$ROOT" install
pnpm --dir "$ROOT" build

echo "==> installing systemd user service ($SERVICE, PORT=$PORT)"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$SERVICE" <<EOF
[Unit]
Description=Tuya LAN dashboard (tuya-manager)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PORT=$PORT
ExecStart=$(command -v node) $ROOT/dist/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE"
systemctl --user --no-pager status "$SERVICE" | head -8

echo "==> installing GNOME extension ($UUID)"
mkdir -p "$EXT_DIR"
cp "$ROOT/gnome-extension/metadata.json" "$ROOT/gnome-extension/extension.js" "$ROOT/gnome-extension/prefs.js" "$EXT_DIR/"
mkdir -p "$EXT_DIR/schemas"
cp "$ROOT/gnome-extension/schemas/"*.gschema.xml "$EXT_DIR/schemas/"
glib-compile-schemas "$EXT_DIR/schemas"

if command -v gnome-extensions >/dev/null 2>&1; then
  gnome-extensions enable "$UUID" || true
else
  echo "gnome-extensions CLI not found; enable '$UUID' in Extension Manager" >&2
fi

echo
echo "done. dashboard: http://localhost:$PORT"
echo "If the LED toggle does not appear yet, re-login (Wayland) or restart GNOME Shell (X11: Alt+F2, r)."
