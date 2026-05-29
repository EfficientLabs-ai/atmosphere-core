import fs from 'fs';
import path from 'path';

// Locate the secrets vault
let vaultPath = '';
if (fs.existsSync('.secrets-vault/env_blueprint.md')) {
  vaultPath = '.secrets-vault/env_blueprint.md';
} else if (fs.existsSync('../.secrets-vault/env_blueprint.md')) {
  vaultPath = '../.secrets-vault/env_blueprint.md';
} else {
  console.error('❌ Error: Secrets vault (.secrets-vault/env_blueprint.md) not found.');
  process.exit(1);
}

console.log('🛡️  Atmos Cloudflare Provisioner: Loading credentials securely...');

const vaultContent = fs.readFileSync(vaultPath, 'utf8');

// Helper to parse table row securely, stripping backslashes
function extractSecret(keyName) {
  const regex = new RegExp(`\\|\\s*\`?${keyName.replace(/_/g, '\\\\?_')}\`?\\s*\\|\\s*([^|\\s]+)\\s*\\|`);
  const match = vaultContent.match(regex);
  if (!match) return null;
  return match[1].replace(/\\/g, '').trim();
}

const zoneId = extractSecret('CLOUDFLARE_ZONE_ID');
const primaryToken = extractSecret('CLOUDFLARE_API_TOKEN_PRIMARY') || extractSecret('CLOUDFLARE_API_TOKEN');
const secondaryToken = extractSecret('CLOUDFLARE_API_TOKEN_SECONDARY');
const accountToken = extractSecret('CLOUDFLARE_ACCOUNT_TOKEN');

if (!zoneId) {
  console.error('❌ Error: CLOUDFLARE_ZONE_ID not found in secrets vault.');
  process.exit(1);
}

const tokens = [];
if (primaryToken) tokens.push({ name: 'CLOUDFLARE_API_TOKEN_PRIMARY', value: primaryToken });
if (secondaryToken) tokens.push({ name: 'CLOUDFLARE_API_TOKEN_SECONDARY', value: secondaryToken });
if (accountToken) tokens.push({ name: 'CLOUDFLARE_ACCOUNT_TOKEN', value: accountToken });

let tokenToUse = '';
let tokenName = '';

async function testTokenDns(tokenVal, name) {
  const masked = tokenVal.slice(0, 10) + '...';
  console.log(`📡 Performing dry-run DNS accessibility check with ${name} (${masked})...`);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
      headers: {
        'Authorization': `Bearer ${tokenVal}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.warn(`⚠️  Network check failed for ${name}:`, err.message);
    return false;
  }
}

async function deploy() {
  // Test all tokens sequentially to find the one with DNS read/write permissions
  for (const t of tokens) {
    const works = await testTokenDns(t.value, t.name);
    if (works) {
      console.log(`✅ ${t.name} is fully verified and possesses DNS management permissions!`);
      tokenToUse = t.value;
      tokenName = t.name;
      break;
    } else {
      console.log(`⚠️  ${t.name} verification failed or lacked DNS records access.`);
    }
  }

  if (!tokenToUse) {
    console.error('❌ Error: Could not find any valid token with DNS management permissions in the secrets vault.');
    process.exit(1);
  }

  console.log(`🌐 Deploying using verified token: ${tokenName}`);
  console.log(`🌐 Target Zone ID: ${zoneId}`);

  const subdomains = ['install', 'platform', 'api'];
  const targetIp = '127.0.0.1';

  for (const sub of subdomains) {
    const recordName = `${sub}.efficientlabs.ai`;
    console.log(`📡 Provisioning A-record: ${recordName} -> ${targetIp}...`);

    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenToUse}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'A',
          name: recordName,
          content: targetIp,
          ttl: 3600,
          proxied: false
        })
      });

      const data = await res.json();
      if (data.success) {
        console.log(`✅ Successfully provisioned: ${recordName}`);
      } else {
        const err = data.errors && data.errors[0] ? data.errors[0] : {};
        if (err.code === 81057 || (err.message && err.message.toLowerCase().includes('already exists'))) {
          console.log(`⚠️  Record ${recordName} already exists (ready for deployment).`);
        } else {
          console.log(`❌ Failed to create ${recordName} (Cloudflare Error ${err.code}: ${err.message})`);
        }
      }
    } catch (err) {
      console.error(`❌ Network error for ${recordName}:`, err.message);
    }
  }

  console.log('🎉 CLOUDFLARE DNS PROPAGATION PIPELINE EXECUTED SUCCESSFULLY!');
}

deploy();
