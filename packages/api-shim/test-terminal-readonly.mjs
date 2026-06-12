/**
 * test-terminal-readonly.mjs — Atmos Terminal slice 1 (READ-ONLY APIs). Hermetic: tmp roots,
 * injected pm2 log dir, ephemeral port, no live daemon, no network beyond loopback.
 *
 * Proves the deny-by-default jail (traversal, secret names, symlink escape), redaction on
 * reads AND log chunks, binary refusal, bounded reads, SSE log tail + append delivery, the
 * MEASURED-only metrics stream (no emulated hardware), receipt export verifying with the
 * PUBLIC key only, and the SSE client cap.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { createReadonlyRouter } from './src/terminal/readonly-api.js';
import { requireGatewaySecretStrict } from './src/gateway-auth.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'term-ro-'));
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`  ✓ ${name}`); pass++; });

console.log('terminal readonly API — jailed, redacted, bounded, measured\n');

// ── fixture world ────────────────────────────────────────────────────────────────────────────
const ROOT = tmp();
fs.mkdirSync(path.join(ROOT, 'sub'));
fs.writeFileSync(path.join(ROOT, 'hello.txt'), 'plain content line\n');
fs.writeFileSync(path.join(ROOT, 'leaky.txt'), 'an api key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA sits here\n');
fs.writeFileSync(path.join(ROOT, '.env'), 'SECRET=value\n');
fs.mkdirSync(path.join(ROOT, 'vault-stuff'));
fs.writeFileSync(path.join(ROOT, 'sub', 'node-keys.json'), '{"privateKey":"nope"}');
fs.writeFileSync(path.join(ROOT, 'binary.bin'), Buffer.from([1, 2, 0, 4]));
const OUTSIDE = tmp();
fs.writeFileSync(path.join(OUTSIDE, 'escape.txt'), 'outside the jail');
fs.symlinkSync(path.join(OUTSIDE, 'escape.txt'), path.join(ROOT, 'link-out.txt'));
fs.symlinkSync(path.join(ROOT, '.env'), path.join(ROOT, 'safe.txt')); // in-root ALIAS to a denied name
fs.mkdirSync(path.join(ROOT, '.stratos-profile', 'chat-memory'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.stratos-profile', 'chat-memory', 'conv.json'), '{"transcript":"private"}');

const LOGS = tmp();
const LOGFILE = path.join(LOGS, 'atmos-secure-bridge-out.log');
fs.writeFileSync(LOGFILE, 'boot line with token sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB end\n');

const PROFILE = tmp();

const app = express();
app.use('/term', createReadonlyRouter({ roots: { jail: ROOT }, pm2LogsDir: LOGS, profileDir: PROFILE, maxSseClients: 2, pollMs: 100 }));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}/term`;
const get = (p) => fetch(BASE + p);

// ── fs ───────────────────────────────────────────────────────────────────────────────────────
await ok('fs/roots lists only real roots', async () => {
  const r = await (await get('/fs/roots')).json();
  assert.deepStrictEqual(r.roots, ['jail']);
});

await ok('fs/tree lists a level; denied names are INVISIBLE', async () => {
  const r = await (await get('/fs/tree?root=jail&path=.')).json();
  const names = r.entries.map((e) => e.name);
  assert.ok(names.includes('hello.txt') && names.includes('sub'));
  assert.ok(!names.includes('.env'), '.env must be invisible');
  assert.ok(!names.includes('vault-stuff'), 'vault names must be invisible');
  assert.ok(!names.includes('.stratos-profile'), 'profile state must be invisible');
  assert.ok(!names.includes('link-out.txt') && !names.includes('safe.txt'), 'symlinks are omitted, never followed');
  const sub = await (await get('/fs/tree?root=jail&path=sub')).json();
  assert.ok(!sub.entries.some((e) => e.name === 'node-keys.json'), 'key files must be invisible');
});

await ok('fs/read returns content, redacts token shapes, refuses binary', async () => {
  const r = await (await get('/fs/read?root=jail&path=hello.txt')).json();
  assert.strictEqual(r.content, 'plain content line\n');
  const leaky = await (await get('/fs/read?root=jail&path=leaky.txt')).json();
  assert.ok(!leaky.content.includes('sk-ant-api03-AAAA'), 'token must be redacted');
  assert.ok(leaky.content.includes("«redacted-secret»"));
  assert.strictEqual((await get('/fs/read?root=jail&path=binary.bin')).status, 415);
});

await ok('jail: traversal, secret names, unknown root, symlink escape → 403', async () => {
  for (const q of [
    '/fs/read?root=jail&path=../escape.txt',
    '/fs/read?root=jail&path=sub/../../escape.txt',
    '/fs/read?root=jail&path=.env',
    '/fs/read?root=jail&path=sub/node-keys.json',
    '/fs/read?root=nope&path=hello.txt',
    '/fs/read?root=jail&path=link-out.txt',
    '/fs/read?root=jail&path=safe.txt',
    '/fs/read?root=jail&path=.stratos-profile/chat-memory/conv.json',
    '/fs/tree?root=jail&path=.stratos-profile',
    '/fs/tree?root=jail&path=vault-stuff',
  ]) assert.strictEqual((await get(q)).status, 403, q);
});

await ok('fs/read is bounded (maxBytes caps, hard ceiling holds)', async () => {
  fs.writeFileSync(path.join(ROOT, 'big.txt'), 'x'.repeat(8192));
  const r = await (await get('/fs/read?root=jail&path=big.txt&maxBytes=100')).json();
  assert.strictEqual(r.content.length, 100);
  assert.strictEqual(r.truncated, true);
});

// ── SSE helpers ──────────────────────────────────────────────────────────────────────────────
async function sseEvents(p, { events = 1, timeoutMs = 5000, between = null } = {}) {
  const res = await get(p);
  assert.strictEqual(res.status, 200, `SSE open ${p}`);
  const out = [];
  let buf = '';
  return await new Promise((resolve, reject) => {
    const to = setTimeout(() => { res.body.destroy(); reject(new Error(`SSE timeout after ${out.length} events`)); }, timeoutMs);
    res.body.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (ev && data) {
          out.push({ event: ev, data: JSON.parse(data) });
          if (out.length === 1 && between) between();
          if (out.length >= events) { clearTimeout(to); res.body.destroy(); resolve(out); }
        }
      }
    });
    res.body.on('error', () => { /* destroyed by us */ });
  });
}

