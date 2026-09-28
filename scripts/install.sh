#!/usr/bin/env bash
# Install tuya-manager: build the server, run it as a background user service,
# and install + enable the GNOME Quick Settings toggle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="tuya-led@localhost"
SERVICE="tuya-manager.service"
OFF_SERVICE="tuya-led-off.service"
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

echo "==> installing shutdown hook ($OFF_SERVICE, turns LED off on shutdown)"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$OFF_SERVICE" <<EOF
[Unit]
Description=Turn off Tuya LED on shutdown
DefaultDependencies=no
After=network-online.target
Wants=network-online.target
Before=shutdown.target reboot.target halt.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$ROOT
ExecStart=/bin/true
ExecStop=$(command -v node) $ROOT/dist/led-off.js
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$OFF_SERVICE"

echo "==> installing GNOME extension ($UUID)"
# Use gnome-extensions pack+install (not raw cp) so the running Shell is
# notified through D-Bus and picks the extension up without relogin.
# New UUIDs are only discovered at Shell startup, so a first-time install on
# Wayland still needs one relogin; afterwards enable/disable is instant.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
if command -v gnome-extensions >/dev/null 2>&1; then
  # pack only bundles stock files, so the custom bulb icon rides along
  # via --extra-source (lands at the bundle root, see ensureIconPath).
  gnome-extensions pack "$ROOT/gnome-extension" \
    --extra-source="$ROOT/gnome-extension/icons/tuya-led-bulb-symbolic.svg" \
    --out-dir="$TMPDIR"
  gnome-extensions install --force "$TMPDIR/$UUID.shell-extension.zip"
  glib-compile-schemas "$EXT_DIR/schemas"
  # Allow user extensions (distros sometimes default this off) so
  # enable actually takes effect in the running session.
  gsettings set org.gnome.shell disable-user-extensions false || true
  # Re-enable to load immediately when the Shell already knows this UUID
  # (re-installs of updated code still need a Shell restart on Wayland /
  # Alt+F2 r on X11 because GJS caches the old module).
  gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
  sleep 1
  if gnome-extensions enable "$UUID"; then
    sleep 2
    gnome-extensions info "$UUID" || true
    # The running Shell caches code+metadata at login, so after a code update
    # it may still report the previous version until restart. Compare versions
    # to avoid failing on a stale cached error for code that is fixed on disk.
    REPO_VER="$(python3 -c "import json;print(json.load(open('$ROOT/gnome-extension/metadata.json'))['version'])" 2>/dev/null || echo ?)"

    SHELL_VER="$(gnome-extensions info "$UUID" 2>/dev/null | grep -oiP 'Version:\s*\K[0-9]+' | head -1 || echo ?)"
    if [ "$SHELL_VER" != "$REPO_VER" ]; then
      echo "NOTE: Shell still sees version $SHELL_VER (disk has $REPO_VER) — it caches"
      echo "code until restart, so its error below (if any) is from the OLD code:"
      gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Extensions.GetExtensionErrors "$UUID" 2>/dev/null || true
      echo "Re-login once (Wayland) or restart GNOME Shell (X11: Alt+F2, r)"
      echo "to load the fixed version — the toggle should then appear."
    elif gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Extensions.GetExtensionErrors "$UUID" 2>/dev/null \
        | grep -q -v "(@as \[\],)"; then
      echo "ERROR: extension installed but failed to load:" >&2
      gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Extensions.GetExtensionErrors "$UUID" >&2 || true
      echo "If this persists after a relogin, check 'journalctl -b -o cat | grep $UUID'." >&2
      exit 1
    fi
    if gnome-extensions info "$UUID" 2>/dev/null | grep -qi "State:.*ACTIVE\|State:.*ENABLED"; then
      echo "extension active now — open Quick Settings to see the LED toggle."
    elif gnome-extensions info "$UUID" 2>/dev/null | grep -qi "Enabled:.*Yes"; then
      echo "extension enabled. If the LED toggle is not in Quick Settings yet,"
      echo "re-login once (Wayland) or restart GNOME Shell (X11: Alt+F2, r) —"
      echo "further reinstalls then apply without relogin."
    else
      echo "extension installed but not yet enabled; enable '$UUID' in Extension Manager," >&2
      echo "then re-login once (Wayland) or restart GNOME Shell (X11: Alt+F2, r)." >&2
    fi
  else
    echo "NOTE: Shell does not know '$UUID' yet (fresh install)." >&2
    echo "Re-login once (Wayland) or restart GNOME Shell (X11: Alt+F2, r)," >&2
    echo "then run: gnome-extensions enable $UUID" >&2
  fi
else
  echo "gnome-extensions CLI not found; copy gnome-extension/ to $EXT_DIR manually" >&2
  echo "and enable '$UUID' in Extension Manager" >&2
fi
trap - EXIT
rm -rf "$TMPDIR"

echo
echo "done. dashboard: http://localhost:$PORT"
