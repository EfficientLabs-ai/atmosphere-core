/**
 * test-check-carve-sync.mjs — hermetic test for the carve-sync drift gate (#75/#76).
 * The fetcher is INJECTED — no network. Covers: in-sync passes; drift fails; unreachable
 * mirror skips by default but fails in strict mode; mixed drift+unreachable still fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCarveSync } from './check-carve-sync.mjs';

// A fake repo root with a canonical file.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carve-'));
fs.mkdirSync(path.join(root, 'sec'), { recursive: true });
const CANON = 'export const ALGO = "ml-dsa-65";\n';
fs.writeFileSync(path.join(root, 'sec/crypto.js'), CANON);

const carves = [{ name: 'crypto', canonical: 'sec/crypto.js', mirrors: ['https://m1/x.js', 'https://m2/y.js'] }];
const fetcherFrom = (map) => async (url) => {
  if (map[url] instanceof Error) throw map[url];
  return Buffer.from(map[url]);
};

// 1. Both mirrors identical → ok.
let r = await runCarveSync({ carves, root, fetcher: fetcherFrom({ 'https://m1/x.js': CANON, 'https://m2/y.js': CANON }) });
assert.equal(r.ok, true); assert.equal(r.drift, false);
assert.deepEqual(r.results.map((x) => x.match), [true, true]);

// 2. One mirror drifted → drift, NOT ok.
r = await runCarveSync({ carves, root, fetcher: fetcherFrom({ 'https://m1/x.js': CANON, 'https://m2/y.js': CANON + '// backdoor\n' }) });
assert.equal(r.ok, false); assert.equal(r.drift, true);
assert.equal(r.results[1].match, false);
assert.notEqual(r.results[1].mirrorHash, r.results[1].canonicalHash);

// 3. Unreachable mirror → skip (ok) by default…
r = await runCarveSync({ carves, root, strict: false, fetcher: fetcherFrom({ 'https://m1/x.js': CANON, 'https://m2/y.js': new Error('ENOTFOUND') }) });
assert.equal(r.ok, true); assert.equal(r.unreachable, true);
assert.equal(r.results[1].match, null);

// 4. …but FAILS in strict mode (CI).
r = await runCarveSync({ carves, root, strict: true, fetcher: fetcherFrom({ 'https://m1/x.js': CANON, 'https://m2/y.js': new Error('ENOTFOUND') }) });
assert.equal(r.ok, false);

// 5. Drift + unreachable → fails regardless.
r = await runCarveSync({ carves, root, strict: false, fetcher: fetcherFrom({ 'https://m1/x.js': CANON + 'x', 'https://m2/y.js': new Error('boom') }) });
assert.equal(r.ok, false); assert.equal(r.drift, true);

fs.rmSync(root, { recursive: true, force: true });
console.log('  ✓ carve-sync gate: in-sync passes, drift fails, unreachable skips (default) / fails (strict)');
