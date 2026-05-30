#!/usr/bin/env bash
# Reusable silent secret-entry for the Atmos vault. Contains NO secrets.
# Usage:  bash vault-set.sh KEY_NAME      (or run with no arg and it asks)
# Input is hidden; the value is never echoed, never logged, never an argument.
set -euo pipefail

VAULT_DIR="$HOME/atmosphere-core/.secrets-vault"
VAULT="$VAULT_DIR/env_blueprint.md"
mkdir -p "$VAULT_DIR"; umask 177

KEY="${1:-}"
[[ -z "$KEY" ]] && read -rp "Secret name (UPPER_SNAKE_CASE, e.g. GITHUB_PAT): " KEY
if ! [[ "$KEY" =~ ^[A-Z][A-Z0-9_]*$ ]]; then echo "❌ Name must be UPPER_SNAKE_CASE."; exit 1; fi

# Loud guard rail for the Cloudflare Global API Key (full-account master credential).
if [[ "$KEY" == *GLOBAL* ]]; then
  echo "⚠️  '$KEY' looks like a Cloudflare GLOBAL key = full account master access."
  echo "    Strongly prefer a SCOPED API token instead. Storing a global key is high-risk."
  read -rp "    Store it anyway? [y/N] " ok; [[ "${ok:-N}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

read -rsp "Paste value for ${KEY} (hidden): " VAL; echo
[[ -z "$VAL" ]] && { echo "❌ Empty. Aborted."; exit 1; }

# Ensure the vault has a table header.
if [[ ! -f "$VAULT" ]]; then
  printf '# Efficient Labs — Sovereign Secrets Vault (local-only; .gitignored)\n\n| Variable | Value | Purpose |\n| :--- | :--- | :--- |\n' > "$VAULT"
fi

# Drop any existing row for this exact key, then append the fresh one.
grep -vF "\`${KEY}\`" "$VAULT" > "$VAULT.tmp" 2>/dev/null || cp "$VAULT" "$VAULT.tmp"
printf '| `%s` | %s | set %s |\n' "$KEY" "$VAL" "$(date -u +%F)" >> "$VAULT.tmp"
mv "$VAULT.tmp" "$VAULT"
chmod 600 "$VAULT"
unset VAL
echo "✅ ${KEY} stored in vault (perms 600). Value never printed. Keys now in vault:"
grep -oE '`[A-Z0-9_]+`' "$VAULT" | tr -d '`' | sort -u | sed 's/^/   - /'
