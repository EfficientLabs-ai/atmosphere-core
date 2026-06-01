/**
 * out-of-process broker end-to-end: spawns the REAL broker child + a REAL mock MCP sidecar and proves
 * the model (parent) gets handles+results across a private pipe while the secret is resolved only in
 * the broker child. No named socket; cap token held by the client, never surfaced to the model.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBroker } from './src/connectors/broker-client.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const SENTINEL = 'ghp_PROC_SENTINEL_zzzzzzzzzzzzzzzzzzzzWXYZ';

// isolated vault dir; seed a secret IN the vault (the broker child will resolve it)
const VDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bproc-'));
process.env.STRATOS_VAULT_DIR = VDIR;
const vault = await import('./src/connectors/vault.js');
const handle = vault.putSecret({ connector: 'github', kind: 'oauth', value: SENTINEL });

// a real stdio MCP sidecar that echoes ONLY the tail of the token it was spawned with (proves the
// broker child injected the resolved secret as env — without ever revealing the full secret)
const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'bproc-srv-'));
const server = path.join(fix, 'server.mjs');
fs.writeFileSync(server, `
let buf=''; process.stdin.on('data',c=>{buf+=c;let nl;while((nl=buf.indexOf('\\n'))>=0){const l=buf.slice(0,nl).trim();buf=buf.slice(nl+1);if(!l)continue;const r=JSON.parse(l);let res;
if(r.method==='initialize')res={protocolVersion:'2024-11-05'};
else if(r.method==='tools/list')res={tools:[{name:'search_repos'}]};
else if(r.method==='tools/call')res={content:'ok tail='+(process.env.MCP_AUTH_TOKEN||'none').slice(-4)};
else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'no'}})+'\\n');continue;}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:res})+'\\n');}});
`);

// registry holds NO secrets — only the pinned sidecar command + the vault handle to resolve
const registryPath = path.join(fix, 'registry.json');
fs.writeFileSync(registryPath, JSON.stringify({
  tools: {
    'repo.search': { risk: 'read', connector: 'github', mcpName: 'search_repos' },
    'repo.delete': { risk: 'destructive', connector: 'github', mcpName: 'delete_repo', requiredScopes: ['repo.admin'] },
  },
  connectors: { github: { command: process.execPath, args: [server], credentialHandle: handle, authKind: 'bearer', authEnvVar: 'MCP_AUTH_TOKEN' } },
}));

console.log('=== out-of-process broker ===');
const broker = startBroker({ registryPath });
await broker.ready();
ok(true, 'broker child spawned + ready handshake received over the private pipe');

const list = await broker.listTools();
ok(list.ok && list.tools.length === 1 && list.tools[0].name === 'repo.search', 'listTools across processes → only the read tool (destructive hidden)');

const r = await broker.callTool({ name: 'repo.search', args: { q: 'sovereign' } });
ok(r.ok === true && r.untrusted === true, 'read call round-trips through the separate process (flagged untrusted)');
ok(String(r.content).includes('tail=WXYZ'), 'the broker CHILD resolved the secret + injected it into its sidecar (env), end-to-end');
ok(!JSON.stringify(r).includes(SENTINEL), 'the full secret NEVER crossed back to the parent/model');

const d = await broker.callTool({ name: 'repo.delete', args: { repo: 'x' } });
ok(d.ok === false, 'a destructive call with no human approval → denied across the process boundary');

// the model-facing client API does not expose the capability token at all
ok(!('capToken' in broker) && typeof broker.callTool === 'function', 'the cap token is held by the client and never surfaced to the model');

broker.close();
await new Promise((res) => setTimeout(res, 50));
fs.rmSync(VDIR, { recursive: true, force: true });
fs.rmSync(fix, { recursive: true, force: true });
console.log(`\n✅ ALL ${pass} out-of-process broker checks passed.`);
