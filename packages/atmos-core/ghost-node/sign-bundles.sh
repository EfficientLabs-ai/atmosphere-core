#!/usr/bin/env bash
# Env-gated code-signing for the ghost-node bundles (#4). No-op unless certs are configured.
# Called by build.sh after the bundles are assembled. See SIGNING.md for cert acquisition.
#   $1 = OUT dir containing atmosphere-ghost-*.zip and atmosphere-ghost-*/ folders
set -uo pipefail
OUT="${1:-dist}"
signed=0

# --- Windows Authenticode (cross-sign from Linux via osslsigncode) ---
if [ -n "${WIN_PFX:-}" ] && [ -f "${WIN_PFX:-}" ] && command -v osslsigncode >/dev/null 2>&1; then
  for d in "$OUT"/atmosphere-ghost-windows-*; do
    [ -d "$d" ] || continue
    osslsigncode sign -pkcs12 "$WIN_PFX" -pass "${WIN_PFX_PASS:-}" \
      -n "Atmosphere Ghost Node" -i "https://efficientlabs.ai" -t "http://timestamp.digicert.com" \
      -in "$d/install-windows.ps1" -out "$d/install-windows.ps1.signed" 2>/dev/null \
      && mv "$d/install-windows.ps1.signed" "$d/install-windows.ps1" && { echo "  ✍️  signed $(basename "$d") installer"; signed=1; }
  done
else
  [ -n "${WIN_PFX:-}" ] && echo "  (WIN_PFX set but osslsigncode missing — install it to sign Windows)"
fi

# --- macOS: must run on a Mac (codesign/notarytool unavailable on Linux) ---
if [ -n "${APPLE_DEVELOPER_ID:-}" ]; then
  if command -v codesign >/dev/null 2>&1; then echo "  (macOS signing: package an .app then codesign+notarize — see SIGNING.md)";
  else echo "  (APPLE_DEVELOPER_ID set but codesign unavailable — run macOS signing on a Mac)"; fi
fi

# --- Linux integrity (detached GPG signature over each zip) ---
if [ -n "${GPG_SIGNING_KEY:-}" ] && command -v gpg >/dev/null 2>&1; then
  for z in "$OUT"/atmosphere-ghost-*.zip; do
    gpg --batch --yes --local-user "$GPG_SIGNING_KEY" --armor --detach-sign "$z" 2>/dev/null \
      && { echo "  ✍️  gpg-signed $(basename "$z")"; signed=1; }
  done
fi

[ "$signed" = 0 ] && echo "  (code-signing skipped — no certs configured; see SIGNING.md)"
exit 0
