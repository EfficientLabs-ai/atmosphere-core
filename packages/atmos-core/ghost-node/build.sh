#!/usr/bin/env bash
# Build separate, self-contained per-platform Atmosphere Ghost Node bundles.
#
# Each output bundle is built for ONE platform: its own bundled Node runtime + ONLY that
# platform's native prebuilds + a native-syntax installer (PowerShell for Windows, bash for
# macOS/Linux). No system Node is required on the target device.
#
# Prereqs: node + npm + curl + python3 on the BUILD host, run from an exec-allowed FS
# (NOT /tmp — it's often mounted noexec, which blocks loading native .node prebuilds).
#
# Usage:
#   STRATOS_NODE_KEYS=/path/to/.stratos-profile/node-keys.json \
#   NODE_VER=v22.22.3 WORK=/home/neo/atmos-dist \
#   bash build.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_VER="${NODE_VER:-v22.22.3}"
WORK="${WORK:-$HOME/atmos-dist}"
KEYS="${STRATOS_NODE_KEYS:-$HOME/atmosphere-core/.stratos-profile/node-keys.json}"
# Private fleet topic: ATMOS_TOPIC_FILE (a secret string) > ATMOS_TOPIC > public default.
TOPIC_FILE="${ATMOS_TOPIC_FILE:-$(dirname "$KEYS")/mesh-topic.txt}"
TOPIC="${ATMOS_TOPIC:-atmosphere-genesis-mesh-v1}"
[ -f "$TOPIC_FILE" ] && TOPIC="$(tr -d '[:space:]' < "$TOPIC_FILE")"
REPO="$(cd "$HERE/../../.." && pwd)"

mkdir -p "$WORK/src"; cd "$WORK/src"
# 1. code: the standalone joiner + the dependency-free verifier sources (copied from repo).
cp "$HERE/atmos-ghost.mjs" "$HERE/package.json" .
cp "$REPO/packages/stratos-agent/src/core/wasm-sections.js" .
cp "$REPO/packages/stratos-agent/src/security/quantum-crypto.js" .
# 2. dependency closure (pulls hyperdht/udx/sodium with ALL platform prebuilds).
npm install --omit=dev --no-audit --no-fund >/dev/null
# 3. config.json — topic + the PINNED ORIGIN PUBLIC KEY (non-secret) from node-keys.json.
node --input-type=module -e "
import fs from 'node:fs'; import b4a from 'b4a';
const raw = JSON.parse(fs.readFileSync(process.env.KEYS,'utf8'));
const pinnedPubKey = b4a.toString(b4a.from(JSON.stringify(raw.publicKey)),'base64');
fs.writeFileSync('config.json', JSON.stringify({nodeLabel:'atmos-ghost',topic:process.env.TOPIC,defaultInput:9,pinnedPubKey},null,2));
" KEYS="$KEYS" TOPIC="$TOPIC"

# 4. fetch per-platform runtimes.
cd "$WORK"
[ -f node.exe ]          || curl -fsSL "https://nodejs.org/dist/$NODE_VER/win-x64/node.exe" -o node.exe
[ -f node-linux-x64 ]    || { curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" -o l.txz && tar -xf l.txz "node-$NODE_VER-linux-x64/bin/node" && mv "node-$NODE_VER-linux-x64/bin/node" node-linux-x64; }
[ -f node-darwin-arm64 ] || { curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-arm64.tar.gz" -o d.tgz && tar -xf d.tgz "node-$NODE_VER-darwin-arm64/bin/node" && mv "node-$NODE_VER-darwin-arm64/bin/node" node-darwin-arm64; }

OUT="$WORK/dist"; rm -rf "$OUT"; mkdir -p "$OUT"
CODE=(atmos-ghost.mjs wasm-sections.js quantum-crypto.js config.json package.json)
emit() { # plat prebuild runtime_src runtime_name family target_os
  local plat="$1" pb="$2" rt="$3" rn="$4" fam="$5" os="$6" d="$OUT/atmosphere-ghost-$1"
  mkdir -p "$d"; for f in "${CODE[@]}"; do cp "src/$f" "$d/"; done
  cp -a src/node_modules "$d/node_modules"
  find "$d/node_modules" -type d -name prebuilds | while read -r p; do
    find "$p" -mindepth 1 -maxdepth 1 -type d ! -name "$pb" -exec rm -rf {} +; done
  find "$d/node_modules" -type f -name '*.bare' -delete
  cp "$rt" "$d/$rn"; chmod +x "$d/$rn" 2>/dev/null || true
  if [ "$fam" = windows ]; then cp "$HERE/install-windows.ps1" "$HERE/atmos-ghost.cmd" "$d/";
  else sed "s/__TARGET_OS__/$os/" "$HERE/install-unix.sh" > "$d/install-unix.sh"; cp "$HERE/atmos-ghost.sh" "$d/"; fi
  ( cd "$OUT" && python3 -c "import shutil,sys;shutil.make_archive('atmosphere-ghost-'+sys.argv[1],'zip','.', 'atmosphere-ghost-'+sys.argv[1])" "$plat" )
  echo "  built $plat -> $(du -h "$OUT/atmosphere-ghost-$plat.zip"|cut -f1)"
}
emit windows-x64 win32-x64    node.exe          node.exe windows windows
emit macos-arm64 darwin-arm64 node-darwin-arm64 node     unix    macos
emit linux-x64   linux-x64    node-linux-x64    node     unix    linux
echo "Bundles in $OUT"
