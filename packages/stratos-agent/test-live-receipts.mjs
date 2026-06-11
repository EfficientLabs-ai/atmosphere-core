/**
 * test-live-receipts.mjs — SPRINT_002 #2: the LIVE tap must mint signed receipts BY DEFAULT
 * (no injection) into STRATOS_RECEIPTS, and stay fail-open. Regression gate for the
 * adversarial-audit bottleneck #2 (trust_events=0 on the daemon).
 *
 * Hermetic. The scenario runs in a SUPERVISED CHILD process (temp profile, 60s cap): a module in
 * the deep import chain can hold an fd open after success, so the child asserts + exits explicitly
 * and the parent enforces the timeout — the assertions are the contract, the child exit code the verdict.
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CHILD = `
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'livereceipt-'));
process.env.STRATOS_OPERATING_CORE = '1';
process.env.STRATOS_PROFILE_DIR = path.join(tmp, 'p');
process.env.STRATOS_RECEIPTS = path.join(tmp, 'p', 'live-receipts.jsonl');
process.env.STRATOS_WORKSPACES_DIR = path.join(tmp, 'ws');
fs.mkdirSync(process.env.STRATOS_PROFILE_DIR, { recursive: true });
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

const { observe, _resetTapReceiptLog } = await import(${JSON.stringify(path.join(HERE, 'src/operating/operating-tap.js'))});
const led = await import(${JSON.stringify(path.join(HERE, 'src/ledger/capability-receipt.js'))});

// 1. Daemon-shaped call, NOTHING injected → result untouched + signed receipt on disk.
const out = await observe({ meta: { source: 'api', intent: 'question', raw: 'double of 8?', tool: 'route', model_used: 'gemma2:2b' }, exec: async () => '16' });
if (out !== '16') fail('observe altered the exec result');
const rp = process.env.STRATOS_RECEIPTS;
if (!fs.existsSync(rp)) fail('no live receipt file at ' + rp);
const n1 = fs.readFileSync(rp, 'utf8').split('\\n').filter(Boolean).length;
if (n1 < 1) fail('no receipt line');

// 2. Verifies with the PUBLIC key only (revive the persisted bundle the tap wrote).
const raw = JSON.parse(fs.readFileSync(path.join(process.env.STRATOS_PROFILE_DIR, 'node-keys.json'), 'utf8'));
const pub = Object.fromEntries(Object.entries(raw.publicKey).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
const v = new led.ReceiptLog({ path: rp, verifier: led.makeReceiptVerifier(pub) }).verify();
if (!v.ok) fail('receipts must verify with public key only: ' + JSON.stringify(v));

// 3. Second call appends; chain still verifies.
await observe({ meta: { source: 'api', intent: 'question', raw: 'of 9?' }, exec: async () => '18' });
const n2 = fs.readFileSync(rp, 'utf8').split('\\n').filter(Boolean).length;
if (n2 <= n1) fail('second observe did not append');
if (!new led.ReceiptLog({ path: rp, verifier: led.makeReceiptVerifier(pub) }).verify().ok) fail('chain broke');

// 4. Fail-open: unwritable receipt path NEVER affects the exec result.
// The unwritable path is a FILE used as a directory (ENOTDIR) — it fails FAST and portably.
// (The previous choice, a path under /proc, exposed a kernel quirk: mkdir on procfs can BLOCK in
// uninterruptible sleep instead of returning EPERM — hidepid procfs mounts do this — which starved
// the child's event loop forever and made this test "hang". Root-caused 2026-06-11.)
_resetTapReceiptLog();
const blocker = path.join(tmp, 'blocker');
fs.writeFileSync(blocker, 'a file, not a directory');
process.env.STRATOS_RECEIPTS = path.join(blocker, 'sub', 'r.jsonl');
const out2 = await observe({ meta: { source: 'api', intent: 'question', raw: 'x' }, exec: async () => 'ok' });
if (out2 !== 'ok') fail('fail-open violated');

// 5. Fail-VISIBLE: the swallowed failure left a countable trace in the profile sidecar (P1).
const sidecar = path.join(process.env.STRATOS_PROFILE_DIR, 'tap-failures.jsonl');
if (!fs.existsSync(sidecar)) fail('no tap-failures.jsonl — fail-open became fail-invisible');
const failures = fs.readFileSync(sidecar, 'utf8').split('\\n').filter(Boolean).map(JSON.parse);
if (!failures.some((f) => f.stage && f.error)) fail('sidecar entry malformed: ' + JSON.stringify(failures));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('CHILD-OK');
process.exit(0);
`;

const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { encoding: 'utf8', timeout: 60000, cwd: HERE });
assert.equal(r.signal, null, `child timed out/killed (${r.signal}) — stderr: ${(r.stderr || '').slice(-300)}`);
assert.equal(r.status, 0, `child failed — ${(r.stderr || r.stdout || '').slice(-300)}`);
assert.ok(/CHILD-OK/.test(r.stdout), 'child did not reach success marker');
console.log('  ✓ live receipts: default tap mints signed, public-key-verifiable, appending receipts; fail-open proven (supervised child)');
