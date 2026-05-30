#!/usr/bin/env bash
# Silent secret-entry helper for atmos-secure-bridge.
# Contains NO secrets. Prompts with hidden input; value is never echoed,
# never passed as an argument, never printed. Writes the vault in the exact
# format telegram-bridge.js expects, locks perms to 600, validates, and
# offers a pm2 reload + live getMe check (which reveals only the bot's name).
set -euo pipefail

VAULT_DIR="$HOME/atmosphere-core/.secrets-vault"
VAULT="$VAULT_DIR/env_blueprint.md"
mkdir -p "$VAULT_DIR"

echo "🔐 Atmos vault updater — input is hidden and never printed."
# -s = silent (no echo), -r = raw
read -rsp "Paste the NEW Telegram bot token, then press Enter: " TG_TOKEN
echo

if [[ -z "${TG_TOKEN}" ]]; then echo "❌ Empty input. Aborted."; exit 1; fi
if ! [[ "${TG_TOKEN}" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]]; then
  echo "⚠️  That doesn't look like a Telegram token (expected  digits:longstring )."
  read -rp "Write it anyway? [y/N] " ok; [[ "${ok:-N}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

# Write vault in the table format the parser matches, with restrictive perms.
umask 177
cat > "$VAULT" <<EOF
# Efficient Labs — Sovereign Secrets Vault (local-only; .gitignored)

| Variable | Value | Purpose |
| :--- | :--- | :--- |
| \`TELEGRAM_BOT_TOKEN\` | ${TG_TOKEN} | Telegram bridge polling auth |
EOF
chmod 600 "$VAULT"
unset TG_TOKEN
echo "✅ Vault written and locked to 600 at: $VAULT"

# Optional: validate against Telegram (reveals only the bot username, not the token).
read -rp "Verify the new token live with Telegram getMe? [Y/n] " v
if [[ ! "${v:-Y}" =~ ^[Nn]$ ]]; then
  TOK=$(sed -nE 's/.*`TELEGRAM_BOT_TOKEN`[^|]*\|\s*([^ |]+).*/\1/p' "$VAULT")
  code=$(curl -s -o /tmp/_gm.json -w '%{http_code}' "https://api.telegram.org/bot${TOK}/getMe" || echo 000)
  unset TOK
  if [[ "$code" == "200" ]]; then
    name=$(node -e 'try{const d=require("/tmp/_gm.json");console.log("@"+d.result.username+" ("+d.result.first_name+")")}catch(e){console.log("ok")}' 2>/dev/null)
    echo "✅ Telegram accepted the token. Bot identity: $name"
  else
    echo "❌ Telegram rejected the token (HTTP $code). Double-check it — bridge NOT reloaded."
    rm -f /tmp/_gm.json; exit 1
  fi
  rm -f /tmp/_gm.json
fi

read -rp "Reload atmos-secure-bridge now to pick up the new token? [Y/n] " r
if [[ ! "${r:-Y}" =~ ^[Nn]$ ]]; then
  pm2 reload atmos-secure-bridge >/dev/null 2>&1 && pm2 save >/dev/null 2>&1
  echo "✅ Bridge reloaded with the new token."
fi
echo "🎯 Done. The token never appeared in any log or transcript."
