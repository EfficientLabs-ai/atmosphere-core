/**
 * /v1/messages route tests (Gap 6, #38; cost-scoping per Codex review of #45). Proves:
 *   1. /v1/messages carries NO cost gate — by design. It never does a paid BYOK passthrough (it proxies
 *      to the local Stratos agent / local-falls-back), so even a paid model under costApproval:'ask' must
 *      NOT be 402-blocked: it proceeds to proxy. (The cost gate lives only on /v1/chat/completions.)
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
  console.log('=== /v1/messages carries NO cost gate (it can\'t spend) — a paid model is NOT 402-blocked ===');
  // configure the agent in the STRICTEST gate mode (ask) + a paid backend present. On /v1/chat/completions
  // this would 402; on /v1/messages it must NOT, because this route never does a BYOK passthrough.
  config.markConfigured();
  config.setRouting({ saveApiSpend: false, costApproval: 'ask' });
  config.enableProvider('anthropic', 'cvault:anthropic:api-key:' + 'a'.repeat(32));

  const paid = await post({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'Write a full marketing plan.' }] });
  ok(paid.status !== 402, 'a paid model under ask-mode → NOT 402 (no cost gate on /v1/messages — no false block)');
  ok(paid.status === 502, '…it proceeds to proxy the local agent instead (502, upstream unreachable)');

  console.log('\n=== proxy path no longer ReferenceErrors (vars declared) → clean 502, not a crash ===');
  // switch off ask-mode so the gate passes through to the upstream proxy; upstream is unreachable.
  config.setRouting({ saveApiSpend: false, costApproval: 'always-spend' });
  const proxied = await post({ model: 'some-upstream-model', messages: [{ role: 'user', content: 'hi' }] });
  ok(proxied.status === 502, 'unreachable upstream + no local fallback → 502 Bad Gateway (route ran end-to-end, no ReferenceError)');

  console.log('\n=== route-scoping: the SAME paid model + ask-mode DOES 402 on /v1/chat/completions (the spend route) ===');
  // Proves the cost gate lives exactly where spend can happen — fires here, absent on /v1/messages above.
  config.setRouting({ saveApiSpend: false, costApproval: 'ask' });
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'Write a full marketing plan.' }] }),
  });
  ok(chat.status === 402, 'a paid model under ask-mode → 402 on /v1/chat/completions (gate present on the BYOK route)');
  const cbody = await chat.json();
  ok(cbody.error === 'approval_required' && typeof cbody.approvalToken === 'string' && cbody.approvalToken.length > 0, 'the 402 carries approval_required + a single-use approvalToken');

  console.log(`\n✅ ALL ${pass} /v1/messages + route-scoping checks passed.`);
} finally {
  server.close();
}
