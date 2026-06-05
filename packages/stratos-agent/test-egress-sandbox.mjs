// test-egress-sandbox.mjs — the WASI sandbox's egress firewall is REAL (not the old bare-`*` stub),
// composes with skill net-caps, defaults to DENY, and the env passthrough is allowlisted (no wholesale
// caller-env forwarding). Hermetic: no real wasm guest needed — we exercise the same composed check the
// in-guest network shim calls (sandbox.assertEgressAllowed) plus the constructor wiring.
import assert from 'node:assert';
import { WasiSandbox } from './src/execution/wasi-sandbox.js';
import { EgressPolicy, EgressDenied } from './src/security/egress-policy.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const denied = (fn) => { try { fn(); return false; } catch (e) { return e instanceof EgressDenied; } };

console.log('egress-sandbox — real egress check, caps∩policy, deny-by-default, env allowlist\n');

// ── default: a sandbox with no policy + no caps lets NOTHING out (safe, backward-compatible) ──────
ok('default sandbox (no policy, no caps) ⇒ egress DENIED', () => {
  const sb = new WasiSandbox({ verbose: false });
  assert.strictEqual(denied(() => sb.assertEgressAllowed({ host: 'github.com' })), true);
});

// ── policy alone is not enough — caps must also permit the host (intersection) ────────────────────
ok('policy allows host but skill declared no net caps ⇒ DENY (intersection)', () => {
  const sb = new WasiSandbox({
    verbose: false,
    egressPolicySource: { default: 'deny', allow: [{ host: 'api.github.com' }] },
    // no caps ⇒ caps.net defaults to []
  });
  assert.strictEqual(denied(() => sb.assertEgressAllowed({ host: 'api.github.com' })), true);
});

ok('host in BOTH policy AND caps ⇒ ALLOW', () => {
  const sb = new WasiSandbox({
    verbose: false,
    egressPolicySource: { default: 'deny', allow: [{ host: 'api.github.com' }] },
    caps: { net: ['api.github.com'] },
  });
  const rule = sb.assertEgressAllowed({ host: 'api.github.com' });
  assert.strictEqual(rule.host, 'api.github.com');
});

ok('caps allow host but policy does not ⇒ DENY', () => {
  const sb = new WasiSandbox({
    verbose: false,
    egressPolicySource: { default: 'deny', allow: [{ host: 'api.github.com' }] },
    caps: { net: ['evil.com'] },
  });
  assert.strictEqual(denied(() => sb.assertEgressAllowed({ host: 'evil.com' })), true);
});

// ── spoofing is rejected at the sandbox boundary too ──────────────────────────────────────────────
ok('suffix spoof (evil-github.com) DENIED at the sandbox', () => {
  const sb = new WasiSandbox({
    verbose: false,
    egressPolicySource: { default: 'deny', allow: [{ host: '.github.com' }] },
    caps: { net: ['evil-github.com'] },
  });
  assert.strictEqual(denied(() => sb.assertEgressAllowed({ host: 'evil-github.com' })), true);
});

// ── accepts an EgressPolicy instance (hot-reloadable) ─────────────────────────────────────────────
ok('sandbox accepts a shared EgressPolicy instance', () => {
  const ep = new EgressPolicy({ source: { default: 'deny', allow: [{ host: 'api.x.com' }] } });
  const sb = new WasiSandbox({ verbose: false, egressPolicy: ep, caps: { net: ['api.x.com'] } });
  assert.ok(sb.assertEgressAllowed({ host: 'api.x.com' }));
});

// ── env discipline: only allowlisted keys pass to the guest (no wholesale caller-env forwarding) ──
// buildPreopens/execute use this.allowedEnvKeys; verify the allowlist set is constructed deny-by-default.
ok('env passthrough is an explicit allowlist (deny-by-default)', () => {
  const sb = new WasiSandbox({ verbose: false, allowedEnvKeys: ['SAFE_FLAG'] });
  assert.ok(sb.allowedEnvKeys.has('SAFE_FLAG'));
  assert.strictEqual(sb.allowedEnvKeys.has('OPENAI_API_KEY'), false);   // secrets never auto-forwarded
  assert.strictEqual(sb.allowedEnvKeys.has('SOLANA_KEYPAIR'), false);
  const bare = new WasiSandbox({ verbose: false });
  assert.strictEqual(bare.allowedEnvKeys.size, 0);                      // nothing forwarded by default
});

// ── the in-guest shim semantics: reads the host out of guest memory, returns 1=ALLOW / 0=DENY ──────
// We reproduce EXACTLY the shim the sandbox installs (readGuestString + composed assertEgressAllowed →
// 1/0, fail-closed) over a real WebAssembly.Memory holding a host string, proving the guest-memory read
// path and the allow/deny mapping. (The sandbox's execute() WASI path needs a full `_start` guest; this
// targets the network-permission contract precisely and hermetically.)
ok('guest-memory host read → ALLOW(1) for a permitted host, DENY(0) otherwise', () => {
  const sb = new WasiSandbox({
    verbose: false,
    egressPolicySource: { default: 'deny', allow: [{ host: 'api.github.com' }] },
    caps: { net: ['api.github.com'] },
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const writeHost = (s, at = 16) => {
    const bytes = Buffer.from(s, 'utf8');
    new Uint8Array(memory.buffer, at, bytes.length).set(bytes);
    return { ptr: at, len: bytes.length };
  };
  // Build the same shim the sandbox installs, bound to this memory + the sandbox's composed check.
  const readGuestString = (ptr, len) => {
    if (!Number.isInteger(ptr) || !Number.isInteger(len) || len < 0) return null;
    try { return Buffer.from(new Uint8Array(memory.buffer, ptr, len)).toString('utf8'); } catch { return null; }
  };
  const shim = (hostPtr, hostLen) => {
    const host = readGuestString(hostPtr, hostLen);
    if (host == null) return 0;
    try { sb.assertEgressAllowed({ host }); return 1; } catch { return 0; }
  };

  const a = writeHost('api.github.com', 16);
  assert.strictEqual(shim(a.ptr, a.len), 1, 'permitted host ⇒ ALLOW(1)');
  const b = writeHost('evil.com', 64);
  assert.strictEqual(shim(b.ptr, b.len), 0, 'unlisted host ⇒ DENY(0)');
  assert.strictEqual(shim(0, 0), 0, 'unreadable/empty host ⇒ DENY(0) fail-closed');
});

console.log(`\n${pass} assertions passed.`);
