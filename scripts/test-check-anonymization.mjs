/** Tests for the anonymization gate: the real org-flagship is clean; planted internals are caught. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { checkAnonymization } from './check-anonymization.mjs';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

console.log('=== real org-flagship content is clean ===');
const v = checkAnonymization(path.join(ROOT, 'org-flagship'));
ok(v.length === 0, `org-flagship has no internal terms / infra IPs / secrets (found ${v.length})`);

console.log('\n=== planted internals are caught ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-'));
fs.writeFileSync(path.join(tmp, 'a.md'), 'We run on the Solo-AI substrate via tailfcf499.ts.net at 100.83.59.73.');
fs.writeFileSync(path.join(tmp, 'b.md'), 'Local dev on 127.0.0.1 is fine. Brand: Efficient Labs / StratosAgent / The Atmosphere.');
fs.writeFileSync(path.join(tmp, 'c.json'), JSON.stringify({ key: 'sk-ant-api03-AAAABBBBCCCCDDDDEEEE' }));
const r = checkAnonymization(tmp);
ok(r.some((x) => /Solo-AI/.test(x)), 'flags internal upstream name');
ok(r.some((x) => /ts\.net|tailfcf/.test(x)), 'flags internal hostname');
ok(r.some((x) => /infra IP/.test(x)), 'flags Tailscale/CGNAT IP');
ok(r.some((x) => /secret-shaped/.test(x)), 'flags a planted key');
ok(!r.some((x) => /b\.md/.test(x)), 'allows localhost + public brand terms (no false positive on b.md)');
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n✅ ALL ${pass} anonymization checks passed.`);
