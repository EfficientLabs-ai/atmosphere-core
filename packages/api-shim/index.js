#!/usr/bin/env node

/**
 * Main Entry Point for the Atmos Sovereign API Gateway.
 *
 * This is a LOCAL gateway for the user's OWN outbound model traffic: clients point at 127.0.0.1, the
 * gateway classifies each request and routes it — simple/automatable work to local open-weight models
 * (saving unnecessary API spend), heavier work passed through to the user's OWN cloud key (BYOK). It does
 * NOT intercept, scrape, or automate any third-party subscription — that ToS/CFAA-risk path is out of
 * scope (GROUNDED_STRATEGY §6). The old "API Interception" naming wrongly implied otherwise.
 */

import { startServer } from './server.js';
import { TelegramBridge } from './src/telegram-bridge.js';
import { DiscordAdapter } from './src/omni-gateway/discord-adapter.js';
import { startLearnScheduler, isEnabled as evolutionEnabled } from './src/self-evolution-runtime.js';

console.log('⚡ Initializing Atmos API Shim Layer...');

const server = startServer();

// Instantiate and start the Telegram Bridge daemon
const telegramBridge = new TelegramBridge();
telegramBridge.start();

// Discord channel — starts only if DISCORD_BOT_TOKEN is present (resolved from the vault at boot),
// otherwise it's a safe no-op. Owner-gated by DISCORD_OWNER_ID.
const discord = new DiscordAdapter();
discord.start().catch((e) => console.warn('⚠️  [Discord] failed to start:', e.message));

// Hook B (LEARN — flag-gated, default OFF): start the nightly self-evolution compiler that
// harvests successful traces → induces specs → compiles + PQC-signs executing wasm skills.
// Inert unless STRATOS_EVOLUTION=1 is set; a reload without that flag changes nothing.
if (evolutionEnabled()) {
  startLearnScheduler();
}

// Handle graceful shutdown procedures
const shutdown = (signal) => {
  console.log(`\n🛑 Received ${signal}. Shutting down Atmos API Shim gracefully...`);
  
  if (telegramBridge) {
    telegramBridge.stop();
  }
  if (discord) {
    discord.stop();
  }

  server.close(() => {
    console.log('💤 Server connection pool closed. Exiting process safely.\n');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

