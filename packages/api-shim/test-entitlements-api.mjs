/**
 * test-entitlements-api.mjs — GET /entitlements (read surface over the offline verifier).
 * Asserts: no token → 200 Free floor; valid signed token → 200 token source; enforced:false on the
 * wire; and the route NEVER writes (read-only — the directory is byte-identical before/after a GET).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { generateHybridKeyPair } from '../stratos-agent/src/security/quantum-crypto.js';
import { createEntitlementsRouter } from './src/product/entitlements-api.js';
import { signEntitlement } from './src/product/entitlement-signer.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

const prov = generateHybridKeyPair();
const DAY = 86_400_000;

// Mount the router on a throwaway server pointed at a temp profile dir (no auth = PASSTHROUGH).
function serve(tokenPath) {
  const app = express();
  app.use(createEntitlementsRouter({ entitlementOpts: { tokenPath, provisioningPublicKey: prov.publicKey, now: Date.now } }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}/entitlements`, close: () => server.close() });
    });
  });
}

function snapshotDir(dir) {
  if (!fs.existsSync(dir)) return '(absent)';
  return fs.readdirSync(dir).sort().map((f) => {
    const p = path.join(dir, f); const s = fs.statSync(p);
    return `${f}:${s.size}:${s.mtimeMs}`;
  }).join('|');
}

console.log('entitlements-api — GET /entitlements read surface\n');

// 1. NO TOKEN → Free floor, 200, enforced:false.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-api-'));
  const tokenPath = path.join(dir, 'entitlement.json');
  const { url, close } = await serve(tokenPath);
  const res = await fetch(url);
  const body = await res.json();
  close();
  ok(res.status === 200, `no token → HTTP 200 (got ${res.status})`);
  ok(body.format === 'efl.entitlement-resolution.v1', 'envelope format correct');
  ok(body.enforced === false, 'enforced:false on the wire (reports, does not gate)');
  ok(body.entitlement.source === 'free' && body.entitlement.tier === 'free_forever', 'no token → Free Forever');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. VALID SIGNED TOKEN → token source, tier carried; route does NOT write.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-api-'));
  const tokenPath = path.join(dir, 'entitlement.json');
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ['terminal.*'], expires_at: Date.now() + 30 * DAY }, prov.privateKey);
  fs.writeFileSync(tokenPath, JSON.stringify(token));
  const before = snapshotDir(dir);
  const { url, close } = await serve(tokenPath);
  const res = await fetch(url);
  const body = await res.json();
  await fetch(url); // a second GET — still must not mutate
  close();
  const after = snapshotDir(dir);
  ok(res.status === 200 && body.entitlement.source === 'token', "valid token → source:'token'");
  ok(body.entitlement.tier === 'apex' && body.entitlement.namespaces.includes('terminal.*'), 'tier + namespaces resolved');
  ok(before === after, 'read-only: directory byte-identical before/after GETs (no write-on-read)');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? '✖' : '✓'} entitlements-api: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