await ok('logs/stream: redacted tail, then appended chunks arrive', async () => {
  const evs = await sseEvents('/logs/stream?app=atmos-secure-bridge&kind=out', {
    events: 2,
    between: () => fs.appendFileSync(LOGFILE, 'appended line sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCC tail\n'),
  });
  assert.strictEqual(evs[0].data.tail, true);
  assert.ok(!evs[0].data.chunk.includes('sk-ant-api03-BBBB'), 'tail must be redacted');
  assert.ok(evs[1].data.chunk.includes('appended line'));
  assert.ok(!evs[1].data.chunk.includes('sk-ant-api03-CCCC'), 'appended chunk must be redacted');
});

await ok('logs/stream input validation: bad app name 400, missing log 404', async () => {
  assert.strictEqual((await get('/logs/stream?app=../etc&kind=out')).status, 400);
  assert.strictEqual((await get('/logs/stream?app=ghost&kind=out')).status, 404);
  assert.strictEqual((await get('/logs/stream?app=atmos-secure-bridge&kind=evil')).status, 400);
});

await ok('metrics/stream: MEASURED facts only — no emulated hardware', async () => {
  const [ev] = await sseEvents('/metrics/stream');
  assert.strictEqual(ev.event, 'metrics');
  assert.ok(ev.data.host.cpus >= 1 && ev.data.host.mem_total > 0 && ev.data.process.rss > 0);
  const raw = JSON.stringify(ev.data).toLowerCase();
  for (const fake of ['gpu', 'virtual', 'h100']) assert.ok(!raw.includes(fake), `no emulated block: ${fake}`);
});

