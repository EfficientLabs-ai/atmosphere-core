#!/usr/bin/env bash
# Atmosphere Ghost Node — macOS/Linux launcher
cd "$(dirname "$0")"
chmod +x ./node 2>/dev/null || true
./node ./atmos-ghost.mjs "$@"
