#!/usr/bin/env node

/**
 * Main Entry Point for Atmos API Interception Bridge Daemon
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

