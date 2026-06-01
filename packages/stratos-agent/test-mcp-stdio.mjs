/**
 * mcp-stdio-transport round-trip against a real spawned MCP-style server. Proves: JSON-RPC framing
 * over stdio, and that connection auth is injected via ENV at spawn (not as a wire parameter).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStdioTransport } from './src/connectors/mcp-stdio-transport.js';
import { createMcpClient } from './src/connectors/mcp-client.js';

const server = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcpsrv-')), 'server.mjs');
fs.writeFileSync(server, `
let buf = '';
process.stdin.on('data', (c) => { buf += c.toString('utf8'); let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue; const req = JSON.parse(line); let result;
    if (req.method === 'initialize') result = { protocolVersion: '2024-11-05' };
    else if (req.method === 'tools/list') result = { tools: [{ name: 'whoami' }] };
    else if (req.method === 'tools/call') result = { content: 'token-tail=' + (process.env.MCP_AUTH_TOKEN || 'none').slice(-4) };
    else { process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, error:{code:-32601,message:'no method'} })+'\\n'); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result })+'\\n'); } });
`);

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const transport = createStdioTransport({ command: 'node', args: [server], auth: { kind: 'bearer', value: 'secret-tok-WXYZ' } });
const client = createMcpClient({ transport, name: 'mock' });
ok((await client.initialize()).protocolVersion === '2024-11-05', 'initialize round-trips over real stdio');
ok((await client.listTools())[0].name === 'whoami', 'tools/list round-trips');
ok((await client.callTool({ name: 'whoami', args: {} })).content === 'token-tail=WXYZ', 'auth injected via ENV (server saw token tail), not via the wire');
transport.close();
fs.rmSync(path.dirname(server), { recursive: true, force: true });
console.log(`\n✅ ALL ${pass} stdio-transport checks passed.`);
