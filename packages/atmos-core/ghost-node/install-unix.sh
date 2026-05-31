#!/usr/bin/env bash
# Atmosphere Ghost Node — UNIX Installer (macOS / Linux)
# ------------------------------------------------------
# Joins the sovereign Atmosphere mesh over the public Hyperswarm DHT via NAT hole-punching:
# NO inbound port opened, NO public internet surface. Runs a compute skill ONLY if its
# post-quantum seal (ML-DSA-65 + Ed25519) verifies against the pinned origin key in config.json.
#
# Each bundle is built for ONE OS (separate macOS and Linux downloads) — this script refuses
# to run on the wrong one. It registers a private "secret command" to connect anytime.
#
# Usage (from this folder):   ./install-unix.sh            # default command name: atmos
#                             ./install-unix.sh myhandle   # custom private command name
set -euo pipefail

NAME="${1:-atmos}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TARGET_OS="__TARGET_OS__"   # baked at build time: 'macos' or 'linux'
NODE_BIN="$HERE/node"
ENTRY="$HERE/atmos-ghost.mjs"

uname_s="$(uname -s)"
case "$uname_s" in
  Darwin) host_os="macos" ;;
  Linux)  host_os="linux" ;;
  *)      host_os="other" ;;
esac
if [ "$host_os" != "$TARGET_OS" ]; then
  echo "✗  This is the ${TARGET_OS} installer but you're on '${uname_s}'."
  echo "   Use the matching download (separate Windows / macOS / Linux installers exist)."
  exit 1
fi
[ -f "$NODE_BIN" ] || { echo "✗  bundled node runtime missing — re-extract the full archive."; exit 1; }
chmod +x "$NODE_BIN" 2>/dev/null || true

echo "👻 Atmosphere Ghost Node — ${TARGET_OS}"
echo "   install dir : $HERE"
echo "   runtime     : bundled node (no system Node required)"

# Pick the login shell rc file.
if [ "$TARGET_OS" = "macos" ]; then RC="$HOME/.zshrc"; else RC="$HOME/.bashrc"; fi
touch "$RC"

MARKER="# >>> atmosphere-ghost (${NAME}) >>>"
ENDMARK="# <<< atmosphere-ghost (${NAME}) <<<"
# Remove any prior block for this name, then append a fresh one.
if grep -qF "$MARKER" "$RC"; then
  tmp="$(mktemp)"; awk -v m="$MARKER" -v e="$ENDMARK" '
    $0==m{skip=1} !skip{print} $0==e{skip=0}' "$RC" > "$tmp" && mv "$tmp" "$RC"
fi
{
  echo "$MARKER"
  echo "${NAME}() { \"$NODE_BIN\" \"$ENTRY\" \"\$@\"; }"
  echo "$ENDMARK"
} >> "$RC"

echo ""
echo "✅ Installed. Your private command is:  ${NAME}"
echo "   Open a NEW terminal (or: source $RC), then run:"
echo "       ${NAME}            # join the mesh and stand by for verified skills"
echo "       ${NAME} --once     # run one verified skill and exit (proof mode)"
echo ""
echo "   (Running once right now to verify:)"
"$NODE_BIN" "$ENTRY" --once || true
