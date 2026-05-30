#!/usr/bin/env node

/**
 * setup-agent.js: Interactive frictionless bootstrapper wizard
 * for first-time personal and corporate setup of Stratos Agent.
 * Configures default OpenAI/Ollama/custom LLM settings and Telegram integration.
 */

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const BANNER = `
🌌 \x1b[36m\x1b[1mSTRATOS AGENT WIZARD INSTALLER\x1b[0m
========================================================================
🚀 Welcome to the Frictionless Stratos Agent & P2P DePIN Setup Wizard!
🏢 Ready to provision your sovereign cognitive node for personal/business use.
========================================================================
`;

const config = {
  provider: 'openai',
  apiKey: '',
  ollamaHost: 'http://127.0.0.1:11434',
  telegramToken: '',
  enableP2p: 'true'
};

function askQuestion(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function runWizard() {
  console.log(BANNER);

  // 1. Choose Model Provider
  console.log('\n\x1b[33m[Step 1] Select your Default AI Inference Provider:\x1b[0m');
  console.log('  1) OpenAI models (Default - high intelligence, connects automatically)');
  console.log('  2) Anthropic Claude models');
  console.log('  3) OpenRouter endpoint (access to 200+ models)');
  console.log('  4) Ollama local quantized weights (100% private, offline)');
  console.log('  5) Custom endpoint / other LLM model');
  
  const providerChoice = await askQuestion('\n👉 Select choice (1-5, default is 1): ');
  
  if (providerChoice === '2') {
    config.provider = 'anthropic';
  } else if (providerChoice === '3') {
    config.provider = 'openrouter';
  } else if (providerChoice === '4') {
    config.provider = 'ollama';
  } else if (providerChoice === '5') {
    config.provider = 'custom';
  } else {
    config.provider = 'openai';
  }

  console.log(`\n✅ Provider selected: \x1b[32m${config.provider.toUpperCase()}\x1b[0m`);

  // 2. Request API coordinates
  if (config.provider === 'ollama') {
    const customHost = await askQuestion('👉 Enter local Ollama Host address (default is http://127.0.0.1:11434): ');
    if (customHost.trim()) {
      config.ollamaHost = customHost.trim();
    }
  } else {
    const key = await askQuestion(`👉 Enter your ${config.provider.toUpperCase()} API Key (leave empty to skip and configure later): `);
    if (key.trim()) {
      config.apiKey = key.trim();
    }
  }

  // 3. Configure Telegram Bot Bridge
  console.log('\n\x1b[33m[Step 2] Configure Telegram Gateway Integration:\x1b[0m');
  console.log('Connecting your Stratos Agent to your custom Telegram bot enables mobile interaction and hearing/vision triggers.');
  
  const tgToken = await askQuestion('\n👉 Enter your TELEGRAM_BOT_TOKEN (leave empty to skip or run in dry-run mode): ');
  if (tgToken.trim()) {
    config.telegramToken = tgToken.trim();
  }

  // 4. Configure P2P Swarming
  console.log('\n\x1b[33m[Step 3] Enable Decentralized P2P DHT Swarming:\x1b[0m');
  const p2pChoice = await askQuestion('👉 Enable serverless swarming & Autobase replication? (y/n, default is y): ');
  if (p2pChoice.toLowerCase() === 'n') {
    config.enableP2p = 'false';
  }

  // 5. Generate secure config environments
  console.log('\n\x1b[33m[Step 4] Compiling secure node configurations...\x1b[0m');

  const envContent = `# Stratos Agent Sovereign Environment configurations
# Generated dynamically by Wizard Setup

PORT=4000
BIND_ADDRESS=127.0.0.1
NODE_ENV=production

# Inference Coordinates
STRATOS_MODEL_PROVIDER=${config.provider}
OPENAI_API_KEY=${config.apiKey}
OLLAMA_HOST=${config.ollamaHost}

# Telegram Gateway
TELEGRAM_BOT_TOKEN=${config.telegramToken}

# P2P swarming specifications
STRATOS_ENABLE_P2P=${config.enableP2p}
STRATOS_PQC_MODE=ML-KEM-768
X402_SOLANA_TREASURY=6GH6mS462pJ1ys286shV8dyka29DCwNZKACETBPRj27x
`;

  // Write to .env and local configurations
  const envPath = path.resolve('.env');
  const envLocalPath = path.resolve('.env.local');
  const vaultDir = path.resolve('.secrets-vault');
  
  fs.writeFileSync(envPath, envContent, 'utf8');
  fs.writeFileSync(envLocalPath, envContent, 'utf8');

  // Also write to .secrets-vault if folder exists
  if (fs.existsSync(vaultDir)) {
    const envBlueprintPath = path.join(vaultDir, 'env_blueprint.md');
    const vaultContent = `| Variable Name | Value |
| --- | --- |
| \`TELEGRAM_BOT_TOKEN\` | ${config.telegramToken || 'PASTE_TOKEN_HERE'} |
| \`OPENAI_API_KEY\` | ${config.apiKey || 'PASTE_KEY_HERE'} |
`;
    fs.writeFileSync(envBlueprintPath, vaultContent, 'utf8');
  }

  console.log(`\n\x1b[32m✅ Successfully written environment coordinates to ${path.basename(envPath)}\x1b[0m`);
  console.log(`\x1b[32m✅ Successfully written localized settings to ${path.basename(envLocalPath)}\x1b[0m`);

  console.log('\n========================================================================');
  console.log('🎉 STRATOS AGENT WIZARD SETUP COMPLETED SUCCESSFULLY! 🎉');
  console.log('========================================================================');
  console.log('Your sovereign cognitive node is now fully configured.');
  console.log('\nTo manage and start your node cluster:');
  console.log('  1) Start intercept bridge: \x1b[36mnpm run start --workspace=packages/api-shim\x1b[0m');
  console.log('  2) Open node CLI dashboard: \x1b[36mnode packages/stratos-agent/stratos-ctl.js status\x1b[0m');
  console.log('========================================================================\n');

  rl.close();
}

runWizard();