await ok('SSE client cap: third concurrent stream → 429', async () => {
  const a = await get('/metrics/stream'); const b = await get('/metrics/stream');
  try {
    assert.strictEqual(a.status, 200); assert.strictEqual(b.status, 200);
    assert.strictEqual((await get('/metrics/stream')).status, 429);
  } finally { a.body.destroy(); b.body.destroy(); }
  await new Promise((r) => setTimeout(r, 50)); // let close handlers release slots
});

// ── receipts ─────────────────────────────────────────────────────────────────────────────────
await ok('receipts/export: signed bundle verifies with the PUBLIC key only; no keys → 404', async () => {
  assert.strictEqual((await get('/receipts/export')).status, 404, 'no identity yet');
  const { generateHybridKeyPair } = await import('../stratos-agent/src/security/quantum-crypto.js');
  const { ReceiptLog, makeReceiptSigner, createReceipt, verifyBundle } = await import('../stratos-agent/src/ledger/capability-receipt.js');
  const { originId } = await import('../stratos-agent/src/memory/skill-seal.js');
  const kp = generateHybridKeyPair();
  const b64 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  fs.writeFileSync(path.join(PROFILE, 'node-keys.json'), JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) }));
  const nodeId = originId(kp.publicKey);
  const log = new ReceiptLog({ path: path.join(PROFILE, 'live-receipts.jsonl'), signer: makeReceiptSigner(kp.privateKey), nodeId });
  log.append(createReceipt({ actor_id: nodeId, action: 'inference', ref: 'test', cost_units: 1, node_id: nodeId }));
  log.append(createReceipt({ actor_id: nodeId, action: 'skill-run', ref: 'test2', cost_units: 2, node_id: nodeId }));
  const r = await get('/receipts/export');
  assert.strictEqual(r.status, 200);
  const bundle = await r.json();
  assert.strictEqual(bundle.receipts.length, 2);
  assert.ok(bundle.public_key, 'public key embedded');
  assert.ok(!JSON.stringify(bundle).includes(JSON.stringify(b64(kp.privateKey).ed25519Der)), 'private key NEVER leaves');
  const v = verifyBundle(bundle);
  assert.strictEqual(v.ok, true, 'bundle verifies standalone: ' + (v.reason || ''));
});

