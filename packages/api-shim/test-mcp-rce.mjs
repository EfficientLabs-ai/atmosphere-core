/**
 * /mcp RCE regression test (Gap 2, #34). Before the fix, `stratos_browser_execute` ran
 * `new Function(action)` on an attacker-supplied string from the UNAUTHENTICATED /mcp body, and the
 * mock browser harness executes it IN-PROCESS → arbitrary remote code execution on the host.
 *
 * This test boots the real app in-process and sends a malicious `action`. If the RCE path still
 * existed, the payload would set a global IN THIS PROCESS. We assert it never executes, and that the
 * (now safe) DSL path still handles a legitimate instruction.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fetch from 'node-fetch';

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rce-')));
const { app } = await import('./server.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const mcp = (body) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const call = (args) => mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stratos_browser_execute', arguments: args } });

try {
  console.log('=== a malicious `action` must NOT execute arbitrary code in-process ===');
  delete globalThis.__RCE_PROVEN__;
  const evil = "globalThis.__RCE_PROVEN__ = 'pwned'; return 1;";
  const r = await call({ action: evil });
  ok(r.status === 200, 'the request is handled (no crash)');
  ok(globalThis.__RCE_PROVEN__ === undefined, 'the payload NEVER executed — global is unset (RCE path is gone)');
  const body = await r.json();
  ok(body.result && Array.isArray(body.result.content), 'response is a normal MCP result (action routed through the safe DSL, not eval)');

  console.log('\n=== a second payload attempting process tampering is also inert ===');
  delete globalThis.__RCE2__;
  await call({ action: "globalThis.__RCE2__ = process.pid" });
  ok(globalThis.__RCE2__ === undefined, 'no access to process/globals — payload inert');

  console.log('\n=== the safe DSL path still works (navigate instruction → logs) ===');
  const ok2 = await call({ prompt: 'navigate to https://example.com' });
  const b2 = await ok2.json();
  const text = b2?.result?.content?.[0]?.text || '';
  ok(/Executing prompt|Navigating to https:\/\/example\.com/.test(text), 'a legitimate navigate instruction is parsed + logged by the safe DSL');

  console.log(`\n✅ ALL ${pass} /mcp RCE-regression checks passed.`);
} finally {
  server.close();
}
