#!/usr/bin/env node

/**
 * Main Entry Point for Atmos API Interception Bridge Daemon
 */

import { startServer } from './server.js';

console.log('⚡ Initializing Atmos API Shim Layer...');

const server = startServer();

// Handle graceful shutdown procedures
const shutdown = (signal) => {
  console.log(`\n🛑 Received ${signal}. Shutting down Atmos API Shim gracefully...`);
  server.close(() => {
    console.log('💤 Server connection pool closed. Exiting process safely.\n');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
