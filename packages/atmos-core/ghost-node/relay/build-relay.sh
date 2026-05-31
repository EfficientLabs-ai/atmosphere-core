#!/usr/bin/env bash
# Build per-platform Atmosphere KEYLESS RELAY bundles (backup mesh coordinators).
# Reuses the ghost bundle's node_modules + the per-platform Node runtimes. A relay holds NO
# private key: it ships the pre-signed skill artifact + private topic, mirrors the minimal repo
# layout so mesh-demo.mjs runs unmodified, and never loads the heavy compiler (key-holder path).
set -euo pipefail
cd /home/neo/atmos-dist
REPO=/home/neo/atmosphere-core
GMOD=ghost-node/node_modules                      # reuse the ghost dependency closure
ART="$REPO/.stratos-profile/signed-skill.wasm"    # exported by the origin
TOPIC="$REPO/.stratos-profile/mesh-topic.txt"
[ -f "$ART" ] || { echo "✗ signed-skill.wasm not found — run the origin with --export-skill first."; exit 1; }
OUT=relay-dist; rm -rf "$OUT"; mkdir -p "$OUT"

emit() { # plat prebuild runtime_src runtime_name family target_os
  local plat="$1" pb="$2" rt="$3" rn="$4" fam="$5" os="$6"
  local d="$OUT/atmosphere-relay-$plat"
  echo "── relay $plat (prebuild=$pb) ──"
  mkdir -p "$d/packages/atmos-core" "$d/packages/stratos-agent/src/core" "$d/packages/stratos-agent/src/security"
  cp "$REPO/packages/atmos-core/mesh-demo.mjs"                        "$d/packages/atmos-core/"
  cp "$REPO/packages/stratos-agent/src/core/wasm-sections.js"        "$d/packages/stratos-agent/src/core/"
  cp "$REPO/packages/stratos-agent/src/security/quantum-crypto.js"   "$d/packages/stratos-agent/src/security/"
  cp "$ART" "$d/signed-skill.wasm"; cp "$TOPIC" "$d/mesh-topic.txt"
  cp -a "$GMOD" "$d/node_modules"
  find "$d/node_modules" -type d -name prebuilds | while read -r p; do
    find "$p" -mindepth 1 -maxdepth 1 -type d ! -name "$pb" -exec rm -rf {} +; done
  find "$d/node_modules" -type f -name '*.bare' -delete
  cp "$rt" "$d/$rn"; chmod +x "$d/$rn" 2>/dev/null || true
  if [ "$fam" = windows ]; then cp relay-assets/install-relay-windows.ps1 relay-assets/run-relay.cmd "$d/";
  else sed "s/__TARGET_OS__/$os/" relay-assets/install-relay-unix.sh > "$d/install-relay-unix.sh"; cp relay-assets/run-relay.sh "$d/"; fi
  cat > "$d/README.md" <<EOF
# Atmosphere Keyless Relay — ${plat}

Makes this machine a **backup mesh coordinator**. It holds **NO private key** — it re-broadcasts
the pre-signed membership skill (\`signed-skill.wasm\`), onboards nodes, and dispatches jobs only
when it's the elected leader (i.e. when the primary/VPS is down). Losing the primary no longer
kills the mesh. Self-contained Node runtime — nothing to install first.

## Install (self-installs + auto-starts every login)
- Windows: \`powershell -ExecutionPolicy Bypass -File .\\install-relay-windows.ps1\`  (or double-click \`run-relay.cmd\`)
- macOS / Linux: \`bash install-relay-unix.sh\`  (or \`bash run-relay.sh\`)

Run two or more relays on different machines for real redundancy: lowest live relay-id leads,
the rest stand by and take over within ~16s if the leader dies. \`mesh-topic.txt\` (your private
rendezvous) and \`signed-skill.wasm\` are your fleet credentials — keep them private.
EOF
  ( cd "$OUT" && python3 -c "import shutil,sys;shutil.make_archive('atmosphere-relay-'+sys.argv[1],'zip','.', 'atmosphere-relay-'+sys.argv[1])" "$plat" )
  echo "   $(du -h "$OUT/atmosphere-relay-$plat.zip"|cut -f1)"
}
emit windows-x64   win32-x64    node.exe          node.exe windows windows
emit windows-arm64 win32-arm64  node-winarm.exe   node.exe windows windows
emit macos-arm64   darwin-arm64 node-darwin-arm64 node     unix    macos
emit macos-x64     darwin-x64   node-darwin-x64   node     unix    macos
emit linux-x64     linux-x64    node-linux-x64    node     unix    linux
emit linux-arm64   linux-arm64  node-linux-arm64  node     unix    linux
echo "── relay bundles in $OUT ──"; ls -la "$OUT"/*.zip | awk '{print $5,$9}'
