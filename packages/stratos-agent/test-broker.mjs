/**
 * broker + mcp-client tests: capability token, read-only subset, write→approval, secret isolation
 * (plaintext never returns to the model), no auto-chain, and JSON-RPC framing safety.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-'));
process.env.STRATOS_VAULT_DIR = VDIR;
const vault = await import('./src/connectors/vault.js');
const approvals = await import('./src/connectors/write-approval.js');
const { createBroker } = await import('./src/connectors/broker-core.js');
const { createMcpClient } = await import('./src/connectors/mcp-client.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const SENTINEL = 'ghp_BROKER_SENTINEL_aaaaaaaaaaaaaaaaaaaaaa';

// ---- mcp-client over a mock transport ----------------------------------------------------------
console.log('=== mcp-client JSON-RPC framing ===');
function mockTransport(handler) { return { send: async (req) => handler(req) }; }
const okClient = createMcpClient({ transport: mockTransport((req) => {
  if (req.method === 'initialize') return { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05' } };
  if (req.method === 'tools/list') return { jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'search' }] } };
  if (req.method === 'tools/call') return { jsonrpc: '2.0', id: req.id, result: { content: `result for ${req.params.name}` } };
  return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no method' } };
}) });
ok((await okClient.listTools())[0].name === 'search', 'listTools returns the server tool list (auto-initializes)');
ok((await okClient.callTool({ name: 'search', args: {} })).content === 'result for search', 'callTool returns content');
let threw = false; try { await createMcpClient({ transport: mockTransport((r) => ({ jsonrpc: '2.0', id: 999, result: {} })) }).initialize(); } catch { threw = true; }
ok(threw, 'a mismatched JSON-RPC response id throws (no response confusion)');
ok((() => { try { createMcpClient({}); return false; } catch { return true; } })(), 'a transport is required');

// ---- broker: setup -----------------------------------------------------------------------------
console.log('\n=== broker setup (real vault + real approval ledger) ===');
const handle = vault.putSecret({ connector: 'github', kind: 'oauth', value: SENTINEL });
let authSeenByTransport = null; // proves the broker injected the resolved secret at connect time
const connect = ({ connector, auth }) => {
  authSeenByTransport = auth; // the transport would put this on the pinned connection; we just record it
  return { callTool: async ({ name, args }) => ({ content: { tool: name, echoedArg: args.q ?? null } }) };
};
const broker = createBroker({
  tools: {
    'repo.search': { risk: 'read', connector: 'github', mcpName: 'search_repos', requiredScopes: [] },
    'repo.delete': { risk: 'destructive', connector: 'github', mcpName: 'delete_repo', requiredScopes: ['repo.admin'] },
    'web.fetch': { risk: 'read', connector: 'github', mcpName: 'fetch', allowDestinations: ['https://api.github.com'] },
    'web.open': { risk: 'read', connector: 'github', mcpName: 'open' }, // takes a url but NO allow-list
  },
  connectors: { github: { credentialHandle: handle, authKind: 'bearer' } },
  connect, resolveSecret: vault.resolveSecret, approvals,
});
const CAP = broker.capToken;

console.log('\n=== capability token gates every verb ===');
ok(broker.listTools('wrong-token').ok === false, 'listTools with a bad cap token → denied');
ok((await broker.callTool({ name: 'repo.search', args: {}, capToken: 'nope' })).ok === false, 'callTool with a bad cap token → denied');

console.log('\n=== read-only subset: the model never sees write/destructive tools ===');
const listed = broker.listTools(CAP);
const names = listed.tools.map((t) => t.name).sort();
ok(listed.ok === true && JSON.stringify(names) === JSON.stringify(['repo.search', 'web.fetch', 'web.open']), 'only read tools are advertised (destructive repo.delete is hidden)');

console.log('\n=== secret isolation: resolved internally, NEVER returned to the model ===');
const r1 = await broker.callTool({ name: 'repo.search', args: { q: 'sovereign' }, capToken: CAP });
ok(r1.ok === true && r1.untrusted === true, 'read call succeeds and is flagged untrusted (no auto-chain)');
ok(authSeenByTransport && authSeenByTransport.value === SENTINEL, 'the broker DID resolve + inject the real secret at the connection');
ok(!JSON.stringify(r1).includes(SENTINEL), 'the model-facing response contains NO plaintext secret');

console.log('\n=== destination control: SSRF / credential-redirect is blocked ===');
ok((await broker.callTool({ name: 'web.open', args: { url: 'https://attacker.evil/x' }, capToken: CAP })).ok === false, 'a url arg on an auth-bearing tool with NO allow-list → denied');
ok((await broker.callTool({ name: 'web.fetch', args: { url: 'https://attacker.evil/x' }, capToken: CAP })).ok === false, 'a url outside the tool allow-list → denied');
ok((await broker.callTool({ name: 'web.fetch', args: { url: 'http://169.254.169.254/latest/meta-data' }, capToken: CAP })).ok === false, 'a private/link-local destination → denied even if it were allow-listed');
ok((await broker.callTool({ name: 'web.fetch', args: { url: 'https://api.github.com/user' }, capToken: CAP })).ok === true, 'an allow-listed origin → permitted');

console.log('\n=== write path: broker DERIVES the grant; only a matching owner approval executes ===');
ok((await broker.callTool({ name: 'repo.delete', args: {}, capToken: CAP })).ok === false, 'destructive call with NO approval → denied');
// model proposes via the BROKER (supplies only name+args); broker fills connector/account/scopes itself
const pr = broker.proposeWrite({ name: 'repo.delete', args: { repo: 'x' }, capToken: CAP });
ok(pr.ok === true && pr.proposal.scopes.includes('repo.admin'), 'broker.proposeWrite derives the scopes from its registry (model cannot forge them)');
const chal = approvals.approvalChallenge(pr.proposal.id);
ok(chal.args && chal.args.repo === 'x', 'the owner challenge exposes the EXACT structured args, not just a truncated summary');
approvals.approve(pr.proposal.id, chal.nonce);
const good = await broker.callTool({ name: 'repo.delete', args: { repo: 'x' }, capToken: CAP, approvalId: pr.proposal.id });
ok(good.ok === true, 'destructive call WITH the matching owner-approved proposal → executes');
ok((await broker.callTool({ name: 'repo.delete', args: { repo: 'x' }, capToken: CAP, approvalId: pr.proposal.id })).ok === false, 'the same approval cannot be replayed (single-use)');

console.log('\n=== unknown tool ===');
ok((await broker.callTool({ name: 'nope.nope', args: {}, capToken: CAP })).ok === false, 'unknown tool → denied');

fs.rmSync(VDIR, { recursive: true, force: true });
console.log(`\n✅ ALL ${pass} broker + mcp-client checks passed.`);
