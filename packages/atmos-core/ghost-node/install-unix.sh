#!/usr/bin/env bash
# Atmosphere Ghost Node — UNIX Installer (macOS / Linux)
# ------------------------------------------------------
# Production install: copies the node to a stable local folder (so the USB can be removed),
# registers a private "secret command", and (unless --no-autostart) sets it to auto-start on
# every login so the machine permanently rejoins the mesh — systemd --user on Linux, launchd
# LaunchAgent on macOS.
#
# The node joins the fleet's PRIVATE topic over the public Hyperswarm DHT via NAT hole-punch
# (no inbound port) and runs a skill ONLY if its ML-DSA-65 + Ed25519 seal verifies against the
# pinned origin key in config.json. Each bundle targets ONE OS — this refuses the wrong one.
#
# Usage (run with bash; unzip drops the execute bit):
#   bash install-unix.sh                 # command name 'atmos', + auto-start
#   bash install-unix.sh myname          # custom private command name
#   bash install-unix.sh myname --no-autostart
set -euo pipefail

NAME="atmos"; AUTOSTART=1
for a in "$@"; do case "$a" in --no-autostart) AUTOSTART=0;; --*) ;; *) NAME="$a";; esac; done

SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TARGET_OS="__TARGET_OS__"
case "$(uname -s)" in Darwin) host=macos;; Linux) host=linux;; *) host=other;; esac
if [ "$host" != "$TARGET_OS" ]; then
  echo "✗  This is the ${TARGET_OS} installer but you're on '$(uname -s)'. Use the matching download."; exit 1
fi

INSTALL_DIR="$HOME/.atmosphere-ghost"
NODE_BIN="$INSTALL_DIR/node"; ENTRY="$INSTALL_DIR/atmos-ghost.mjs"
echo "👻 Atmosphere Ghost Node — ${TARGET_OS} (production install)"
[ -f "$SRC/node" ] || { echo "✗  bundled node runtime missing — re-extract the archive."; exit 1; }

# 1. Copy to a stable local dir (USB removable afterwards).
mkdir -p "$INSTALL_DIR"
( cd "$SRC" && tar --exclude=install-unix.sh --exclude=install-windows.ps1 -cf - . ) | ( cd "$INSTALL_DIR" && tar -xf - )
chmod +x "$NODE_BIN" 2>/dev/null || true
echo "   installed to : $INSTALL_DIR"

# 2. Register the private secret command.
if [ "$TARGET_OS" = macos ]; then RC="$HOME/.zshrc"; else RC="$HOME/.bashrc"; fi
touch "$RC"
M="# >>> atmosphere-ghost (${NAME}) >>>"; E="# <<< atmosphere-ghost (${NAME}) <<<"
if grep -qF "$M" "$RC"; then t="$(mktemp)"; awk -v m="$M" -v e="$E" '$0==m{s=1} !s{print} $0==e{s=0}' "$RC" > "$t" && mv "$t" "$RC"; fi
printf '%s\n%s() { "%s" "%s" "$@"; }\n%s\n' "$M" "$NAME" "$NODE_BIN" "$ENTRY" "$E" >> "$RC"
echo "   secret command: $NAME"

# 3. Auto-start on login (daemon mode — stays connected).
if [ "$AUTOSTART" = 1 ]; then
  if [ "$TARGET_OS" = linux ]; then
    UD="$HOME/.config/systemd/user"; mkdir -p "$UD"
    cat > "$UD/atmosphere-ghost.service" <<EOF
[Unit]
Description=Atmosphere Ghost Node
After=network-online.target
[Service]
ExecStart=$NODE_BIN $ENTRY
Restart=always
RestartSec=15
[Install]
WantedBy=default.target
EOF
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload 2>/dev/null || true
      systemctl --user enable --now atmosphere-ghost.service 2>/dev/null \
        && echo "   auto-start    : enabled (systemd --user; 'loginctl enable-linger \$USER' to run while logged out)" \
        || echo "   auto-start    : unit written; enable with 'systemctl --user enable --now atmosphere-ghost'"
    else echo "   auto-start    : unit written (systemd not available in this shell)"; fi
  else
    PL="$HOME/Library/LaunchAgents/com.atmosphere.ghost.plist"; mkdir -p "$(dirname "$PL")"
    cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.atmosphere.ghost</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$ENTRY</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
    launchctl unload "$PL" 2>/dev/null || true
    launchctl load "$PL" 2>/dev/null && echo "   auto-start    : enabled (launchd LaunchAgent)" || echo "   auto-start    : plist written ($PL)"
  fi
else echo "   auto-start    : skipped (--no-autostart)"; fi

echo ""
echo "✅ Done. This machine is a permanent Atmosphere mesh node."
echo "   Verify once now (new terminal):  $NAME --once"
