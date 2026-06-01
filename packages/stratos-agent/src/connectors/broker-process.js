#!/usr/bin/env node
/**
 * broker-process.js — runs the connector broker in a SEPARATE process so the model/agent process never
 * holds the vault master key, decrypted secrets, or the approval ledger in its own heap (Task #12).
 *
 * Transport: newline-delimited JSON over THIS process's stdin/stdout — an inherited pipe from the
 * parent. There is NO named unix socket, so no other same-UID process can connect (Codex HIGH
 * peer-binding); the pipe itself is the capability, and the token dies when the pipe closes.
 *
 * For FULL OS isolation, deploy this under a DEDICATED UID that owns the vault files 0600 (the
 * split-user topology) so the agent's UID cannot read vault.json/master.key directly. The code runs the
 * same either way; the isolation strength is a deployment property, documented honestly.
 *
 * Registry (tools + connectors, NO secrets) comes from STRATOS_BROKER_REGISTRY (a JSON file path).
 * Each connector names a PINNED stdio MCP sidecar; the credential is resolved from the vault HERE and
 * injected as env at spawn — it never crosses back to the parent.
 *
 * NOTE: nothing may write to stdout except the line protocol below (no console.log) — stdout is the
 * control channel. Diagnostics go to stderr, which the parent inherits but never parses into results.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { createBroker } from './broker-core.js';
import { createMcpClient } from './mcp-client.js';
import { createStdioTransport } from './mcp-stdio-transport.js';

const registryPath = process.env.STRATOS_BROKER_REGISTRY;
let registry = { tools: {}, connectors: {} };
try { if (registryPath) registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
catch (e) { process.stderr.write(`broker: cannot read registry: ${e.message}\n`); process.exit(2); }

// per-connector pinned stdio MCP sidecar; auth resolved by broker-core is injected as env at spawn
function connect({ connector, auth }) {
  const c = registry.connectors[connector] || {};
  if (!c.command) throw new Error(`connector ${connector} has no pinned command`);
  const transport = createStdioTransport({
    command: c.command, args: c.args || [], env: c.env || {}, cwd: c.cwd,
    auth: auth ? { ...auth, envVar: c.authEnvVar || 'MCP_AUTH_TOKEN' } : null,
  });
  return createMcpClient({ transport, name: connector });
}

const broker = createBroker({ tools: registry.tools, connectors: registry.connectors, connect });

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
send({ ready: true, capToken: broker.capToken }); // first line: handshake to the parent over the private pipe

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let req; try { req = JSON.parse(line); } catch { return; }
  const { id, verb, payload } = req;
  let result;
  try {
    if (verb === 'listTools') result = broker.listTools(payload?.capToken);
    else if (verb === 'proposeWrite') result = broker.proposeWrite(payload || {});
    else if (verb === 'callTool') result = await broker.callTool(payload || {});
    else result = { ok: false, reason: `unknown verb: ${verb}` };
  } catch { result = { ok: false, reason: 'broker error' }; } // never leak internals to the model
  send({ id, result });
});
rl.on('close', () => process.exit(0)); // parent closed the pipe → capability ends with the process