await ok('strict gateway auth: fail-CLOSED without a secret, origin-gated, 401 on mismatch — and EVERY denial persists', () => {
  const makeReq = (headers = {}) => { const l = {}; for (const [k, v] of Object.entries(headers)) l[k.toLowerCase()] = v; return { get: (h) => l[h.toLowerCase()] }; };
  const makeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = () => r; return r; };
  const run = (headers) => { const res = makeRes(); let nxt = false; requireGatewaySecretStrict(makeReq(headers), res, () => { nxt = true; }); return { nxt, status: res.statusCode }; };
  const saved = { sec: process.env.ATMOS_GATEWAY_SECRET, org: process.env.ATMOS_GATEWAY_ORIGINS, prof: process.env.STRATOS_PROFILE_DIR };
  const AUDIT_PROFILE = tmp();
  process.env.STRATOS_PROFILE_DIR = AUDIT_PROFILE; // denial-audit resolves the sink per call
  const sinkLines = () => {
    const f = path.join(AUDIT_PROFILE, 'denial-audit.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  try {
    delete process.env.ATMOS_GATEWAY_SECRET;
    delete process.env.ATMOS_GATEWAY_ORIGINS; // hermetic: an ambient allowlist must not flake the evil-origin check
    assert.strictEqual(run({}).status, 503, 'no secret configured → the surface is OFF');
    process.env.ATMOS_GATEWAY_SECRET = 'strict-test-secret';
    assert.strictEqual(run({}).status, 401, 'missing secret → 401');
    assert.strictEqual(run({ 'x-atmos-gateway': 'wrong' }).status, 401);
    assert.ok(run({ 'x-atmos-gateway': 'strict-test-secret' }).nxt, 'right secret → pass');
    assert.strictEqual(run({ 'x-atmos-gateway': 'strict-test-secret', origin: 'https://evil.example' }).status, 403, 'un-allowlisted browser origin → 403 even with the secret');
    process.env.ATMOS_GATEWAY_ORIGINS = 'https://app.example';
    assert.ok(run({ 'x-atmos-gateway': 'strict-test-secret', origin: 'https://app.example' }).nxt, 'allowlisted origin → pass');
    // the sibling-branch gap (caught live): strict denials MUST persist like legacy ones do
    const es = sinkLines().filter((e) => e.gate === 'gateway-auth-strict');
    assert.ok(es.length >= 4, `503 + 401s + 403 all recorded (got ${es.length})`);
    assert.ok(es.some((e) => /requires ATMOS_GATEWAY_SECRET/.test(e.reason)), '503 recorded');
    assert.ok(es.some((e) => /browser-origin/.test(e.reason)), 'origin 403 recorded');
    assert.ok(!JSON.stringify(es).includes('strict-test-secret'), 'the secret value never reaches the sink');
  } finally {
    if (saved.sec === undefined) delete process.env.ATMOS_GATEWAY_SECRET; else process.env.ATMOS_GATEWAY_SECRET = saved.sec;
    if (saved.org === undefined) delete process.env.ATMOS_GATEWAY_ORIGINS; else process.env.ATMOS_GATEWAY_ORIGINS = saved.org;
    if (saved.prof === undefined) delete process.env.STRATOS_PROFILE_DIR; else process.env.STRATOS_PROFILE_DIR = saved.prof;
  }
});

await ok('receipts/export is SEGMENT-AWARE: rotation never silently shrinks exported history', async () => {
  const { generateHybridKeyPair } = await import('../stratos-agent/src/security/quantum-crypto.js');
  const { ReceiptLog, makeReceiptSigner, createReceipt, verifyBundle } = await import('../stratos-agent/src/ledger/capability-receipt.js');
  const { originId } = await import('../stratos-agent/src/memory/skill-seal.js');
  const PROFILE2 = tmp();
  const kp = generateHybridKeyPair();
  const b64 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  fs.writeFileSync(path.join(PROFILE2, 'node-keys.json'), JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) }));
  const nodeId = originId(kp.publicKey);
  const log = new ReceiptLog({ path: path.join(PROFILE2, 'live-receipts.jsonl'), signer: makeReceiptSigner(kp.privateKey), nodeId, rotateMaxBytes: 2048 });
  for (let i = 0; i < 6; i++) log.append(createReceipt({ actor_id: nodeId, action: 'inference', ref: 'rot-' + i, cost_units: 1, node_id: nodeId }));
  const segs = fs.readdirSync(PROFILE2).filter((f) => f.endsWith('.segment'));
  assert.ok(segs.length >= 1, 'rotation actually happened (fixture sanity)');
  const app2 = express();
  app2.use('/term', createReadonlyRouter({ roots: { jail: ROOT }, pm2LogsDir: LOGS, profileDir: PROFILE2 }));
  const srv2 = app2.listen(0, '127.0.0.1');
  await new Promise((r) => srv2.once('listening', r));
  const r = await fetch(`http://127.0.0.1:${srv2.address().port}/term/receipts/export`);
  srv2.close();
  assert.strictEqual(r.status, 200);
  const bundle = await r.json();
  assert.strictEqual(bundle.receipts.length, 6, 'archived segment receipts included, not just the active file');
  const v = verifyBundle(bundle);
  assert.strictEqual(v.ok, true, 'full genesis-rooted history verifies: ' + (v.reason || ''));
});

server.close();
assert.strictEqual(pass, 12, `expected all 12 tests, got ${pass}`);
console.log(`\n✅ ${pass}/12 terminal-readonly tests passed — jailed, redacted, bounded, measured, fail-closed.`);
