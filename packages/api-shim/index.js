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
import { startLearnScheduler, isEnabled as evolutionEnabled } from './src/self-evolution-runtime.js';

console.log('⚡ Initializing Atmos API Shim Layer...');

const server = startServer();

// Instantiate and start the Telegram Bridge daemon
const telegramBridge = new TelegramBridge();
telegramBridge.start();

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
  
  server.close(() => {
    console.log('💤 Server connection pool closed. Exiting process safely.\n');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

