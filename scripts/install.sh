#!/bin/sh
# ==============================================================================
# Efficient Labs — StratosAgent installer.
#
# Design: docs/designs/distribution-and-cli.md (Codex CRITICAL #1). This script is FAIL-CLOSED and
# does NOTHING privileged:
#   - NO sudo, ever.            - NO silent global installs.     - NO third-party `curl | sh` stages.
#   - NO auto-started services. - Installs a PINNED version.     - Daemon setup is a separate,
#     explicit step (`stratos service install`).
# Missing prerequisites are reported with instructions; we never install them for you.
# ==============================================================================
set -eu

PKG="@efficientlabs/stratos"
VERSION="${STRATOS_VERSION:-1.0.0}"          # pinned; override deliberately via STRATOS_VERSION
EXPECTED_SHA256="${STRATOS_SHA256:-}"        # optional: verify the published tarball checksum

say() { printf '%s\n' "$*"; }
err() { printf 'ERROR: %s\n' "$*" >&2; }

say "Efficient Labs — StratosAgent installer"
say "  Target: ${PKG}@${VERSION}  (user-space, no sudo, nothing auto-started)"
say "  Host:   $(uname -s 2>/dev/null || echo unknown)/$(uname -m 2>/dev/null || echo unknown)"
say ""

# 1. Prerequisites — instruct, never auto-install ------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  err "Node.js >= 18 is required and was not found."
  say "  Install Node 18+ from https://nodejs.org (or your package manager), then re-run."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 18 ] 2>/dev/null; then
  err "Node.js >= 18 required (found $(node -v 2>/dev/null))."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  err "npm is required (it ships with Node.js). Install Node 18+ and re-run."
  exit 1
fi

# 2. User-space global prefix — never sudo -------------------------------------------------------
PREFIX="$(npm config get prefix 2>/dev/null || echo '')"
if [ -n "${PREFIX}" ] && [ -e "${PREFIX}" ] && [ ! -w "${PREFIX}" ]; then
  err "npm global prefix '${PREFIX}' is not writable by your user."
  say "  Install WITHOUT sudo by pointing npm at a user-owned prefix:"
  say "    npm config set prefix \"\$HOME/.npm-global\""
  say "    export PATH=\"\$HOME/.npm-global/bin:\$PATH\"   # add this to your shell profile"
  say "  Then re-run this installer. We never use sudo."
  exit 1
fi

# 3. Optional integrity pin — verify the published tarball checksum before installing -------------
if [ -n "${EXPECTED_SHA256}" ]; then
  say "Verifying published tarball checksum…"
  TARBALL="$(npm pack "${PKG}@${VERSION}" --silent 2>/dev/null || echo '')"
  if [ -z "${TARBALL}" ] || [ ! -f "${TARBALL}" ]; then err "could not fetch ${PKG}@${VERSION} to verify."; exit 1; fi
  if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "${TARBALL}" | awk '{print $1}')";
  else GOT="$(shasum -a 256 "${TARBALL}" | awk '{print $1}')"; fi
  rm -f "${TARBALL}"
  if [ "${GOT}" != "${EXPECTED_SHA256}" ]; then
    err "checksum mismatch — refusing to install."
    say "  expected: ${EXPECTED_SHA256}"
    say "  got:      ${GOT}"
    exit 1
  fi
  say "  checksum verified."
fi

# 4. Install the pinned version (user-space global) ----------------------------------------------
say "Installing ${PKG}@${VERSION}…"
npm install -g "${PKG}@${VERSION}"

# 5. Read-only preflight (non-fatal: a missing local Ollama is expected on a fresh machine) -------
say ""
say "Read-only preflight:"
stratos doctor || true

# 6. Next steps — nothing privileged, nothing started automatically ------------------------------
say ""
say "Installed. Next:"
say "  stratos init               name your agent + pick a model (local-only setup)"
say "  stratos start              run locally on 127.0.0.1 (foreground; Ctrl-C to stop)"
say "  stratos service install    OPTIONAL: a background user service (no root, you run the command)"
