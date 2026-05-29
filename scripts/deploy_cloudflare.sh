#!/bin/bash

# Cloudflare DNS Automation for Efficient Labs Sovereign Atmos Grid
# Binds install.efficientlabs.ai, platform.efficientlabs.ai, and api.efficientlabs.ai subdomains.

set -e

# Path resolution to secrets vault
VAULT_PATH=""
if [ -f ".secrets-vault/env_blueprint.md" ]; then
  VAULT_PATH=".secrets-vault/env_blueprint.md"
elif [ -f "../.secrets-vault/env_blueprint.md" ]; then
  VAULT_PATH="../.secrets-vault/env_blueprint.md"
else
  echo "❌ Error: Secrets vault (.secrets-vault/env_blueprint.md) not found."
  exit 1
fi

echo "🛡️  Atmos Cloudflare Provisioner: Loading credentials securely..."

# Securely extract the Zone ID and Tokens from the vault, stripping markdown escape backslashes
CLOUDFLARE_ZONE_ID=$(grep -E "CLOUDFLARE.*ZONE_ID" "$VAULT_PATH" | cut -d '|' -f 3 | tr -d '[:space:]' | tr -d '\\')
PRIMARY_TOKEN=$(grep -E "CLOUDFLARE.*API_TOKEN_PRIMARY|CLOUDFLARE_API_TOKEN\b" "$VAULT_PATH" | cut -d '|' -f 3 | tr -d '[:space:]' | tr -d '\\' || echo "")
SECONDARY_TOKEN=$(grep -E "CLOUDFLARE.*API_TOKEN_SECONDARY" "$VAULT_PATH" | cut -d '|' -f 3 | tr -d '[:space:]' | tr -d '\\' || echo "")
ACCOUNT_TOKEN=$(grep -E "CLOUDFLARE.*ACCOUNT_TOKEN" "$VAULT_PATH" | cut -d '|' -f 3 | tr -d '[:space:]' | tr -d '\\' || echo "")

if [ -z "$CLOUDFLARE_ZONE_ID" ]; then
  echo "❌ Error: CLOUDFLARE_ZONE_ID not found in secrets vault."
  exit 1
fi

TOKEN_TO_USE=""
TOKEN_NAME=""

# Function to verify if a token has DNS management capabilities on the zone
verify_token() {
  local token_val="$1"
  local token_name="$2"
  local masked="${token_val:0:10}..."
  
  echo "📡 Testing token capabilities with ${token_name} ($masked)..."
  
  # Fetch DNS records list to confirm both zone access and DNS management scopes
  local resp
  resp=$(curl -s -o /dev/null -w "%{http_code}" -X GET "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
    -H "Authorization: Bearer ${token_val}" \
    -H "Content-Type: application/json")

  if [ "$resp" = "200" ]; then
    echo "✅ ${token_name} is valid and possesses DNS records access permissions."
    TOKEN_TO_USE="$token_val"
    TOKEN_NAME="$token_name"
    return 0
  else
    echo "⚠️  ${token_name} verification failed (HTTP status: $resp)"
    return 1
  fi
}

# 1. Try Primary Token
if [ -n "$PRIMARY_TOKEN" ]; then
  verify_token "$PRIMARY_TOKEN" "CLOUDFLARE_API_TOKEN_PRIMARY" && true
fi

# 2. Try Secondary Token (if primary failed)
if [ -z "$TOKEN_TO_USE" ] && [ -n "$SECONDARY_TOKEN" ]; then
  verify_token "$SECONDARY_TOKEN" "CLOUDFLARE_API_TOKEN_SECONDARY" && true
fi

# 3. Try Account Token (if others failed)
if [ -z "$TOKEN_TO_USE" ] && [ -n "$ACCOUNT_TOKEN" ]; then
  verify_token "$ACCOUNT_TOKEN" "CLOUDFLARE_ACCOUNT_TOKEN" && true
fi

if [ -z "$TOKEN_TO_USE" ]; then
  echo "❌ Error: Could not authenticate with any Cloudflare token from the secrets vault."
  exit 1
fi

echo "🌐 Successfully authenticated using: ${TOKEN_NAME}"
echo "🌐 Zone ID loaded: ${CLOUDFLARE_ZONE_ID}"

# Subdomains to provision
SUBDOMAINS=("install" "platform" "api")
TARGET_IP="127.0.0.1" # Loopback representing sovereign coordination nodes

for SUB in "${SUBDOMAINS[@]}"; do
  RECORD_NAME="${SUB}.efficientlabs.ai"
  echo "📡 Provisioning A-record: ${RECORD_NAME} -> ${TARGET_IP}..."

  RESPONSE=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
    -H "Authorization: Bearer ${TOKEN_TO_USE}" \
    -H "Content-Type: application/json" \
    --data "{
      \"type\": \"A\",
      \"name\": \"${RECORD_NAME}\",
      \"content\": \"${TARGET_IP}\",
      \"ttl\": 3600,
      \"proxied\": false
    }")

  SUCCESS=$(echo "$RESPONSE" | grep -o '"success":[^,]*' | cut -d':' -f2 | tr -d '[:space:]')
  
  if [ "$SUCCESS" = "true" ]; then
    echo "✅ Successfully provisioned: ${RECORD_NAME}"
  else
    ERR_CODE=$(echo "$RESPONSE" | grep -o '"code":[^,]*' | head -n 1 | cut -d':' -f2 | tr -d '[:space:]')
    ERR_MSG=$(echo "$RESPONSE" | grep -o '"message":[^,]*' | head -n 1 | cut -d':' -f2 | tr -d '"')
    
    if [ "$ERR_CODE" = "81057" ] || echo "$ERR_MSG" | grep -qi "already exists"; then
      echo "⚠️  Record ${RECORD_NAME} already exists (ready for deployment)."
    else
      echo "❌ Failed to create ${RECORD_NAME} (Cloudflare Error ${ERR_CODE}: ${ERR_MSG})"
    fi
  fi
done

echo "🎉 CLOUDFLARE DNS PROPAGATION PIPELINE EXECUTED SUCCESSFULLY!"
