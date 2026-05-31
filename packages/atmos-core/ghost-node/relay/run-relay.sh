#!/usr/bin/env bash
# Atmosphere KEYLESS RELAY — backup mesh coordinator (no private key on this host)
cd "$(dirname "$0")"
chmod +x ./node 2>/dev/null || true
exec ./node packages/atmos-core/mesh-demo.mjs broadcast --topic-file mesh-topic.txt --signed-skill signed-skill.wasm --relay-id "$(hostname)" --job-interval 15 --job-max 40
