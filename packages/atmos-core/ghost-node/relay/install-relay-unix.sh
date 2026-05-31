#!/usr/bin/env bash
# Atmosphere KEYLESS RELAY — UNIX Installer (macOS / Linux)
# Makes this machine a BACKUP MESH COORDINATOR (holds NO private key). Self-installs locally +
# auto-starts on login (systemd --user on Linux, launchd on macOS).
# Usage:  bash install-relay-unix.sh [--no-autostart]
set -euo pipefail
AUTOSTART=1; for a in "$@"; do [ "$a" = "--no-autostart" ] && AUTOSTART=0; done
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TARGET_OS="__TARGET_OS__"
case "$(uname -s)" in Darwin) host=macos;; Linux) host=linux;; *) host=other;; esac
[ "$host" = "$TARGET_OS" ] || { echo "✗ This is the ${TARGET_OS} relay installer but you're on '$(uname -s)'."; exit 1; }

DIR="$HOME/.atmosphere-relay"; NODE_BIN="$DIR/node"; ENTRY="$DIR/packages/atmos-core/mesh-demo.mjs"
echo "🛰️  Atmosphere Keyless Relay — ${TARGET_OS} (backup coordinator)"
[ -f "$SRC/node" ] || { echo "✗ bundled node runtime missing."; exit 1; }
mkdir -p "$DIR"
( cd "$SRC" && tar --exclude=install-relay-unix.sh --exclude=install-relay-windows.ps1 -cf - . ) | ( cd "$DIR" && tar -xf - )
chmod +x "$NODE_BIN" 2>/dev/null || true
echo "   installed to : $DIR"
RID="$(hostname | tr -cd '[:alnum:]-' | cut -c1-32)"
RUN=( "$NODE_BIN" "$ENTRY" broadcast --topic-file "$DIR/mesh-topic.txt" --signed-skill "$DIR/signed-skill.wasm" --relay-id "$RID" --job-interval 15 --job-max 40 )

if [ "$AUTOSTART" = 1 ]; then
  if [ "$TARGET_OS" = linux ]; then
    UD="$HOME/.config/systemd/user"; mkdir -p "$UD"
    cat > "$UD/atmosphere-relay.service" <<EOF
[Unit]
Description=Atmosphere Keyless Relay
After=network-online.target
[Service]
ExecStart=${RUN[*]}
Restart=always
RestartSec=15
[Install]
WantedBy=default.target
EOF
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload 2>/dev/null || true
      systemctl --user enable --now atmosphere-relay.service 2>/dev/null \
        && echo "   auto-start    : enabled (systemd --user; 'loginctl enable-linger \$USER' to run while logged out)" \
        || echo "   auto-start    : unit written; 'systemctl --user enable --now atmosphere-relay'"
    else echo "   auto-start    : unit written (systemd not in this shell)"; fi
  else
    PL="$HOME/Library/LaunchAgents/com.atmosphere.relay.plist"; mkdir -p "$(dirname "$PL")"
    { echo '<?xml version="1.0" encoding="UTF-8"?>'
      echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
      echo '<plist version="1.0"><dict><key>Label</key><string>com.atmosphere.relay</string>'
      echo '<key>ProgramArguments</key><array>'
      for a in "${RUN[@]}"; do echo "<string>$a</string>"; done
      echo '</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>'
    } > "$PL"
    launchctl unload "$PL" 2>/dev/null || true
    launchctl load "$PL" 2>/dev/null && echo "   auto-start    : enabled (launchd)" || echo "   auto-start    : plist written ($PL)"
  fi
else echo "   auto-start    : skipped"; fi
echo ""
echo "✅ This machine is now a backup Atmosphere mesh coordinator (relay-id: $RID)."
echo "   Run manually: bash run-relay.sh"
