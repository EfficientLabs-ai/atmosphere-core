/**
 * /v1/messages route tests (Gap 6, #38). Proves two fixes:
 *   1. the cost/ToS compliance gate is now WIRED into /v1/messages (parity with /v1/chat/completions):
 *      a paid model under costApproval:'ask' → 402 approval_required + a single-use approvalToken.
 *   2. the upstream-proxy path no longer ReferenceErrors: response/controller/timeoutId/shouldFallback
 *      are declared, so an unreachable upstream cleanly returns 502 (not a 500 crash / hang).
 *
 * Boots the real express app on an ephemeral port (no full daemon). Config is isolated in a temp cwd.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fetch from 'node-fetch';

// isolate agent-config (resolves off cwd) + force the proxy branch (no local fallback) BEFORE import.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'v1msg-')));
process.env.LOCAL_FALLBACK_ENABLED = 'false';
process.env.SAVE_API_COST_ENABLED = 'false';
process.env.STRATOS_AGENT_URL = 'http://127.0.0.1:1';  // unreachable on purpose
process.env.STRATOS_TIMEOUT = '800';
process.env.ANTHROPIC_API_KEY = 'sk-ant-TESTKEY-not-real'; // makes the anthropic backend "configured" for the gate

const config = await import('../stratos-agent/src/core/agent-config.js');
const { app } = await import('./server.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

// boot on an ephemeral port
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const post = (body, headers = {}) => fetch(`${base}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

try {
  console.log('=== cost gate is WIRED into /v1/messages (was missing) ===');
  // configure the agent: ask-mode + anthropic enabled (paid backend)
  config.markConfigured();
  config.setRouting({ saveApiSpend: false, costApproval: 'ask' });
  config.enableProvider('anthropic', 'cvault:anthropic:api-key:' + 'a'.repeat(32));

  const paid = await post({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'Write a full marketing plan.' }] });
  ok(paid.status === 402, 'a paid model under ask-mode → 402 (the gate fires on /v1/messages now)');
  const body = await paid.json();
  ok(body.error === 'approval_required' && typeof body.approvalToken === 'string' && body.approvalToken.length > 0, 'the 402 carries approval_required + a single-use approvalToken');

  console.log('\n=== proxy path no longer ReferenceErrors (vars declared) → clean 502, not a crash ===');
  // switch off ask-mode so the gate passes through to the upstream proxy; upstream is unreachable.
  config.setRouting({ saveApiSpend: false, costApproval: 'always-spend' });
  const proxied = await post({ model: 'some-upstream-model', messages: [{ role: 'user', content: 'hi' }] });
  ok(proxied.status === 502, 'unreachable upstream + no local fallback → 502 Bad Gateway (route ran end-to-end, no ReferenceError)');

  console.log(`\n✅ ALL ${pass} /v1/messages route checks passed.`);
} finally {
  server.close();
}
